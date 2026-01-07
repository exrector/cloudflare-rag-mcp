/**
 * GitHub Actions Ingest Script
 * Индексирует изменённые файлы в Cloudflare D1 + Vectorize
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY;
const GITHUB_SHA = process.env.GITHUB_SHA;

const DB_ID = '3bc73c19-69ce-4940-b63b-6a2ca5cf5dfb'; // myrag-metadata
const VECTORIZE_INDEX = 'myrag-index';
const EMBEDDING_MODEL = '@cf/baai/bge-m3';

const CONFIG = {
  chunkSize: 512,
  chunkOverlap: 50,
  minChunkSize: 10,
  supportedExtensions: ['.md', '.txt', '.mdx', '.rst'],
  excludedPaths: ['.git', '.github', 'node_modules', '.DS_Store', 'ARCHITECTURE_COMPARISON.md', 'LLM_INTEGRATION_OPTIONS.md', 'MCP_BRIDGE_EXPLANATION.md', 'POTENTIAL_ISSUES.md'],
};

// ===== Utilities =====

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!CONFIG.supportedExtensions.includes(ext)) return false;
  if (CONFIG.excludedPaths.some(excluded => filePath.includes(excluded))) return false;
  return true;
}

function getChangedFiles() {
  try {
    // Получить список изменённых файлов в последнем коммите
    const output = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf-8' });
    const files = output.trim().split('\n').filter(f => f && isTextFile(f));
    return files;
  } catch (error) {
    log(`Error getting changed files: ${error.message}`);
    return [];
  }
}

function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function chunkText(text) {
  const chunks = [];
  const lines = text.split('\n');
  let currentChunk = '';
  let currentWords = 0;

  for (const line of lines) {
    const lineWords = countWords(line);

    if (currentWords + lineWords > CONFIG.chunkSize && currentWords > 0) {
      if (currentWords >= CONFIG.minChunkSize) {
        chunks.push({
          text: currentChunk.trim(),
          wordCount: currentWords,
          chunkIndex: chunks.length,
        });
      }

      // Overlap: берем последние 3 строки
      const overlapText = currentChunk.split('\n').slice(-3).join('\n');
      currentChunk = overlapText + '\n' + line + '\n';
      currentWords = countWords(currentChunk);
    } else {
      currentChunk += line + '\n';
      currentWords += lineWords;
    }
  }

  if (currentWords >= CONFIG.minChunkSize) {
    chunks.push({
      text: currentChunk.trim(),
      wordCount: currentWords,
      chunkIndex: chunks.length,
    });
  }

  return chunks;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ===== Cloudflare API =====

async function createEmbedding(text) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [text] }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status}`);
  }

  const data = await response.json();
  return data.result.data[0];
}

async function executeD1Query(sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sql,
      params,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`D1 API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.result[0];
}

async function upsertVectorize(vectors) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/indexes/${VECTORIZE_INDEX}/upsert`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ vectors }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Vectorize API error: ${response.status} ${error}`);
  }

  return await response.json();
}

async function deleteOldVectors(documentId) {
  // Получить старые vector IDs
  const result = await executeD1Query(
    'SELECT vector_id FROM chunks WHERE document_id = ?',
    [documentId]
  );

  if (result.results && result.results.length > 0) {
    const vectorIds = result.results.map(r => r.vector_id);

    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/indexes/${VECTORIZE_INDEX}/delete-by-ids`;

    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: vectorIds }),
    });

    log(`  🗑️  Deleted ${vectorIds.length} old vectors`);
  }
}

// ===== Processing =====

async function processFile(filePath) {
  log(`📄 Processing: ${filePath}`);

  // Читаем файл
  const content = fs.readFileSync(filePath, 'utf-8');

  const pathParts = filePath.split('/');
  const fileName = pathParts.pop() || 'unknown';
  const folder = pathParts.join('/') || 'root';
  const topic = pathParts[0] || 'general';
  const fileType = path.extname(fileName).substring(1) || 'txt';

  const contentHash = hashContent(content);
  const documentId = `doc_${contentHash.substring(0, 16)}`;

  // Удалить старые векторы если документ уже существует
  await deleteOldVectors(documentId);

  // Удалить старые chunks из D1
  await executeD1Query('DELETE FROM chunks WHERE document_id = ?', [documentId]);

  // Сохранить документ в D1
  await executeD1Query(
    `INSERT OR REPLACE INTO documents
     (id, file_path, file_name, folder, topic, file_type, content_hash, size_bytes, github_sha, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))`,
    [documentId, filePath, fileName, folder, topic, fileType, contentHash, content.length, GITHUB_SHA]
  );

  // Создать chunks
  const textChunks = chunkText(content);
  log(`  📝 Created ${textChunks.length} chunks`);

  if (textChunks.length === 0) {
    return { documentsCreated: 1, chunksCreated: 0 };
  }

  // Создать embeddings (батчами по 5 для надёжности)
  const embeddings = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < textChunks.length; i += BATCH_SIZE) {
    const batch = textChunks.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await Promise.all(
      batch.map(chunk => createEmbedding(chunk.text))
    );
    embeddings.push(...batchEmbeddings);

    log(`  🧠 Created embeddings ${i + 1}-${Math.min(i + BATCH_SIZE, textChunks.length)}/${textChunks.length}`);
  }

  // Подготовить векторы для Vectorize
  const vectors = textChunks.map((chunk, idx) => ({
    id: `${documentId}_chunk_${idx}`,
    values: embeddings[idx],
    metadata: {
      chunk_id: `${documentId}_chunk_${idx}`,
      document_id: documentId,
      file_path: filePath,
      topic,
      folder,
      chunk_index: idx,
    },
  }));

  // Сохранить в Vectorize
  await upsertVectorize(vectors);
  log(`  ✅ Saved ${vectors.length} vectors to Vectorize`);

  // Сохранить chunks в D1 (батчами)
  for (let i = 0; i < textChunks.length; i++) {
    const chunk = textChunks[i];
    await executeD1Query(
      'INSERT INTO chunks (id, document_id, chunk_index, text, word_count, vector_id) VALUES (?, ?, ?, ?, ?, ?)',
      [`${documentId}_chunk_${i}`, documentId, i, chunk.text, chunk.wordCount, `${documentId}_chunk_${i}`]
    );
  }

  log(`  ✅ Saved ${textChunks.length} chunks to D1`);

  return { documentsCreated: 1, chunksCreated: textChunks.length, vectorsUploaded: textChunks.length };
}

// ===== Main =====

async function main() {
  log('🚀 Starting GitHub Actions ingest');

  // Проверить env variables
  if (!ACCOUNT_ID || !API_TOKEN) {
    throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
  }

  // Создать запись в sync_log
  const syncStartTime = Math.floor(Date.now() / 1000);
  const syncLogResult = await executeD1Query(
    `INSERT INTO sync_log (sync_started_at, status, github_commit_sha)
     VALUES (?, 'running', ?)
     RETURNING id`,
    [syncStartTime, GITHUB_SHA]
  );
  const syncLogId = syncLogResult.results[0]?.id;
  log(`📋 Created sync log entry: ${syncLogId}`);

  // Получить список изменённых файлов
  const files = getChangedFiles();

  if (files.length === 0) {
    log('ℹ️  No text files changed');

    // Завершить sync_log
    await executeD1Query(
      `UPDATE sync_log
       SET sync_completed_at = strftime('%s', 'now'),
           status = 'completed',
           files_processed = 0,
           chunks_created = 0,
           vectors_uploaded = 0
       WHERE id = ?`,
      [syncLogId]
    );

    return;
  }

  log(`📂 Found ${files.length} changed files`);

  let success = 0;
  let failed = 0;
  let totalChunks = 0;
  let totalVectors = 0;
  let errorMessages = [];

  for (const file of files) {
    if (!fs.existsSync(file)) {
      log(`⚠️  File not found: ${file} (probably deleted)`);
      continue;
    }

    try {
      const result = await processFile(file);
      success++;
      totalChunks += result.chunksCreated;
      totalVectors += result.vectorsUploaded;
    } catch (error) {
      log(`❌ Error processing ${file}: ${error.message}`);
      console.error(error.stack);
      failed++;
      errorMessages.push(`${file}: ${error.message}`);
    }
  }

  log('');
  log(`✅ Success: ${success}`);
  log(`❌ Failed: ${failed}`);
  log(`📝 Total chunks: ${totalChunks}`);
  log(`🔢 Total vectors: ${totalVectors}`);

  // Обновить sync_log с финальной статистикой
  const status = failed > 0 ? 'completed_with_errors' : 'completed';
  const errorMessage = errorMessages.length > 0 ? errorMessages.join('; ') : null;

  await executeD1Query(
    `UPDATE sync_log
     SET sync_completed_at = strftime('%s', 'now'),
         status = ?,
         files_processed = ?,
         chunks_created = ?,
         vectors_uploaded = ?,
         error_message = ?
     WHERE id = ?`,
    [status, success, totalChunks, totalVectors, errorMessage, syncLogId]
  );

  log(`📋 Updated sync log entry: ${syncLogId} (status: ${status})`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(async error => {
  log(`❌ Fatal error: ${error.message}`);
  console.error(error.stack);

  // Попытаться обновить sync_log при фатальной ошибке
  try {
    // Найти последнюю незавершённую синхронизацию
    const result = await executeD1Query(
      `SELECT id FROM sync_log
       WHERE status = 'running'
       ORDER BY sync_started_at DESC
       LIMIT 1`
    );

    if (result.results && result.results.length > 0) {
      const syncLogId = result.results[0].id;
      await executeD1Query(
        `UPDATE sync_log
         SET sync_completed_at = strftime('%s', 'now'),
             status = 'failed',
             error_message = ?
         WHERE id = ?`,
        [error.message, syncLogId]
      );
      log(`📋 Updated sync log entry ${syncLogId} with failure status`);
    }
  } catch (syncLogError) {
    log(`⚠️  Could not update sync_log: ${syncLogError.message}`);
  }

  process.exit(1);
});
