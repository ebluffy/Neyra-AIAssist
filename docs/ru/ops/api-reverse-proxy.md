# Публичный хост: дашборд + API

Пример: `https://neyra.owyx.site`

| Поверхность | Публичный URL | Конфиг |
|-------------|---------------|--------|
| Дашборд | `https://neyra.owyx.site/` | **тот же** `api.public_base_url` |
| API | `https://neyra.owyx.site/api/v1/...` | `api.public_base_url` + `api.public_path_prefix` (`/api`) |

Настройка **только** в `server/config/server.yaml` (не через `.env`). В example поле пустое (localhost).

```yaml
# server/config/server.yaml
api:
  public_base_url: "https://neyra.owyx.site"
  public_path_prefix: "/api"
```

Приложение слушает `127.0.0.1:8787`. TLS — на reverse proxy.

## DNS (пример Cloudflare)

DNS **не** в yaml Нейры — у провайдера. В конфиге — уже настроенный домен.

1. Cloudflare DNS зоны (например `owyx.site`).
2. Запись **A**: Name `neyra` → IP VPS.
3. Прописать `api.public_base_url` в `server/config/server.yaml`.
4. На VPS: снаружи 80/443; uvicorn на localhost; Caddy/nginx.
5. Токены — в `server/.env` (`API_TOKEN` / `API_KEY`); публичный URL — в yaml.

## frp (мини-ПК + VPS) — Этап 3

Канон для `neyra.owyx.site`: процесс Neyra на **мини-ПК**, наружу через **frpc** → **frps** на VPS → **Caddy** или nginx (TLS). Память (`server/data/memory/`), `server/.env`, логи и модели остаются на мини-ПК; на VPS — только reverse proxy и frps, **без** копирования runtime-данных.

Цепочка: клиент → `https://neyra.owyx.site` / `wss://neyra.owyx.site/api/v1/ws/chat` → TLS на VPS → frps → frpc → Control API `127.0.0.1:8787`.

Пример `frpc.toml`, чеклист и требования к токенам — [`docs/PLAN.md`](../../PLAN.md) §3.

## Caddy

```caddy
neyra.owyx.site {
  encode gzip
  handle_path /api/* {
    reverse_proxy 127.0.0.1:8787
  }
  handle {
    reverse_proxy 127.0.0.1:8787
  }
}
```

WebSocket для `/api/v1/ws/chat`. Предпочтительно Bearer; `?token=` — маскируйте в access-логах.

## nginx

```nginx
server {
  listen 443 ssl http2;
  server_name neyra.owyx.site;

  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://127.0.0.1:8787/;
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:8787;
  }
}
```

Trailing slash у `proxy_pass` под `/api/` снимает префикс `/api/`.

## Перед выходом в интернет

- `API_TOKEN` или `API_KEY` в `server/.env`.
- TLS на edge; firewall 80/443; uvicorn только на localhost.
- `api.public_base_url` совпадает с DNS (в examples по умолчанию пусто).
- Uvicorn: `proxy_headers=True`, `forwarded_allow_ips=127.0.0.1`.

Полный деплой процесса Neyra на VPS (без frp) — Этап 4 / ops; для персонального ассистента предпочтителен сценарий мини-ПК + frp.
