/**
 * Simple HTTP MCP Server for Claude Desktop
 * Semantic search over personal knowledge base
 */

interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  DB: D1Database;
  MCP_AUTH_TOKEN?: string;
  EMBEDDING_MODEL: string;
}

interface MCPRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

// ===== Embedding & Search =====

async function createEmbedding(ai: Ai, text: string, model: string): Promise<number[]> {
  const result = (await ai.run(model, { text: [text] })) as { data: number[][] };
  return result.data[0];
}

async function searchVectorize(
  vectorize: VectorizeIndex,
  embedding: number[],
  topK: number
): Promise<any[]> {
  const results = await vectorize.query(embedding, {
    topK,
    returnValues: false,
    returnMetadata: 'all',
  });
  return results.matches || [];
}

async function getChunkText(db: D1Database, chunkId: string): Promise<string> {
  const result = await db
    .prepare('SELECT text FROM chunks WHERE id = ?')
    .bind(chunkId)
    .first();

  return result?.text as string || '[Text not found]';
}

// ===== MCP Handlers =====

async function handleMCP(request: MCPRequest, env: Env): Promise<MCPResponse> {
  const { method, params, id } = request;

  // Initialize
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'knowledge-base', version: '1.0.0' },
      },
    };
  }

  // List tools
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'search_knowledge',
            description: 'Search your personal knowledge base using semantic search',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                limit: { type: 'number', description: 'Max results (default 5, max 20)', default: 5 },
                min_score: { type: 'number', description: 'Min relevance 0-1 (default 0.7)', default: 0.7 },
              },
              required: ['query'],
            },
          },
        ],
      },
    };
  }

  // Call tool
  if (method === 'tools/call') {
    const { name, arguments: args } = params;

    if (name === 'search_knowledge') {
      const query = args?.query;
      const limit = Math.min(args?.limit || 5, 20);
      const minScore = args?.min_score || 0.7;

      if (!query) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Missing required parameter: query' },
        };
      }

      // Create embedding
      const embedding = await createEmbedding(env.AI, query, env.EMBEDDING_MODEL);

      // Search
      const matches = await searchVectorize(env.VECTORIZE, embedding, limit);
      const filtered = matches.filter((m) => m.score >= minScore);

      // Format results
      let output = `Found ${filtered.length} relevant documents:\n\n`;

      for (let i = 0; i < filtered.length; i++) {
        const match = filtered[i];
        const metadata = match.metadata;
        const score = (match.score * 100).toFixed(1);
        const text = await getChunkText(env.DB, metadata.chunk_id);

        output += `## Document ${i + 1} (Relevance: ${score}%)\n`;
        output += `**File:** ${metadata.file_path}\n`;
        output += `**Topic:** ${metadata.topic}\n\n`;
        output += `${text}\n\n`;
        output += '---\n\n';
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: output }],
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    };
  }

  // Unsupported method
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ===== HTTP Server =====

function checkAuth(request: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return true; // No auth required

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;

  const token = authHeader.replace('Bearer ', '');
  return token === env.MCP_AUTH_TOKEN;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'MCP Knowledge Base' }),
        { headers: CORS_HEADERS }
      );
    }

    // MCP endpoint
    if (request.method === 'POST' && url.pathname === '/mcp') {
      // Auth check
      if (!checkAuth(request, env)) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Unauthorized' },
          }),
          { status: 401, headers: CORS_HEADERS }
        );
      }

      try {
        const mcpRequest = (await request.json()) as MCPRequest;

        if (mcpRequest.jsonrpc !== '2.0') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
            }),
            { status: 400, headers: CORS_HEADERS }
          );
        }

        const response = await handleMCP(mcpRequest, env);
        return new Response(JSON.stringify(response), { headers: CORS_HEADERS });
      } catch (error) {
        console.error('MCP Error:', error);
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: 'Parse error',
              data: error instanceof Error ? error.message : 'Unknown error',
            },
          }),
          { status: 400, headers: CORS_HEADERS }
        );
      }
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};
