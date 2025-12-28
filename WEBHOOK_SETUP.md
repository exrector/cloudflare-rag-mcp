# GitHub Webhook Setup

## Полностью автоматическая синхронизация через Cloudflare Worker

Вместо GitHub Actions, теперь используется **Cloudflare Worker**, который получает webhook от GitHub и обрабатывает файлы на edge.

## 🚀 Преимущества новой архитектуры:

- ⚡ **В 10-30 раз быстрее** — файлы обрабатываются за 1-3 секунды вместо 10-30 секунд
- 🌍 **Многоязычные embeddings** — модель `bge-m3` поддерживает 100+ языков (включая русский)
- 🔒 **Безопаснее** — токены хранятся в Cloudflare Workers secrets, не в GitHub
- 💰 **Бесплатно** — 100,000 webhook запросов/день на Cloudflare Free tier
- 🎯 **Нативный доступ** — прямой доступ к Workers AI, D1, Vectorize без REST API

## Шаг 1: Установить секреты в Cloudflare Worker

```bash
cd ~/cloudflare-rag-mcp

# GitHub Personal Access Token (scope: repo)
npx wrangler secret put GITHUB_TOKEN --config wrangler-webhook.toml

# Webhook secret (любая случайная строка, запомните её!)
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler-webhook.toml
```

**Для GITHUB_TOKEN:**
1. Перейдите на https://github.com/settings/tokens
2. Generate new token (classic)
3. Выберите scope: `repo` (Full control of private repositories)
4. Скопируйте токен

**Для GITHUB_WEBHOOK_SECRET:**
Любая случайная строка, например: `my-super-secret-webhook-key-12345`

## Шаг 2: Задеплоить webhook worker

```bash
npm run deploy:webhook
```

После деплоя вы получите URL вида:
```
https://rag-webhook-ingest.YOUR-SUBDOMAIN.workers.dev
```

**Запомните этот URL!** Он понадобится для настройки webhook в GitHub.

## Шаг 3: Настроить webhook в GitHub репозитории

### В репозитории myRAG:

1. Перейдите в Settings → Webhooks → Add webhook

2. Заполните форму:
   - **Payload URL:** `https://rag-webhook-ingest.YOUR-SUBDOMAIN.workers.dev/webhook`
   - **Content type:** `application/json`
   - **Secret:** тот же самый secret, что вы ввели в `GITHUB_WEBHOOK_SECRET`
   - **Which events?** → "Just the push event"
   - **Active:** ✅ (включено)

3. Нажмите "Add webhook"

## Шаг 4: Тестирование

### Проверка health endpoint:

```bash
curl https://rag-webhook-ingest.YOUR-SUBDOMAIN.workers.dev/health
```

Должно вернуть:
```json
{
  "status": "ok",
  "service": "GitHub Webhook Ingest Worker",
  "version": "2.0.0"
}
```

### Тест через GitHub:

1. Добавьте новый `.md` файл в репозиторий myRAG (с iPhone или компьютера)
2. Сделайте commit и push
3. Перейдите в Settings → Webhooks → Recent Deliveries
4. Проверьте последний запрос:
   - Response code должен быть `200`
   - Response body должен показать обработанные файлы

### Проверка в Cloudflare:

```bash
# Проверить количество векторов
CLOUDFLARE_API_TOKEN=your_token CLOUDFLARE_ACCOUNT_ID=your_id \
  npx wrangler vectorize get myrag-index

# Проверить D1 базу
CLOUDFLARE_API_TOKEN=your_token CLOUDFLARE_ACCOUNT_ID=your_id \
  npx wrangler d1 execute myrag-metadata --command "SELECT COUNT(*) FROM chunks"
```

## Шаг 5: Удалить старый GitHub Actions workflow (опционально)

Если у вас был `.github/workflows/sync-rag.yml` в репозитории myRAG:

```bash
# В репозитории myRAG
rm .github/workflows/sync-rag.yml
git add .github/workflows/sync-rag.yml
git commit -m "Remove old GitHub Actions workflow, using Cloudflare webhook now"
git push
```

## Архитектура (новая):

```
iPhone/Mac
    ↓
GitHub Push (myRAG repo)
    ↓
GitHub Webhook (<1 сек)
    ↓
Cloudflare Worker (webhook-ingest)
  ├─ Verify HMAC signature
  ├─ Fetch changed files (GitHub API)
  ├─ Chunk text (512 words)
  ├─ Generate embeddings (Workers AI bge-m3, native)
  ├─ Save to D1 (full text, native)
  └─ Save to Vectorize (vectors + metadata, native)
    ↓
MCP Server (rag-mcp-server)
  ├─ Query Vectorize (semantic search)
  └─ Fetch from D1 (full text)
    ↓
Claude Desktop / Claude Code
```

## Troubleshooting

### Webhook не работает (404 error)

Проверьте:
1. URL правильный: `/webhook` в конце
2. Worker задеплоен: `npm run deploy:webhook`

### Unauthorized (401 error)

Проверьте:
1. `GITHUB_WEBHOOK_SECRET` совпадает в Cloudflare и GitHub
2. В настройках webhook в GitHub указан правильный secret

### Files not processed

Проверьте:
1. Файлы имеют расширение `.md`, `.txt`, `.mdx`, `.rst`
2. Файлы не в исключенных папках (`.git`, `.github`, `node_modules`)
3. В логах worker (wrangler tail) нет ошибок

### Проверка логов:

```bash
# Реальные логи webhook worker
npx wrangler tail rag-webhook-ingest --config wrangler-webhook.toml
```

Сделайте push в GitHub и наблюдайте за логами в реальном времени.

## Мониторинг

### Cloudflare Dashboard:

- **Workers:** https://dash.cloudflare.com/YOUR_ACCOUNT_ID/workers/overview
- **Vectorize:** https://dash.cloudflare.com/YOUR_ACCOUNT_ID/vectorize
- **D1:** https://dash.cloudflare.com/YOUR_ACCOUNT_ID/d1

### GitHub Webhook Deliveries:

Settings → Webhooks → Recent Deliveries — видно все запросы и ответы

## Стоимость (Free Tier)

- **Webhook Worker:** 100,000 requests/day ✅
- **Workers AI (bge-m3):** 10,000 neurons/day ✅
- **D1 Database:** 100,000 rows read/day ✅
- **Vectorize:** 30M queries/month ✅

**Вывод:** Полностью бесплатно для личного использования! 🎉
