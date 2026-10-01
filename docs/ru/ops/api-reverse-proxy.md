# Публичный хост: дашборд + API

Пример: `https://neyra.owyx.site`

| Поверхность | Публичный URL | Конфиг |
|-------------|---------------|--------|
| Дашборд | `https://neyra.owyx.site/` | **тот же** `api.public_base_url` |
| REST API | `https://neyra.owyx.site/api/v1/...` | `api.public_base_url` + `api.public_path_prefix` (`/api`) |
| WebSocket-чат | `wss://neyra.owyx.site/api/v1/ws/chat` | тот же prefix + Upgrade через прокси |

Настройка **только** в `server/config/server.yaml` (не через `.env`). В example поле пустое (localhost).

```yaml
# server/config/server.yaml
api:
  public_base_url: "https://neyra.owyx.site"
  public_path_prefix: "/api"
```

Neyra слушает `127.0.0.1:8787` на машине, где крутится процесс. Публичный TLS — на edge VPS.

## Канон: домашний сервер + frp (Этап 3)

**Домашний сервер** — любой домашний хост с Neyra: мини-ПК, старый ПК, ноутбук, VM на NAS и т.п.

1. Neyra + **frpc** на домашнем сервере (`127.0.0.1:8787`).
2. **frps** на VPS (HTTP vhost, пример порта `8080`).
3. **Caddy** или nginx на VPS: TLS для `neyra.owyx.site` → reverse-proxy на **vhost frps**, не на `:8787`.
4. Память, `server/.env`, логи, модели остаются на домашнем сервере; на VPS — только прокси и frps.

Цепочка: клиент → `https://` / `wss://neyra.owyx.site/api/v1/ws/chat` → TLS на VPS → frps → frpc → Control API `127.0.0.1:8787`.

Схема, `frpc.toml` и требования к токенам — [`docs/PLAN.md`](../../PLAN.md) §3.

## DNS (пример Cloudflare)

DNS **не** в yaml Нейры — у провайдера.

1. Cloudflare DNS зоны (например `owyx.site`).
2. Запись **A**: Name `neyra` → IP **VPS**.
3. Прописать `api.public_base_url` в `server/config/server.yaml`.
4. На VPS: снаружи **80/443**; поднять **frps + Caddy/nginx**. Порт `:8787` домашнего сервера в интернет **не** открывать.
5. Токены — в `server/.env` на домашнем сервере (`API_TOKEN` / `API_KEY`); публичный URL — в yaml.

## Caddy (frp — upstream = vhost frps)

Подставьте свой порт HTTP vhost frps вместо `8080`. `handle_path /api/*` снимает публичный префикс `/api`, чтобы приложение видело `/v1/...`.

```caddy
neyra.owyx.site {
  encode gzip
  # Upstream = HTTP vhost frps на этом VPS (НЕ локальный uvicorn :8787)
  handle_path /api/* {
    reverse_proxy 127.0.0.1:8080
  }
  handle {
    reverse_proxy 127.0.0.1:8080
  }
}
```

WebSocket для `/api/v1/ws/chat`. Предпочтительно Bearer; `?token=` — маскируйте в access-логах.

## nginx (frp — upstream = vhost frps)

За Cloudflare (orange-cloud) edge должен **перезаписывать** клиентский IP и прокидывать его в frp:

```nginx
map $http_cf_connecting_ip $neyra_client_ip {
    ""      $remote_addr;
    default $http_cf_connecting_ip;
}
```

В `location` (и `/api/`, и `/`):

```nginx
proxy_set_header CF-Connecting-IP $neyra_client_ip;
proxy_set_header X-Real-IP $neyra_client_ip;
proxy_set_header X-Forwarded-For $neyra_client_ip;
```

API доверяет `CF-Connecting-IP` / `X-Real-IP` **только** когда socket peer = loopback (типичный frpc→uvicorn). Сырой `X-Forwarded-For` от клиента не читается. Smoke: неверный login с интернета → в логе ядра `dashboard login failed ip=<реальный клиент>`, не `127.0.0.1` и не подставной XFF.

```nginx
server {
  listen 443 ssl http2;
  server_name neyra.owyx.site;

  # Upstream = HTTP vhost frps (пример :8080), не uvicorn :8787
  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header CF-Connecting-IP $neyra_client_ip;
    proxy_set_header X-Real-IP $neyra_client_ip;
    proxy_set_header X-Forwarded-For $neyra_client_ip;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://127.0.0.1:8080/;
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header CF-Connecting-IP $neyra_client_ip;
    proxy_set_header X-Real-IP $neyra_client_ip;
    proxy_set_header X-Forwarded-For $neyra_client_ip;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://127.0.0.1:8080;
  }
}
```

Trailing slash у `proxy_pass` под `/api/` снимает префикс `/api`.

## Альтернатива: процесс Neyra на VPS (без frp)

Если uvicorn на том же VPS, что и Caddy/nginx, укажите upstream `127.0.0.1:8787` вместо порта frps. Это запасной стенд (демо / CI), не канон Этапа 3 для персонального ассистента — см. [`docs/PLAN.md`](../../PLAN.md) §3 и Этап 4.

## Перед выходом в интернет

- `API_TOKEN` или `API_KEY` в `server/.env` на домашнем сервере.
- TLS на edge VPS; firewall 80/443; `:8787` дома только через frpc (или localhost, если процесс на VPS).
- `api.public_base_url` совпадает с DNS (в examples по умолчанию пусто).
- Uvicorn: `proxy_headers=True`, `forwarded_allow_ips` ограничен hop прокси/frp.
- Ключ доступа дашборда задан до публикации SPA (см. [web-ui](../architecture/web-ui.md)).
- Smoke WebSocket: `wss://neyra.owyx.site/api/v1/ws/chat` доходит до Control API.
