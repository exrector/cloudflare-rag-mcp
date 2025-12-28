#!/bin/bash
# Быстрая установка RAG MCP Server (100% Cloudflare)

set -e

echo "🚀 RAG MCP Server Setup (Cloudflare только)"
echo ""

# 1. Копировать .env если нет
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Создан .env - заполните его!"
    exit 0
fi

source .env

# 2. Проверка переменных
REQUIRED="GITHUB_TOKEN GITHUB_REPO CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN"
for VAR in $REQUIRED; do
    if [ -z "${!VAR}" ]; then
        echo "❌ Missing: $VAR в .env"
        exit 1
    fi
done

# 3. Установка зависимостей
echo "📦 Installing dependencies..."
npm install --silent
cd ingest && npm install --silent && cd ..

# 4. Wrangler login
echo "🔐 Cloudflare login..."
npx wrangler login

# 5. Создать Vectorize index (768 dimensions для BGE model)
echo "🗄️ Creating Vectorize index..."
npx wrangler vectorize create personal-knowledge-base \
  --dimensions=768 \
  --metric=cosine || echo "Index already exists"

# 6. Создать KV namespace (optional)
npx wrangler kv:namespace create METADATA || echo "KV already exists"

# 7. Установить секреты
if [ -n "$MCP_AUTH_TOKEN" ]; then
    echo "🔐 Setting MCP_AUTH_TOKEN..."
    echo "$MCP_AUTH_TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. npm run ingest    # Load data from GitHub"
echo "  2. npm run deploy    # Deploy Worker"
echo "  3. Add to Claude Code"
