# Reverse proxy для публичного Neyra API

Публичный URL: `https://neyra.owyx.site/api/v1/...`

Приложение слушает `127.0.0.1:8787`, маршруты `/v1` (`api.host` / `api.port` в `server/config/server.yaml`).
Публичные поля: `api.public_base_url` + `api.public_path_prefix` (по умолчанию `https://neyra.owyx.site` + `/api`).

## Caddy

```caddy
neyra.owyx.site {
  encode gzip
  handle_path /api/* {
    reverse_proxy 127.0.0.1:8787
  }
}
```

`handle_path` снимает `/api`: `/api/v1/health` → `/v1/health` на бэкенде.
WebSocket для `/api/v1/ws/chat` проходит без доп. настроек.

## nginx

```nginx
server {
  listen 443 ssl http2;
  server_name neyra.owyx.site;
  # ssl_certificate ...;

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
}
```

Слеш в конце `proxy_pass` убирает префикс `/api/`.

## Перед выходом в интернет

- Задать `API_TOKEN` / viewer / maint в `server/.env` (не оставлять анонимный API).
- TLS на edge.
- Firewall: снаружи только 80/443; uvicorn на localhost.
- Согласовать `api.public_*` с реальным DNS.

Деплой процесса на VPS — этап 4 / ops; для Stage 2 достаточно этого recipe.
