#!/usr/bin/env node
/**
 * RAG Ingest Script - Cloudflare Workers AI
 */

import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
import path from 'path';

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
    indexName: 'myrag-index',
    embeddingModel: '@cf/baai/bge-large-en-v1.5'
  },
  chunking: {
    chunkSize: 512,
    chunkOverlap: 50,
    minChunkSize: 1
  },
  supportedExtensions: ['.md', '.txt', '.mdx', '.rst']
};

const octokit = new Octokit({ auth: CONFIG.github.token });

function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
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
    item.type === 'blob' &&
    CONFIG.supportedExtensions.some(ext => item.path.endsWith(ext))
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
    throw new Error(`Cloudflare AI error: ${error}`);
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

async function uploadToVectorize(vectors) {
  console.log(`\n📤 Uploading ${vectors.length} vectors to Vectorize...`);

  // Save vectors to NDJSON file
  const fs = await import('fs');
  const ndjson = vectors.map(v => JSON.stringify(v)).join('\n');
  fs.writeFileSync('/tmp/vectors.ndjson', ndjson);

  // Use wrangler to insert
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

async function main() {
  console.log('🚀 Starting RAG Ingest Process (Cloudflare Workers AI)\n');

  const requiredEnvVars = [
    'GITHUB_TOKEN', 'GITHUB_REPO',
    'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'
  ];

  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  let files = await getGitHubFiles();

  // Защита от превышения Cloudflare Free tier лимитов
  const MAX_FILES = parseInt(process.env.MAX_FILES || '100');
  const MAX_EMBEDDINGS = parseInt(process.env.MAX_EMBEDDINGS || '500');

  if (files.length > MAX_FILES) {
    console.log(`⚠️  WARNING: Found ${files.length} files, limiting to ${MAX_FILES} to stay within free tier`);
    files = files.slice(0, MAX_FILES);
  }

  console.log('\n📝 Processing files...');
  const allChunks = [];

  for (const file of files) {
    console.log(`  Processing: ${file.path}`);
    const content = await getFileContent(file.path);

    const pathParts = file.path.split('/');
    const fileName = pathParts.pop();
    const folder = pathParts.join('/') || 'root';
    const topic = pathParts[0] || 'general';

    const metadata = {
      filePath: file.path,
      fileName: fileName,
      folder: folder,
      topic: topic,
      fileType: path.extname(file.path).slice(1)
    };

    const chunks = chunkText(content, metadata);
    console.log(`    → ${chunks.length} chunks`);
    allChunks.push(...chunks);
  }

  console.log(`\n✅ Total chunks created: ${allChunks.length}`);

  // Проверка лимита embeddings
  if (allChunks.length > MAX_EMBEDDINGS) {
    console.log(`⚠️  WARNING: ${allChunks.length} chunks exceeds limit of ${MAX_EMBEDDINGS} embeddings`);
    console.log(`   Limiting to ${MAX_EMBEDDINGS} to stay within Cloudflare Free tier (10,000/day)`);
    allChunks.length = MAX_EMBEDDINGS; // Обрезаем массив
  }

  console.log('\n🤖 Creating embeddings with Cloudflare Workers AI...');
  const texts = allChunks.map(c => c.text);
  const embeddings = await createEmbeddingsBatch(texts);

  const vectors = allChunks.map((chunk, idx) => ({
    id: `${chunk.metadata.filePath}_chunk_${idx}`,
    values: embeddings[idx],
    metadata: {
      ...chunk.metadata,
      text: chunk.text,
      chunkIndex: idx,
      words: chunk.words
    }
  }));

  await uploadToVectorize(vectors);

  console.log('\n✨ Ingest process completed successfully!');
  console.log(`\n📊 Statistics:`);
  console.log(`   Files processed: ${files.length}`);
  console.log(`   Total chunks: ${allChunks.length}`);
  console.log(`   Topics: ${[...new Set(allChunks.map(c => c.metadata.topic))].join(', ')}`);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
