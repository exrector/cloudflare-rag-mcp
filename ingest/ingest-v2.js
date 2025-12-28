#!/usr/bin/env node
/**
 * RAG Ingest Script v2 - Правильная архитектура
 * - D1: полные чанки + метаданные
 * - Vectorize: векторы + легкие метаданные
 * - Workers AI: эмбеддинги
 */

import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

dotenv.config({ path: '../.env' });

const CONFIG = {
  github: {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || 'main'
  },
  cloudflare: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    databaseId: '3bc73c19-69ce-4940-b63b-6a2ca5cf5dfb',
    indexName: 'myrag-index',
    embeddingModel: '@cf/baai/bge-large-en-v1.5'
  },
  chunking: {
    chunkSize: 512,
    chunkOverlap: 50,
    minChunkSize: 1
  },
  supportedExtensions: ['.md', '.txt', '.mdx', '.rst'],
  excludedPaths: ['.git', '.github', 'node_modules', '.DS_Store'],
  excludedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.pdf']
};

const octokit = new Octokit({ auth: CONFIG.github.token });

// ===== GitHub Functions =====

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (CONFIG.supportedExtensions.includes(ext)) return true;
  if (CONFIG.excludedExtensions.includes(ext)) return false;

  if (!ext) {
    const fileName = path.basename(filePath);
    if (fileName.startsWith('.')) return false;
    if (CONFIG.excludedPaths.some(excluded => filePath.includes(excluded))) return false;
    return true;
  }

  return false;
}

async function getGitHubFiles() {
  console.log(`📥 Fetching files from ${CONFIG.github.repo}...`);
  const [owner, repo] = CONFIG.github.repo.split('/');

  const { data } = await octokit.git.getTree({
    owner, repo,
    tree_sha: CONFIG.github.branch,
    recursive: true
  });

  const files = data.tree.filter(item =>
    item.type === 'blob' && isTextFile(item.path)
  );

  console.log(`✅ Found ${files.length} supported files`);
  return files;
}

async function getFileContent(filePath) {
  const [owner, repo] = CONFIG.github.repo.split('/');
  const { data } = await octokit.repos.getContent({
    owner, repo,
    path: filePath,
    ref: CONFIG.github.branch
  });
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

// ===== Chunking Functions =====

function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function chunkText(text, metadata) {
  const chunks = [];
  const lines = text.split('\n');
  let currentChunk = '';
  let currentWords = 0;

  for (const line of lines) {
    const lineWords = countWords(line);

    if (currentWords + lineWords > CONFIG.chunking.chunkSize && currentWords > 0) {
      if (currentWords >= CONFIG.chunking.minChunkSize) {
        chunks.push({
          text: currentChunk.trim(),
          words: currentWords,
          metadata
        });
      }

      const overlapText = currentChunk.split('\n').slice(-3).join('\n');
      currentChunk = overlapText + '\n' + line + '\n';
      currentWords = countWords(currentChunk);
    } else {
      currentChunk += line + '\n';
      currentWords += lineWords;
    }
  }

  if (currentWords >= CONFIG.chunking.minChunkSize) {
    chunks.push({
      text: currentChunk.trim(),
      words: currentWords,
      metadata
    });
  }

  return chunks;
}

// ===== Cloudflare D1 Functions =====

async function d1Query(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cloudflare.accountId}/d1/database/${CONFIG.cloudflare.databaseId}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.cloudflare.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql, params })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`D1 error: ${error}`);
  }

  const result = await response.json();
  return result.result[0];
}

async function insertDocument(doc) {
  const sql = `
    INSERT OR REPLACE INTO documents
    (id, file_path, file_name, folder, topic, file_type, content_hash, size_bytes, github_sha, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
  `;

  await d1Query(sql, [
    doc.id,
    doc.file_path,
    doc.file_name,
    doc.folder,
    doc.topic,
    doc.file_type,
    doc.content_hash,
    doc.size_bytes,
    doc.github_sha
  ]);
}

async function insertChunk(chunk) {
  const sql = `
    INSERT INTO chunks (id, document_id, chunk_index, text, word_count, vector_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  await d1Query(sql, [
    chunk.id,
    chunk.document_id,
    chunk.chunk_index,
    chunk.text,
    chunk.word_count,
    chunk.vector_id
  ]);
}

async function logSyncStart(commitSha) {
  const sql = `
    INSERT INTO sync_log (sync_started_at, github_commit_sha, status)
    VALUES (strftime('%s', 'now'), ?, 'running')
  `;
  const result = await d1Query(sql, [commitSha]);
  return result.meta.last_row_id;
}

async function logSyncComplete(syncId, stats) {
  const sql = `
    UPDATE sync_log
    SET sync_completed_at = strftime('%s', 'now'),
        files_processed = ?,
        chunks_created = ?,
        vectors_uploaded = ?,
        status = 'completed'
    WHERE id = ?
  `;
  await d1Query(sql, [stats.files, stats.chunks, stats.vectors, syncId]);
}

// ===== Workers AI Functions =====

async function createEmbedding(text) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cloudflare.accountId}/ai/run/${CONFIG.cloudflare.embeddingModel}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.cloudflare.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: [text] })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Workers AI error: ${error}`);
  }

  const result = await response.json();
  return result.result.data[0];
}

