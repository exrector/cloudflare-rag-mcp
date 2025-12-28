/**
 * GitHub Webhook Ingest Worker
 * Автоматическая обработка файлов из GitHub при push
 */

interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  DB: D1Database;
  GITHUB_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  EMBEDDING_MODEL: string;
}

interface GitHubPushPayload {
  repository: {
    full_name: string;
    default_branch: string;
  };
  commits: Array<{
    id: string;
    added: string[];
    modified: string[];
    removed: string[];
  }>;
  ref: string;
}

interface FileChange {
  path: string;
  sha: string;
  content: string;
}

interface Chunk {
  text: string;
  wordCount: number;
  chunkIndex: number;
}

const CONFIG = {
  chunkSize: 512,
  chunkOverlap: 50,
  minChunkSize: 10,
  supportedExtensions: ['.md', '.txt', '.mdx', '.rst'],
  excludedPaths: ['.git', '.github', 'node_modules', '.DS_Store'],
  excludedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.pdf'],
};

// ===== GitHub API Functions =====

async function verifyGitHubSignature(
  request: Request,
  secret: string
): Promise<boolean> {
  const signature = request.headers.get('X-Hub-Signature-256');
  if (!signature) return false;

  const body = await request.text();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hash = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `sha256=${hash}` === signature;
}

function isTextFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] || '';

  if (CONFIG.supportedExtensions.includes(ext)) return true;
  if (CONFIG.excludedExtensions.includes(ext)) return false;
  if (CONFIG.excludedPaths.some((excluded) => filePath.includes(excluded))) return false;

  return !ext && !filePath.split('/').pop()?.startsWith('.');
}

async function fetchFileContent(
  repo: string,
  filePath: string,
  ref: string,
  token: string
): Promise<string | null> {
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${ref}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Cloudflare-RAG-Worker',
    },
  });

  if (!response.ok) {
    console.error(`Failed to fetch ${filePath}: ${response.status}`);
    return null;
  }

  const data = await response.json() as { content: string; encoding: string };

  if (data.encoding === 'base64') {
    return atob(data.content);
  }

  return data.content;
}

async function getChangedFiles(
  payload: GitHubPushPayload,
  token: string
): Promise<FileChange[]> {
  const files: FileChange[] = [];
  const processedPaths = new Set<string>();

  for (const commit of payload.commits) {
    const allFiles = [...commit.added, ...commit.modified];

    for (const filePath of allFiles) {
      if (processedPaths.has(filePath) || !isTextFile(filePath)) continue;
      processedPaths.add(filePath);

      const content = await fetchFileContent(
        payload.repository.full_name,
        filePath,
        commit.id,
        token
      );

      if (content) {
        files.push({
          path: filePath,
          sha: commit.id,
          content,
        });
      }
    }
  }

  return files;
}

// ===== Text Processing Functions =====

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];
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

// ===== D1 Functions =====

async function insertDocument(
  db: D1Database,
  doc: {
    id: string;
    filePath: string;
    fileName: string;
    folder: string;
    topic: string;
    fileType: string;
    contentHash: string;
    sizeBytes: number;
    githubSha: string;
  }
) {
  const sql = `
    INSERT OR REPLACE INTO documents
    (id, file_path, file_name, folder, topic, file_type, content_hash, size_bytes, github_sha, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
  `;

  await db
    .prepare(sql)
    .bind(
      doc.id,
      doc.filePath,
      doc.fileName,
      doc.folder,
      doc.topic,
      doc.fileType,
      doc.contentHash,
      doc.sizeBytes,
      doc.githubSha
    )
    .run();
}

