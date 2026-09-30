# Публичный хост: дашборд + API

Пример: `https://neyra.owyx.site`

| Поверхность | Публичный URL | Конфиг |
|-------------|---------------|--------|
| Дашборд | `https://neyra.owyx.site/` | `dashboard.public_base_url` (или наследует `api.public_base_url`) |
| API | `https://neyra.owyx.site/api/v1/...` | `api.public_base_url` + `api.public_path_prefix` (`/api`) |

В **example** оба публичных URL **пустые** (только localhost). Заполняйте, когда есть реальный DNS — yaml или env (`API_PUBLIC_BASE_URL`, опционально `DASHBOARD_PUBLIC_BASE_URL`).

Приложение слушает `127.0.0.1:8787`. TLS и префикс `/api` — на reverse proxy.

## DNS (пример Cloudflare)

DNS **не** настраивается в yaml Нейры — только у провайдера DNS. В конфиге пишется уже настроенный домен.

1. Домен в Cloudflare → DNS.
2. Запись **A** (или **AAAA**):
   - **Name:** `neyra` (получится `neyra.owyx.site`)
   - **IPv4:** публичный IP VPS с Нейрой
   - **Proxy:** сначала DNS only (серое облако); orange cloud — когда TLS настроен.
3. После пропагации в `server/config/server.yaml` или `.env`:

```yaml
api:
  public_base_url: "https://neyra.owyx.site"
  public_path_prefix: "/api"
dashboard:
  public_base_url: ""   # пусто = тот же host, что у api
```

```env
API_PUBLIC_BASE_URL=https://neyra.owyx.site
API_TOKEN=...   # или API_KEY=... (admin Bearer); обязателен при bind не loopback
```

4. На VPS: снаружи только 80/443; uvicorn на localhost; Caddy/nginx ниже.

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

WebSocket для `/api/v1/ws/chat` без доп. настроек. Предпочтительно `Authorization: Bearer`; `?token=` — fallback (маскируйте `token` в access-логах).

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

Слеш в конце `proxy_pass` у `/api/` снимает префикс `/api/`.

## Перед выходом в интернет

- `API_TOKEN` или `API_KEY` (+ viewer/maint) в `server/.env`.
- TLS на edge.
- Firewall: снаружи 80/443; uvicorn на localhost.
- `api.public_*` / `dashboard.public_base_url` = реальный DNS (в example по умолчанию пусто).
- Uvicorn: `proxy_headers=True`, `forwarded_allow_ips=127.0.0.1`.

Деплой процесса на VPS — этап 4 / ops.
