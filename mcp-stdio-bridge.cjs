#!/usr/bin/env node
/**
 * MCP stdio bridge для Claude Desktop
 * Конвертирует stdio → HTTP запросы к Cloudflare Worker
 */

const https = require('https');
const readline = require('readline');

const MCP_SERVER_URL = 'https://rag-mcp-server.exrector.workers.dev';
const AUTH_TOKEN = 'e4e0b98b4c8cc0bd0fd4681655815eee16c941ae710455fbd00e58a7be795bca';

// Читаем JSON-RPC сообщения из stdin
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  try {
    const message = JSON.parse(line);

    // Отправляем запрос к HTTP MCP серверу
    const response = await sendRequest(message);

    // Отправляем ответ в stdout
    console.log(JSON.stringify(response));
  } catch (error) {
    console.error('Error processing message:', error.message);
    const errorResponse = {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32603,
        message: error.message
      }
    };
    console.log(JSON.stringify(errorResponse));
  }
});

function sendRequest(message) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(message);

    const options = {
      hostname: 'rag-mcp-server.exrector.workers.dev',
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${AUTH_TOKEN}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

// Handle termination
process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});
