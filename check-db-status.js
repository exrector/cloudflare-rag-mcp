/**
 * Diagnostic script to check D1 database and Vectorize index status
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DB_ID = '3bc73c19-69ce-4940-b63b-6a2ca5cf5dfb';
const VECTORIZE_INDEX = 'myrag-index';

async function executeD1Query(sql) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`D1 API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.result[0];
}

async function getVectorizeInfo() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/indexes/${VECTORIZE_INDEX}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Vectorize API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.result;
}

async function main() {
  console.log('🔍 Checking D1 Database and Vectorize Status\n');

  if (!ACCOUNT_ID || !API_TOKEN) {
    console.log('❌ Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    console.log('Please set environment variables or pass them as arguments');
    process.exit(1);
  }

  try {
    // Check documents table
    console.log('📚 Checking documents table...');
    const docCount = await executeD1Query('SELECT COUNT(*) as count FROM documents');
    console.log(`   Total documents: ${docCount.results[0].count}`);

    const docs = await executeD1Query('SELECT id, file_path, topic, created_at FROM documents ORDER BY created_at DESC LIMIT 5');
    console.log('   Recent documents:');
    docs.results.forEach(doc => {
      const date = new Date(doc.created_at * 1000).toISOString();
      console.log(`     - ${doc.file_path} (${doc.topic}) - ${date}`);
    });

    // Check chunks table
    console.log('\n📝 Checking chunks table...');
    const chunkCount = await executeD1Query('SELECT COUNT(*) as count FROM chunks');
    console.log(`   Total chunks: ${chunkCount.results[0].count}`);

    const chunksWithVectors = await executeD1Query('SELECT COUNT(*) as count FROM chunks WHERE vector_id IS NOT NULL');
    console.log(`   Chunks with vector_id: ${chunksWithVectors.results[0].count}`);

    const chunksWithoutVectors = await executeD1Query('SELECT COUNT(*) as count FROM chunks WHERE vector_id IS NULL');
    console.log(`   Chunks without vector_id: ${chunksWithoutVectors.results[0].count}`);

    // Sample chunks
    const chunks = await executeD1Query('SELECT id, document_id, vector_id, word_count FROM chunks LIMIT 5');
    console.log('   Sample chunks:');
    chunks.results.forEach(chunk => {
      console.log(`     - ${chunk.id} (${chunk.word_count} words) - vector: ${chunk.vector_id ? '✅' : '❌'}`);
    });

    // Check sync log
    console.log('\n📋 Checking sync log...');
    const syncLog = await executeD1Query('SELECT * FROM sync_log ORDER BY sync_started_at DESC LIMIT 5');
    if (syncLog.results.length > 0) {
      console.log('   Recent sync operations:');
      syncLog.results.forEach(log => {
        const started = new Date(log.sync_started_at * 1000).toISOString();
        const completed = log.sync_completed_at ? new Date(log.sync_completed_at * 1000).toISOString() : 'not completed';
        console.log(`     - ${log.status} | Started: ${started} | Completed: ${completed}`);
        console.log(`       Files: ${log.files_processed}, Chunks: ${log.chunks_created}, Vectors: ${log.vectors_uploaded}`);
        if (log.error_message) {
          console.log(`       Error: ${log.error_message}`);
        }
      });
    } else {
      console.log('   No sync log entries found');
    }

    // Check Vectorize index
    console.log('\n🔢 Checking Vectorize index...');
    const vectorInfo = await getVectorizeInfo();
    console.log(`   Index name: ${vectorInfo.name}`);
    console.log(`   Dimensions: ${vectorInfo.config.dimensions}`);
    console.log(`   Metric: ${vectorInfo.config.metric}`);
    console.log(`   Vector count: ${vectorInfo.vectorsCount || 'N/A'}`);

    // Final summary
    console.log('\n✅ Summary:');
    const docsCount = docCount.results[0].count;
    const chunksCount = chunkCount.results[0].count;
    const vectorsCount = chunksWithVectors.results[0].count;
    const missingVectors = chunksWithoutVectors.results[0].count;

    console.log(`   Documents: ${docsCount}`);
    console.log(`   Chunks: ${chunksCount}`);
    console.log(`   Chunks with vectors: ${vectorsCount}`);

    if (missingVectors > 0) {
      console.log(`   ⚠️  WARNING: ${missingVectors} chunks are missing vector_id!`);
    } else {
      console.log(`   ✅ All chunks have vector_id populated`);
    }

    if (vectorInfo.vectorsCount && vectorInfo.vectorsCount != vectorsCount) {
      console.log(`   ⚠️  WARNING: Vectorize index has ${vectorInfo.vectorsCount} vectors, but D1 has ${vectorsCount} chunks with vector_id`);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
