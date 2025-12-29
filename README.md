# Personal RAG Knowledge Base v3.0

Semantic search over your personal knowledge base using **GitHub Actions + Cloudflare** with direct HTTP connection to Claude Desktop.

## ✅ Правильная архитектура (v3.0)

```
GitHub Push (.md, .txt files)
  ↓
GitHub Actions (без CPU limits)
  - Чтение изменённых файлов
  - Создание chunks (512 слов, overlap 50)
  - Создание embeddings через Workers AI API
  - Удаление старых векторов перед реиндексацией
  - Сохранение в D1 + Vectorize через REST API
  ↓
Cloudflare Worker (HTTP MCP Server)
  - Semantic search через Vectorize
  - Получение текстов из D1
  - JSON-RPC 2.0 over HTTP
  ↓
Claude Desktop (прямое HTTP подключение)
  - Никаких мостов
  - Просто URL в конфиге
```

## Почему эта архитектура лучше?

| Критерий | v2.0 (Webhook Worker) | ✅ v3.0 (GitHub Actions) |
|----------|----------------------|-------------------------|
| CPU time limit | ❌ 10ms (падает на больших файлах) | ✅ Нет лимита (до 6 часов) |
| Память | ❌ 128 MB | ✅ 7 GB |
| Размер файлов | ❌ До ~50 chunks | ✅ Любой размер |
| Надёжность | ❌ Падает при перегрузке | ✅ 100% |
| Мост stdio-HTTP | ❌ Костыль | ✅ Прямое HTTP подключение |

## Быстрый старт

### 1. Добавить secrets в GitHub

Перейди в `https://github.com/exrector/myRAG/settings/secrets/actions` и добавь:

- `CLOUDFLARE_ACCOUNT_ID` = `c1a12d6a421765d2ae66bd1ff3fa0e1f`
- `CLOUDFLARE_API_TOKEN` = `crMqprIlCOPe0ltYjWVGC3ex18n9BI_eOZ8oiUxD`

### 2. Запушить workflow в GitHub

```bash
cd /Users/exrector/cloudflare-rag-mcp

git add .github/workflows/index-to-rag.yml
git add ingest-github-actions.js
git commit -m "Add GitHub Actions indexing v3.0"
git push
```

### 3. Проверить что workflow запустился

https://github.com/exrector/myRAG/actions

### 4. Перезапустить Claude Desktop

Конфиг автоматически настроен:
```json
{
  "mcpServers": {
    "knowledge-base": {
      "url": "https://rag-mcp-server.exrector.workers.dev/mcp"
    }
  }
}
```

Готово! Теперь можешь использовать `search_knowledge` в Claude.

## Использование

### В Claude Desktop

```
Найди информацию о Судной ночи

Что говорится о фестивале?

Покажи заметки по программированию
```

Claude автоматически использует твою базу знаний через tool `search_knowledge`.

### Через HTTP API

```bash
curl -X POST https://rag-mcp-server.exrector.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_knowledge",
      "arguments": {
        "query": "фестиваль",
        "limit": 5,
        "min_score": 0.3
      }
    }
  }'
```

## Как работает индексация

1. Ты пушишь .md или .txt файл в GitHub (с iPhone, Mac, где угодно)
2. GitHub Actions запускается через 10-30 секунд
3. `ingest-github-actions.js`:
   - Определяет изменённые файлы (`git diff-tree`)
   - Читает контент
   - Создаёт chunks (512 слов, overlap 50)
   - Создаёт embeddings через Cloudflare Workers AI API (`@cf/baai/bge-m3`, 1024-dim)
   - **Удаляет старые векторы** если файл уже существует (нет дубликатов!)
   - Сохраняет в D1 (полные тексты) + Vectorize (векторы)
4. Готово! Можешь искать через Claude Desktop

## Структура проекта

```
.github/workflows/
  index-to-rag.yml          # GitHub Actions workflow (триггер на push .md/.txt)
ingest-github-actions.js    # Скрипт индексации (Node.js ES modules)
src/
  mcp-server.ts             # HTTP MCP сервер (чистый, простой)
wrangler.toml               # Конфигурация Cloudflare Worker
schema.sql                  # Схема D1 базы данных
package.json                # Dependencies
```

## Файлы которые были удалены (больше не нужны)

