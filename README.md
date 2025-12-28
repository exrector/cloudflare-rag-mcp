# Personal RAG Knowledge Base (100% Cloudflare + MCP)

RAG-система для личной базы знаний на Cloudflare Workers с MCP интеграцией для Claude.

**Полностью на Cloudflare:** Workers AI для embeddings, Vectorize для хранения, Worker для MCP сервера.

## Быстрый старт

```bash
cd ~/cloudflare-rag-mcp

# 1. Setup
cp .env.example .env
# Заполните .env

# 2. Автоустановка
./SETUP.sh

# 3. Загрузка данных
npm run ingest

# 4. Развертывание
npm run deploy

# 5. Подключение к Claude Code
claude mcp add --transport http knowledge https://rag-mcp-server.YOUR.workers.dev
```

## Что нужно

- GitHub репозиторий с документами (`.md`, `.txt`)
- Cloudflare аккаунт (бесплатный)
- GitHub Personal Access Token

## Архитектура

```
GitHub Repo (приватный)
    ↓
Ingest Script (v2)
    ↓
Cloudflare Workers AI (@cf/baai/bge-large-en-v1.5)
    ↓
├─ D1 Database (полные тексты чанков + метаданные)
└─ Vectorize (векторы + легкие метаданные с chunk_id)
    ↓
Cloudflare Worker (MCP Server, JSON-RPC 2.0)
  ├─ Query: Vectorize → получить chunk_ids
  └─ Fetch: D1 → получить полные тексты
    ↓
Claude Desktop / Claude Code
```

**Правильная архитектура RAG:**
- **D1**: Хранит полные тексты чанков, метаданные документов, историю синхронизаций
- **Vectorize**: Хранит только векторы + минимальные метаданные (chunk_id, topic, file_path)
- **R2** (опционально): Для хранения оригинальных больших файлов

## Файлы

- `ingest/ingest-v2.js` - загрузка данных из GitHub (D1 + Vectorize)
- `ingest/ingest-v1-legacy.js` - старая версия (только Vectorize, deprecated)
- `src/index.ts` - MCP Worker с поддержкой D1
- `schema.sql` - схема D1 базы данных
- `wrangler.toml` - конфигурация Cloudflare (D1, Vectorize, Workers AI)
- `.env.example` - шаблон переменных окружения
- `SETUP.sh` - автоматическая установка

## Переменные окружения (.env)

```bash
GITHUB_TOKEN=ghp_xxx                    # GitHub PAT (права: repo)
GITHUB_REPO=username/repo               # Ваш репозиторий
GITHUB_BRANCH=main                      # Ветка

CLOUDFLARE_ACCOUNT_ID=xxx               # Account ID
CLOUDFLARE_API_TOKEN=xxx                # API Token (Workers Scripts:Edit, Vectorize:Edit, Workers AI:Read)

MCP_AUTH_TOKEN=xxx                      # Опционально, для защиты endpoint
```

## Структура GitHub репозитория

```
my-knowledge/
├── programming/
│   ├── python.md
│   └── javascript.md
├── notes/
│   └── ideas.md
└── README.md
```

Структура папок = темы в RAG.

## Использование

После подключения к Claude:

```
Найди документы о Python

Покажи все заметки по программированию

Что говорится о machine learning?
```

## MCP Tool: search_knowledge

Параметры:
- `query` (обязательный) - текст запроса
- `limit` (опционально) - количество результатов (default: 5, max: 20)
- `topic` (опционально) - фильтр по папке
- `min_score` (опционально) - порог релевантности (default: 0.7)

## Обновление данных

После изменений в GitHub:

```bash
npm run ingest
```

## Технические детали

- **Embedding модель:** `@cf/baai/bge-large-en-v1.5` (1024 dimensions)
- **D1 Database:** SQLite база для полных текстов и метаданных
- **Vectorize metric:** cosine similarity
- **Chunking:** 512 слов, overlap 50
- **MCP Protocol:** JSON-RPC 2.0 over HTTP
- **Архитектурный паттерн:** Vectorize (chunk_id) → D1 (full text)

## Стоимость

**Бесплатно** (Cloudflare Free tier):
- Workers AI: 10,000 requests/day
- Vectorize: 30M queries/month
- Workers: 100,000 requests/day

## Troubleshooting

**Ingest fails:**
- Проверьте GITHUB_TOKEN
- Проверьте CLOUDFLARE_API_TOKEN

**No results:**
- Снизьте `min_score`
- Проверьте, что ingest выполнился

**401 Unauthorized:**
- Проверьте MCP_AUTH_TOKEN в Claude конфигурации

## Подключение к Claude Desktop

`~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "knowledge": {
      "type": "http",
      "url": "https://rag-mcp-server.YOUR.workers.dev",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

## License

MIT
