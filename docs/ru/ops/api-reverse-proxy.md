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

1. Cloudflare DNS зоны.
2. Запись **A**: Name `neyra`, IP VPS.
3. Прописать `api.public_base_url` в `server/config/server.yaml`.
4. На VPS: снаружи 80/443; uvicorn на localhost; Caddy/nginx.
5. Токены — в `.env`; публичный URL — в yaml.

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

## Перед выходом в интернет

- `API_TOKEN` или `API_KEY` в `.env`.
- TLS на edge; firewall 80/443.
- `api.public_base_url` = реальный DNS.

Деплой процесса на VPS — этап 4 / ops.