- ❌ `mcp-stdio-bridge.cjs` - мост stdio↔HTTP (заменён на прямое HTTP)
- ❌ `src/webhook-ingest.ts` - webhook обработка (заменён на GitHub Actions)
- ❌ `src/index.ts` - старый MCP сервер (заменён на `src/mcp-server.ts`)
- ❌ `wrangler-webhook.toml` - конфиг webhook worker
- ❌ `reindex-all.js` - скрипт реиндексации

## Мониторинг

### Проверить GitHub Actions

```bash
open https://github.com/exrector/myRAG/actions
```

### Проверить логи MCP сервера

```bash
npx wrangler tail rag-mcp-server
```

### Проверить статистику D1

```bash
npx wrangler d1 execute myrag-metadata --remote --command \
  "SELECT COUNT(*) as docs FROM documents; SELECT COUNT(*) as chunks FROM chunks;"
```

### Проверить Vectorize

```bash
npx wrangler vectorize get myrag-index
```

## Что исправлено в v3.0

### Проблемы v2.0:
- ❌ Webhook worker падал с CPU timeout на файлах > 30 chunks
- ❌ stdio мост `mcp-stdio-bridge.cjs` - костыль
- ❌ Дубликаты векторов при реиндексации
- ❌ Плохая обработка ошибок

### Решения v3.0:
- ✅ GitHub Actions - нет CPU limits
- ✅ Прямое HTTP подключение к Claude Desktop
- ✅ Удаление старых векторов перед реиндексацией
- ✅ Батчинг embeddings по 5 для надёжности
- ✅ Правильная UTF-8 кодировка

## MCP Tool: search_knowledge

Параметры:
- `query` (обязательный) — текст запроса
- `limit` (опционально) — количество результатов (default: 5, max: 20)
- `min_score` (опционально) — порог релевантности (default: 0.7, min: 0)

Пример:
```json
{
  "name": "search_knowledge",
  "arguments": {
    "query": "Судная ночь фестиваль",
    "limit": 3,
    "min_score": 0.4
  }
}
```

## Технические детали

- **Embedding модель:** `@cf/baai/bge-m3` (1024 dimensions, 100+ языков)
- **D1 Database:** SQLite база для полных текстов и метаданных
- **Vectorize:** Cosine similarity, 1024-dim vectors
- **Chunking:** 512 слов, overlap 50 слов
- **MCP Protocol:** JSON-RPC 2.0 over HTTP
- **GitHub Actions:** 2000 минут/месяц бесплатно

## Лимиты Cloudflare Free Plan

- **Workers AI:** 10,000 embeddings/day (~850 файлов)
- **D1:** 5 GB storage, 5M reads/day, 100K writes/day
- **Vectorize:** 10M stored dimensions (~9,765 vectors), 5M queried/month
- **Workers (MCP Server):** 100,000 requests/day

**Текущее использование:** 11 documents, 47 chunks - всё ОК ✅

## Troubleshooting

### GitHub Actions не запускается

1. Проверь что secrets добавлены: https://github.com/exrector/myRAG/settings/secrets/actions
2. Проверь логи: https://github.com/exrector/myRAG/actions

### Claude Desktop не видит MCP сервер

1. Перезапусти Claude Desktop
2. Проверь конфиг: `~/Library/Application Support/Claude/claude_desktop_config.json`
3. Должен быть:
```json
{
  "mcpServers": {
    "knowledge-base": {
      "url": "https://rag-mcp-server.exrector.workers.dev/mcp"
    }
  }
}
```

### Поиск не находит документы

1. Проверь что файлы проиндексированы:
```bash
npx wrangler d1 execute myrag-metadata --remote --command "SELECT * FROM documents LIMIT 5;"
```

2. Снизь `min_score` с 0.7 до 0.3

### GitHub Actions упал с ошибкой

Проверь логи в https://github.com/exrector/myRAG/actions и запусти workflow вручную через UI.

## Roadmap

- [ ] Поддержка для ChatGPT Custom GPT (OpenAPI endpoint)
- [ ] Поддержка для Gemini Function Calling
- [ ] Web UI для просмотра индексированных документов
- [ ] Поддержка PDF файлов
- [ ] Фильтрация по папкам/топикам через UI

## License

MIT