async function createEmbeddingsBatch(texts) {
  const embeddings = [];

  for (let i = 0; i < texts.length; i++) {
    if (i % 10 === 0) {
      console.log(`  Creating embeddings ${i+1}/${texts.length}...`);
    }

    const embedding = await createEmbedding(texts[i]);
    embeddings.push(embedding);

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return embeddings;
}

// ===== Vectorize Functions =====

async function uploadToVectorize(vectors) {
  console.log(`\n📤 Uploading ${vectors.length} vectors to Vectorize...`);

  const fs = await import('fs');
  const ndjson = vectors.map(v => JSON.stringify(v)).join('\n');
  fs.writeFileSync('/tmp/vectors.ndjson', ndjson);

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    const { stdout, stderr } = await execAsync(
      `cd ${process.cwd()}/.. && CLOUDFLARE_API_TOKEN=${CONFIG.cloudflare.apiToken} CLOUDFLARE_ACCOUNT_ID=${CONFIG.cloudflare.accountId} npx wrangler vectorize insert ${CONFIG.cloudflare.indexName} --file=/tmp/vectors.ndjson`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    console.log('  ✅ Uploaded all vectors');
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } catch (error) {
    throw new Error(`Wrangler insert failed: ${error.message}`);
  }

  console.log('✅ All vectors uploaded successfully!');
}

// ===== Main Ingest Process =====

async function main() {
  console.log('🚀 Starting RAG Ingest Process v2 (D1 + Vectorize)\n');

  const requiredEnvVars = [
    'GITHUB_TOKEN', 'GITHUB_REPO',
    'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'
  ];

  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  // Start sync log
  const syncId = await logSyncStart(CONFIG.github.branch);
  console.log(`📝 Sync ID: ${syncId}\n`);

  let files = await getGitHubFiles();

  // Free tier protection
  const MAX_FILES = parseInt(process.env.MAX_FILES || '100');
  const MAX_EMBEDDINGS = parseInt(process.env.MAX_EMBEDDINGS || '500');

  if (files.length > MAX_FILES) {
    console.log(`⚠️  WARNING: Found ${files.length} files, limiting to ${MAX_FILES}`);
    files = files.slice(0, MAX_FILES);
  }

  console.log('\n📝 Processing files...');
  const allChunks = [];
  const allDocuments = [];

  for (const file of files) {
    console.log(`  Processing: ${file.path}`);
    const content = await getFileContent(file.path);

    const pathParts = file.path.split('/');
    const fileName = pathParts.pop();
    const folder = pathParts.join('/') || 'root';
    const topic = pathParts[0] || 'general';

    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const documentId = `doc_${contentHash.substring(0, 16)}`;

    // Save document to D1
    const document = {
      id: documentId,
      file_path: file.path,
      file_name: fileName,
      folder: folder,
      topic: topic,
      file_type: path.extname(file.path).slice(1) || 'txt',
      content_hash: contentHash,
      size_bytes: content.length,
      github_sha: file.sha
    };

    await insertDocument(document);
    allDocuments.push(document);

    // Create chunks
    const metadata = {
      filePath: file.path,
      fileName: fileName,
      folder: folder,
      topic: topic
    };

    const chunks = chunkText(content, metadata);
    console.log(`    → ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${documentId}_chunk_${i}`;
      const vectorId = chunkId; // Same ID for Vectorize

      await insertChunk({
        id: chunkId,
        document_id: documentId,
        chunk_index: i,
        text: chunks[i].text,
        word_count: chunks[i].words,
        vector_id: vectorId
      });

      allChunks.push({
        id: chunkId,
        vectorId: vectorId,
        text: chunks[i].text,
        metadata: {
          chunk_id: chunkId,
          document_id: documentId,
          file_path: file.path,
          topic: topic,
          folder: folder,
          chunk_index: i
        }
      });
    }
  }

  console.log(`\n✅ Total chunks created: ${allChunks.length}`);
  console.log(`✅ Total documents: ${allDocuments.length}`);

  // Free tier protection for embeddings
  if (allChunks.length > MAX_EMBEDDINGS) {
    console.log(`⚠️  WARNING: ${allChunks.length} chunks exceeds limit of ${MAX_EMBEDDINGS}`);
    console.log(`   Limiting to ${MAX_EMBEDDINGS} chunks`);
    allChunks.length = MAX_EMBEDDINGS;
  }

  console.log('\n🤖 Creating embeddings with Workers AI...');
  const texts = allChunks.map(c => c.text);
  const embeddings = await createEmbeddingsBatch(texts);

  // Create Vectorize vectors with LIGHT metadata (no full text!)
  const vectors = allChunks.map((chunk, idx) => ({
    id: chunk.vectorId,
    values: embeddings[idx],
    metadata: {
      chunk_id: chunk.metadata.chunk_id,
      document_id: chunk.metadata.document_id,
      file_path: chunk.metadata.file_path,
      topic: chunk.metadata.topic,
      folder: chunk.metadata.folder,
      chunk_index: chunk.metadata.chunk_index
      // ❌ NO "text" field here - it's in D1!
    }
  }));

  await uploadToVectorize(vectors);

  // Update sync log
  await logSyncComplete(syncId, {
    files: files.length,
    chunks: allChunks.length,
    vectors: vectors.length
  });

  console.log('\n✨ Ingest process completed successfully!');
  console.log(`\n📊 Statistics:`);
  console.log(`   Files processed: ${files.length}`);
  console.log(`   Documents in D1: ${allDocuments.length}`);
  console.log(`   Chunks in D1: ${allChunks.length}`);
  console.log(`   Vectors in Vectorize: ${vectors.length}`);
  console.log(`   Topics: ${[...new Set(allChunks.map(c => c.metadata.topic))].join(', ')}`);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
