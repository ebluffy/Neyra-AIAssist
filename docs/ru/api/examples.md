<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Примеры запросов

## Chat
```bash
curl -X POST http://127.0.0.1:8787/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"text":"Привет","username":"demo"}'
```

## Включить плагин
```bash
curl -X PATCH http://127.0.0.1:8787/v1/plugins/discord \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

## Создать outbound webhook route
```bash
curl -X POST http://127.0.0.1:8787/v1/webhooks/out/routes \
  -H "Content-Type: application/json" \
  -d '{"event_type":"chat.turn_completed","target_url":"https://example.com/hook","enabled":true}'
```