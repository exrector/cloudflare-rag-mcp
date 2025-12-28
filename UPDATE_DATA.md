# Обновление данных из GitHub

## Текущий процесс (вручную)

После любых изменений в GitHub репозитории:

```bash
cd ~/cloudflare-rag-mcp
npm run ingest
```

**Время обновления:**
- Скачивание из GitHub: ~5-10 сек
- Создание embeddings: ~1-2 сек на файл
- Загрузка в Vectorize: ~5 сек
- Индексация Vectorize: ~30-60 сек
- **Итого: ~1-2 минуты** от запуска до доступности в поиске

## Автоматизация (опционально)

### GitHub Actions для авто-обновления

Создайте `.github/workflows/sync-rag.yml` в вашем репозитории myRAG:

```yaml
name: Sync RAG Database

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: exrector/cloudflare-rag-mcp
          token: ${{ secrets.GH_PAT }}
      
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: cd ingest && npm install
      
      - name: Run ingest
        env:
          GITHUB_TOKEN: ${{ secrets.GH_PAT }}
          GITHUB_REPO: exrector/myRAG
          GITHUB_BRANCH: main
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
        run: cd ingest && node ingest.js
```

**GitHub Secrets для настройки:**
- `GH_PAT` - ваш GitHub token
- `CF_ACCOUNT_ID` - c1a12d6a421765d2ae66bd1ff3fa0e1f
- `CF_API_TOKEN` - crMqprIlCOPe0ltYjWVGC3ex18n9BI_eOZ8oiUxD

После этого каждый push в myRAG автоматически обновит RAG базу.

## Проверка статуса

```bash
# Проверить количество векторов
export CLOUDFLARE_API_TOKEN=crMqprIlCOPe0ltYjWVGC3ex18n9BI_eOZ8oiUxD
export CLOUDFLARE_ACCOUNT_ID=c1a12d6a421765d2ae66bd1ff3fa0e1f
npx wrangler vectorize get myrag-index
```