async function insertChunks(
  db: D1Database,
  chunks: Array<{
    id: string;
    documentId: string;
    chunkIndex: number;
    text: string;
    wordCount: number;
    vectorId: string;
  }>
) {
  const sql = `
    INSERT INTO chunks (id, document_id, chunk_index, text, word_count, vector_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  for (const chunk of chunks) {
    await db
      .prepare(sql)
      .bind(
        chunk.id,
        chunk.documentId,
        chunk.chunkIndex,
        chunk.text,
        chunk.wordCount,
        chunk.vectorId
      )
      .run();
  }
}

// ===== Embedding & Vectorize Functions =====

async function createEmbedding(ai: Ai, text: string, model: string): Promise<number[]> {
  const result = await ai.run(model, { text: [text] }) as { data: number[][] };
  return result.data[0];
}

async function upsertToVectorize(
  vectorize: VectorizeIndex,
  vectors: Array<{
    id: string;
    values: number[];
    metadata: Record<string, any>;
  }>
) {
  await vectorize.upsert(vectors);
}

// ===== Hash Function =====

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ===== Main Processing Function =====

async function processFile(
  file: FileChange,
  env: Env
): Promise<{ documentsCreated: number; chunksCreated: number }> {
  console.log(`Processing: ${file.path}`);

  const pathParts = file.path.split('/');
  const fileName = pathParts.pop() || 'unknown';
  const folder = pathParts.join('/') || 'root';
  const topic = pathParts[0] || 'general';
  const fileType = fileName.split('.').pop() || 'txt';

  const contentHash = await hashContent(file.content);
  const documentId = `doc_${contentHash.substring(0, 16)}`;

  // Save document to D1
  await insertDocument(env.DB, {
    id: documentId,
    filePath: file.path,
    fileName,
    folder,
    topic,
    fileType,
    contentHash,
    sizeBytes: file.content.length,
    githubSha: file.sha,
  });

  // Chunk text
  const textChunks = chunkText(file.content);
  console.log(`  → ${textChunks.length} chunks created`);

  if (textChunks.length === 0) {
    return { documentsCreated: 1, chunksCreated: 0 };
  }

  // Create embeddings
  const embeddings: number[][] = [];
  for (const chunk of textChunks) {
    const embedding = await createEmbedding(env.AI, chunk.text, env.EMBEDDING_MODEL);
    embeddings.push(embedding);
  }

  // Prepare chunks for D1 and vectors for Vectorize
  const d1Chunks = textChunks.map((chunk, idx) => ({
    id: `${documentId}_chunk_${idx}`,
    documentId,
    chunkIndex: idx,
    text: chunk.text,
    wordCount: chunk.wordCount,
    vectorId: `${documentId}_chunk_${idx}`,
  }));

  const vectors = textChunks.map((chunk, idx) => ({
    id: `${documentId}_chunk_${idx}`,
    values: embeddings[idx],
    metadata: {
      chunk_id: `${documentId}_chunk_${idx}`,
      document_id: documentId,
      file_path: file.path,
      topic,
      folder,
      chunk_index: idx,
    },
  }));

  // Save to D1 and Vectorize
  await insertChunks(env.DB, d1Chunks);
  await upsertToVectorize(env.VECTORIZE, vectors);

  console.log(`  ✅ Saved ${textChunks.length} chunks to D1 and Vectorize`);

  return { documentsCreated: 1, chunksCreated: textChunks.length };
}

// ===== Worker Export =====

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'GitHub Webhook Ingest Worker',
          version: '2.0.0',
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Webhook endpoint
    if (url.pathname === '/webhook' && request.method === 'POST') {
      // Verify GitHub signature
      const isValid = await verifyGitHubSignature(
        request.clone(),
        env.GITHUB_WEBHOOK_SECRET
      );

      if (!isValid) {
        return new Response('Invalid signature', { status: 401 });
      }

      const payload = (await request.json()) as GitHubPushPayload;
      const event = request.headers.get('X-GitHub-Event');

      // Only process push events
      if (event !== 'push') {
        return new Response('Event ignored', { status: 200 });
      }

      console.log(
        `📥 Webhook received: ${payload.commits.length} commits in ${payload.repository.full_name}`
      );

      // Get changed files
      const files = await getChangedFiles(payload, env.GITHUB_TOKEN);
      console.log(`📝 Found ${files.length} text files to process`);

      if (files.length === 0) {
        return new Response(
          JSON.stringify({ message: 'No text files to process' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Process each file
      let totalDocuments = 0;
      let totalChunks = 0;

      for (const file of files) {
        const result = await processFile(file, env);
        totalDocuments += result.documentsCreated;
        totalChunks += result.chunksCreated;
      }

      console.log(
        `✅ Processed ${files.length} files: ${totalDocuments} documents, ${totalChunks} chunks`
      );

      return new Response(
        JSON.stringify({
          success: true,
          filesProcessed: files.length,
          documentsCreated: totalDocuments,
          chunksCreated: totalChunks,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
  },
};
