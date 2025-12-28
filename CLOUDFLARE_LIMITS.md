# Cloudflare Free Tier Limits

## Текущее использование

Проверено: 2025-12-28

### Vectorize
- **Vectors в базе:** 4
- **Лимит Free tier:** 30 миллионов векторов
- **Queries лимит:** 30 миллионов queries/месяц
- **Статус:** ✅ Безопасно (0.00001% использовано)

### Workers AI (Embeddings)
- **Лимит Free tier:** 10,000 neurons/день
- **1 embedding = ~1 neuron**
- **Текущее использование:** ~4 embeddings (при ingest)
- **Статус:** ✅ Безопасно

### Workers (MCP Server)
- **Лимит Free tier:** 100,000 requests/день
- **Текущее использование:** Минимальное (только ваши запросы)
- **Статус:** ✅ Безопасно

## Потенциальные риски

### ⚠️ GitHub Actions auto-sync может превысить лимиты если:

1. **Слишком частые commits**
   - Лимит: 10,000 embeddings/день
   - Если делать >10,000 файлов/день → превышение

2. **Большие файлы с множеством chunks**
   - 1 файл может = 10-20 chunks = 10-20 embeddings
   - Безопасно: до ~500 файлов/день

## Защита от превышения лимитов

### 1. Rate Limiting в GitHub Actions

Workflow уже настроен на запуск только при изменении файлов.

**Добавим ограничение на количество обработок:**

```yaml
# В .github/workflows/sync-rag.yml
concurrency:
  group: rag-sync
  cancel-in-progress: true  # Отменяет предыдущие запуски
```

### 2. Ограничение размера ingest

В `ingest/ingest.js` уже есть:
- `minChunkSize: 1` - минимальный размер chunk
- `chunkSize: 512` - максимальный размер chunk

**Для дополнительной защиты:**

```javascript
// Максимум файлов за один ingest
const MAX_FILES_PER_RUN = 100;

// Максимум embeddings за один ingest
const MAX_EMBEDDINGS_PER_RUN = 500;
```

### 3. Monitoring

Проверить использование:

```bash
# Workers AI usage
curl "https://api.cloudflare.com/client/v4/accounts/c1a12d6a421765d2ae66bd1ff3fa0e1f/ai-gateway/usage" \
  -H "Authorization: Bearer crMqprIlCOPe0ltYjWVGC3ex18n9BI_eOZ8oiUxD"

# Vectorize queries
curl "https://api.cloudflare.com/client/v4/accounts/c1a12d6a421765d2ae66bd1ff3fa0e1f/vectorize/indexes/myrag-index/metrics" \
  -H "Authorization: Bearer crMqprIlCOPe0ltYjWVGC3ex18n9BI_eOZ8oiUxD"
```

## Рекомендации для безопасного использования

### ✅ Безопасные практики:

1. **Ограничьте частоту commits** с iPhone
   - Делайте batch commits (несколько файлов сразу)
   - Избегайте >50 commits/день

2. **Оптимизируйте размер файлов**
   - Файлы <10KB = 1-2 chunks = безопасно
   - Файлы >100KB = 20+ chunks = следите за лимитом

3. **Используйте manual ingest для больших загрузок**
   ```bash
   cd ~/cloudflare-rag-mcp
   npm run ingest  # Вручную когда нужно
   ```

4. **Мониторьте через Cloudflare Dashboard**
   - https://dash.cloudflare.com/c1a12d6a421765d2ae66bd1ff3fa0e1f/workers-and-pages
   - https://dash.cloudflare.com/c1a12d6a421765d2ae66bd1ff3fa0e1f/ai/workers-ai

### ⚠️ Что может превысить лимит:

1. ❌ Загрузка >500 файлов за день через auto-sync
2. ❌ Очень большие PDF файлы (>1MB)
3. ❌ Частые re-commits одних и тех же файлов

## Текущая оценка стоимости

**При вашем использовании (4 файла):**
- Стоимость: **$0.00/месяц** ✅
- Лимиты: Все в пределах Free tier

**При активном использовании (100 файлов/день):**
- Embeddings: ~100 файлов × 5 chunks = 500 embeddings/день
- Workers AI: 500/10,000 = 5% дневного лимита ✅
- Стоимость: **$0.00/месяц** ✅

**При экстремальном использовании (>10,000 embeddings/день):**
- Превышение Workers AI лимита
- Стоимость: ~$0.011 за 1000 embeddings сверх лимита
- Пример: 20,000 embeddings/день = 10,000 сверх = $0.11/день = **~$3.30/месяц**

## Вывод

✅ **Текущая настройка полностью в пределах Free tier**

✅ **Auto-sync безопасен** для нормального использования (до 100 commits/день)

⚠️ **Для защиты:** Добавлю ограничения в workflow и ingest script
