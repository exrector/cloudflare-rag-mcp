# Personal RAG Knowledge Base (100% Cloudflare + MCP)

**Полностью автоматическая** RAG-система для личной базы знаний на Cloudflare Workers с MCP интеграцией для Claude.

**100% на Cloudflare:** Workers AI для embeddings, D1 для текстов, Vectorize для векторов, GitHub Webhook → Worker для автоматической синхронизации.

## ⚡ Новая архитектура v2.0

**Полностью на Cloudflare!** Больше никаких GitHub Actions — всё обрабатывается на edge.

```
iPhone/Mac → GitHub Push
    ↓
GitHub Webhook (<1 сек)
    ↓
Cloudflare Worker (webhook-ingest)
  ├─ Workers AI (@cf/baai/bge-m3, 1024-dim, многоязычный)
  ├─ D1 Database (полные тексты чанков + метаданные)
  └─ Vectorize (векторы + легкие метаданные с chunk_id)
    ↓
Cloudflare Worker (MCP Server, JSON-RPC 2.0)
  ├─ Query: Vectorize → получить chunk_ids
  └─ Fetch: D1 → получить полные тексты
    ↓
Claude Desktop / Claude Code
```

### Преимущества v2.0:

- ⚡ **В 10-30 раз быстрее** — обработка за 1-3 секунды вместо 10-30 секунд
- 🌍 **Многоязычность** — `bge-m3` поддерживает 100+ языков (русский, английский, и т.д.)
- 🔒 **Безопаснее** — токены в Cloudflare secrets, не в GitHub
- 🎯 **Нативный доступ** — прямой доступ к Workers AI, D1, Vectorize (без REST API)
- 💰 **Полностью бесплатно** — Free tier Cloudflare хватает на тысячи файлов/день

## Быстрый старт

### 1. Деплой основного MCP сервера

```bash
cd ~/cloudflare-rag-mcp

# Установить зависимости
npm install

# Деплой MCP сервера для Claude
npm run deploy
```

### 2. Деплой webhook ingest worker

```bash
# Установить секреты
npx wrangler secret put GITHUB_TOKEN --config wrangler-webhook.toml
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler-webhook.toml

# Деплой webhook worker
npm run deploy:webhook
```

### 3. Настроить GitHub webhook

См. подробную инструкцию в [WEBHOOK_SETUP.md](./WEBHOOK_SETUP.md)

**Кратко:**
1. GitHub repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://rag-webhook-ingest.YOUR.workers.dev/webhook`
3. Content type: `application/json`
4. Secret: тот же, что в `GITHUB_WEBHOOK_SECRET`
5. Events: "Just the push event"

### 4. Подключить к Claude

**🔒 Важно:** MCP Server защищен токеном! Токен находится в файле `MCP_AUTH_TOKEN.txt`

```bash
# Токен из файла MCP_AUTH_TOKEN.txt
claude mcp add --transport http knowledge https://rag-mcp-server.exrector.workers.dev \
  --header "Authorization: Bearer e4e0b98b4c8cc0bd0fd4681655815eee16c941ae710455fbd00e58a7be795bca"
```

