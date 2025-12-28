/**
 * MCP Server для RAG на Cloudflare Workers
 */

interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  METADATA?: KVNamespace;
  MCP_AUTH_TOKEN?: string;
  EMBEDDING_MODEL: string;
}

interface MCPMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface VectorizeMatch {
  id: string;
  score: number;
  values: number[];
  metadata: Record<string, any>;
}

async function createEmbedding(ai: Ai, text: string, model: string): Promise<number[] | null> {
  try {
    const result = await ai.run(model, { text: [text] }) as { data: number[][] };
    return result.data[0];
  } catch (error) {
    console.error('Cloudflare AI error:', error);
    return null;
  }
}

async function searchVectorize(
  vectorize: VectorizeIndex,
  embedding: number[],
  topK: number = 5,
  filter?: Record<string, any>
): Promise<VectorizeMatch[]> {
  try {
    const results = await vectorize.query(embedding, {
      topK,
      returnValues: false,
      returnMetadata: 'all',
      filter,
    });
    return results.matches || [];
  } catch (error) {
    console.error('Vectorize error:', error);
    return [];
  }
}

function formatSearchResults(matches: VectorizeMatch[]): string {
  if (matches.length === 0) {
    return 'No relevant documents found.';
  }

  let output = `Found ${matches.length} relevant documents:\n\n`;

  matches.forEach((match, idx) => {
    const metadata = match.metadata;
    const score = (match.score * 100).toFixed(1);

    output += `## Document ${idx + 1} (Relevance: ${score}%)\n`;
    output += `**File:** ${metadata.filePath}\n`;
    output += `**Topic:** ${metadata.topic}\n`;
    output += `**Folder:** ${metadata.folder}\n\n`;
    output += `${metadata.text}\n\n`;
    output += '---\n\n';
  });

  return output;
}

async function handleMCPRequest(message: MCPMessage, env: Env): Promise<MCPMessage> {
  const { method, params, id } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'RAG Knowledge Base', version: '1.0.0' },
      },
    };
  }

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
                limit: { type: 'number', description: 'Max results (default: 5, max: 20)', default: 5 },
                topic: { type: 'string', description: 'Filter by topic (optional)' },
                min_score: { type: 'number', description: 'Min relevance (0-1, default: 0.7)', default: 0.7 },
              },
              required: ['query'],
            },
          },
        ],
      },
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};

    if (name === 'search_knowledge') {
      const query = args?.query;
      const limit = Math.min(args?.limit || 5, 20);
      const topic = args?.topic;
      const minScore = args?.min_score || 0.7;

      if (!query) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Missing required parameter: query' },
        };
      }

      const embedding = await createEmbedding(env.AI, query, env.EMBEDDING_MODEL);

      if (!embedding) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: 'Failed to create embedding' },
        };
      }

      const filter = topic ? { topic } : undefined;
      const matches = await searchVectorize(env.VECTORIZE, embedding, limit, filter);
      const filteredMatches = matches.filter((m) => m.score >= minScore);
      const formattedResults = formatSearchResults(filteredMatches);

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: formattedResults }],
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function checkAuth(request: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return true;
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const token = authHeader.replace('Bearer ', '');
  return token === env.MCP_AUTH_TOKEN;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'RAG MCP Server', version: '1.0.0' }),
        { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }

    if (request.method === 'POST') {
      if (!checkAuth(request, env)) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }

      try {
        const message: MCPMessage = await request.json();

        if (message.jsonrpc !== '2.0') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
          );
        }

        const response = await handleMCPRequest(message, env);
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } catch (error) {
        console.error('Error:', error);
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
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};
