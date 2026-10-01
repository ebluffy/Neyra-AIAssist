# Request examples

Local base: `http://127.0.0.1:8787`. Public example base: `https://neyra.owyx.site/api/v1`.

## Chat

```bash
curl -X POST http://127.0.0.1:8787/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"text":"Hello","username":"demo"}'
```

## Enable a plugin

```bash
curl -X PATCH http://127.0.0.1:8787/v1/plugins/discord \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"enabled":true}'
```

## Create outbound webhook route

```bash
curl -X POST http://127.0.0.1:8787/v1/webhooks/out/routes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"event_type":"chat.turn_completed","target_url":"https://example.com/hook","enabled":true}'
```