**Или для Claude Desktop** (`~/.claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "knowledge": {
      "type": "http",
      "url": "https://rag-mcp-server.exrector.workers.dev",
      "headers": {
        "Authorization": "Bearer e4e0b98b4c8cc0bd0fd4681655815eee16c941ae710455fbd00e58a7be795bca"
      }
    }
  }
}
```

## Что нужно

- GitHub репозиторий с документами (`.md`, `.txt`, `.mdx`, `.rst`)
- Cloudflare аккаунт (бесплатный)
- GitHub Personal Access Token (scope: `repo`)

## Архитектура (детали)

### Компоненты:

1. **Webhook Ingest Worker** (`src/webhook-ingest.ts`)
   - Принимает webhook от GitHub
   - Скачивает измененные файлы через GitHub API
   - Чанкает текст (512 слов, overlap 50)
   - Генерирует embeddings через Workers AI (`bge-m3`)
   - Сохраняет в D1 (полные тексты) и Vectorize (векторы)

2. **MCP Server Worker** (`src/index.ts`)
   - JSON-RPC 2.0 over HTTP
   - Semantic search через Vectorize
   - Получение полных текстов из D1
   - Интеграция с Claude Desktop/Code

3. **D1 Database** (`schema.sql`)
   - `documents` — метаданные файлов
   - `chunks` — полные тексты чанков
   - `sync_log` — история синхронизаций

4. **Vectorize Index** (`myrag-index`)
   - Векторы (1024-dim от `bge-m3`)
   - Легкие метаданные (chunk_id, topic, file_path)

### Правильная архитектура RAG (best practice):

- **D1:** Хранит полные тексты чанков, метаданные документов
- **Vectorize:** Только векторы + минимальные метаданные (chunk_id для ссылки на D1)
- **Workers AI:** Нативная генерация embeddings на edge
- **Workflow:** Vectorize.query() → получить chunk_ids → D1.select() → получить тексты

## Файлы

- `src/webhook-ingest.ts` — автоматическая обработка GitHub webhook
- `src/index.ts` — MCP Server для Claude
- `schema.sql` — схема D1 базы данных
- `wrangler.toml` — конфигурация MCP сервера
- `wrangler-webhook.toml` — конфигурация webhook worker
- `WEBHOOK_SETUP.md` — подробная инструкция по настройке webhook

## Переменные окружения

### Секреты Cloudflare (для webhook worker):

```bash
# GitHub Personal Access Token
npx wrangler secret put GITHUB_TOKEN --config wrangler-webhook.toml

# Webhook secret для проверки подписи
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler-webhook.toml
```

### Опционально (для MCP Server):

```bash
# Защита MCP endpoint
npx wrangler secret put MCP_AUTH_TOKEN
```

## Структура GitHub репозитория

```
myRAG/
├── programming/
│   ├── python.md
│   └── javascript.md
├── notes/
│   ├── ideas.md
│   └── anamnez.md
└── README.md
```

Структура папок = темы в RAG (`topic` метаданные).

## Использование

После подключения к Claude:

```
Найди документы о Python

Покажи все заметки по программированию

Что говорится о machine learning?

Найди информацию из книги "Анамнез"
```

## MCP Tool: search_knowledge

Параметры:
- `query` (обязательный) — текст запроса
- `limit` (опционально) — количество результатов (default: 5, max: 20)
- `topic` (опционально) — фильтр по папке
- `min_score` (опционально) — порог релевантности (default: 0.7)

## Технические детали

- **Embedding модель:** `@cf/baai/bge-m3` (1024 dimensions, 100+ языков)
- **D1 Database:** SQLite база для полных текстов и метаданных
- **Vectorize metric:** cosine similarity
- **Chunking:** 512 слов, overlap 50 слов
- **MCP Protocol:** JSON-RPC 2.0 over HTTP
- **Архитектурный паттерн:** Vectorize (chunk_id) → D1 (full text)

## Стоимость (Cloudflare Free Tier)

**Полностью бесплатно:**

- **Webhook Worker:** 100,000 requests/day
- **Workers AI (bge-m3):** 10,000 neurons/day (~850 файлов/день)
- **MCP Server Worker:** 100,000 requests/day
- **D1 Database:** 5 GB storage, 100,000 rows read/day
- **Vectorize:** 30M queries/month, 100,000 vectors

**Для личного использования этого более чем достаточно!** 🎉

## Обновление данных

**Автоматически!** Просто сделайте push в GitHub:

1. Добавьте/измените `.md` файл (с iPhone, Mac, где угодно)
2. Commit + Push
3. GitHub Webhook → Cloudflare Worker
4. За 1-3 секунды файл обработан и доступен в поиске

**Никаких ручных команд!**

## Мониторинг

### Health check webhook worker:

```bash
curl https://rag-webhook-ingest.YOUR.workers.dev/health
```

### Health check MCP server:

```bash
curl https://rag-mcp-server.YOUR.workers.dev/health
```

### Проверка векторов:

```bash
npx wrangler vectorize get myrag-index
```

### Проверка D1:

```bash
npx wrangler d1 execute myrag-metadata --command "SELECT COUNT(*) FROM chunks"
```

### Логи в реальном времени:

```bash
# Webhook worker
npx wrangler tail rag-webhook-ingest --config wrangler-webhook.toml

# MCP server
npx wrangler tail rag-mcp-server
```

## Troubleshooting

**Webhook не работает:**
- Проверьте URL: `https://rag-webhook-ingest.YOUR.workers.dev/webhook`
- Проверьте secret в GitHub webhook совпадает с `GITHUB_WEBHOOK_SECRET`
- Проверьте логи: `npx wrangler tail rag-webhook-ingest --config wrangler-webhook.toml`

**Поиск не находит файлы:**
- Снизьте `min_score` (default: 0.7 → попробуйте 0.5)
- Проверьте в D1 есть данные: `npx wrangler d1 execute myrag-metadata --command "SELECT COUNT(*) FROM chunks"`

**401 Unauthorized в MCP:**
- Если установлен `MCP_AUTH_TOKEN`, добавьте его в Claude конфигурацию

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

(Authorization опционален, только если установлен `MCP_AUTH_TOKEN`)

## Миграция со старой версии (GitHub Actions)

Если у вас была версия с GitHub Actions:

1. Удалите `.github/workflows/sync-rag.yml` из репозитория myRAG
2. Настройте GitHub webhook (см. WEBHOOK_SETUP.md)
3. Готово! Новые файлы будут обрабатываться через Cloudflare Worker

## Архитектура до vs после

### ❌ Старая (v1.0, GitHub Actions):

```
GitHub Push → GitHub Actions (10-30 сек)
  → Node.js script
  → Cloudflare REST API (через интернет)
  → D1 + Vectorize
```

### ✅ Новая (v2.0, Cloudflare Worker):

```
GitHub Push → Webhook (<1 сек)
  → Cloudflare Worker (edge)
  → Workers AI (native)
  → D1 + Vectorize (native)
```

**В 10-30 раз быстрее, полностью на Cloudflare!**

## License

MIT
