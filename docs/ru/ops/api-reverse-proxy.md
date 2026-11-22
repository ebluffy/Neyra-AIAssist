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

Схема, `frpc.toml` и требования к токенам — [`docs/PLAN.md`](../../PLAN.md) §9.

## DNS (пример Cloudflare)

DNS **не** в yaml Нейры — у провайдера.

1. Cloudflare DNS зоны (например `owyx.site`).
2. Запись **A**: Name `neyra` → IP **VPS**.
3. Прописать `api.public_base_url` в `server/config/server.yaml`.
4. На VPS: снаружи **80/443**; поднять **frps + Caddy/nginx**. Порт `:8787` домашнего сервера в интернет **не** открывать.
5. Токены — в `server/.env` на домашнем сервере (`API_TOKEN` / `API_KEY`); публичный URL — в yaml.

## Caddy (frp — upstream = vhost frps)

Подставьте upstreams ядра и сайта. Публичный префикс `/api` снимается только для `/api/v1/*`; `/api/auth/*` и BFF сайта сохраняют его.

```caddy
neyra.owyx.site {
  encode gzip
  # CORE_UPSTREAM — frps HTTP vhost ядра (8787), WEB_UPSTREAM — сайта (3000).
  # /api/v1 — ядро; /api снимает публичный префикс.
  handle /api/v1/* {
    uri strip_prefix /api
    reverse_proxy CORE_UPSTREAM
  }
  # Better Auth callback должен остаться на сайте, без срезания /api.
  handle /api/auth/* {
    reverse_proxy WEB_UPSTREAM
  }
  # BFF чата/вложений и UI сайта.
  handle /api/* {
    reverse_proxy WEB_UPSTREAM
  }
  handle {
    reverse_proxy WEB_UPSTREAM
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

API доверяет `CF-Connecting-IP` / `X-Real-IP` **только** когда socket peer = loopback (типичный frpc→uvicorn), и **игнорирует** edge-значение, если оно само loopback (`127.0.0.1` / `::1`). Сырой `X-Forwarded-For` от клиента **не** читается: uvicorn `proxy_headers=False`, HTTP RPM и login rate-limit используют тот же `resolve_client_ip`. `POST /v1/dashboard/auth/setup` без Bearer разрешён только с **консольного** loopback (peer local **и** нет CF/X-Real) — подмена `CF-Connecting-IP: 127.0.0.1` не открывает setup. Smoke: неверный login с интернета → в логе ядра `dashboard login failed ip=<реальный клиент>`, не `127.0.0.1` и не подставной XFF.

```nginx
server {
  listen 443 ssl http2;
  server_name neyra.owyx.site;

  # Заголовки клиента — один include, чтобы не дублировать в каждом location.
  # include snippets/neyra-proxy-headers.conf;

  # Ядро: срезаем /api, WebSocket Upgrade проходит дальше.
  location /api/v1/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header CF-Connecting-IP $neyra_client_ip;
    proxy_set_header X-Real-IP $neyra_client_ip;
    proxy_set_header X-Forwarded-For $neyra_client_ip;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://CORE_UPSTREAM/;
  }

  # Better Auth callback — на сайт, префикс /api не срезается.
  location /api/auth/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://WEB_UPSTREAM;
  }

  # BFF чата/вложений и остальные /api сайта.
  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header CF-Connecting-IP $neyra_client_ip;
    proxy_set_header X-Real-IP $neyra_client_ip;
    proxy_set_header X-Forwarded-For $neyra_client_ip;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://WEB_UPSTREAM;
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
    proxy_pass http://WEB_UPSTREAM;
  }
```

Trailing slash у `proxy_pass` под `/api/v1/` снимает префикс `/api`; `/api/auth` и `/api/` сохраняют префикс.

### Smoke rate-limit / client IP (публичный хост)

После map: `POST /v1/dashboard/auth/login` с заведомо неверным ключом → **401**. В логе ядра на домашнем сервере должно быть:

`dashboard login failed ip=<реальный клиент>`

не `127.0.0.1`. На `neyra.owyx.site` smoke (2026-10-01) подтвердил реальный IP за Cloudflare/frp.

## Альтернатива: процесс Neyra на VPS (без frp)

Если uvicorn на том же VPS, что и Caddy/nginx, укажите upstream `127.0.0.1:8787` вместо порта frps. Это запасной стенд (демо / CI), не канон Этапа 3 для персонального ассистента — см. [`docs/PLAN.md`](../../PLAN.md) §3 и Этап 4.

## Перед выходом в интернет

- `API_TOKEN` или `API_KEY` в `server/.env` на домашнем сервере.
- TLS на edge VPS; firewall 80/443; `:8787` дома только через frpc (или localhost, если процесс на VPS).
- `api.public_base_url` совпадает с DNS (в examples по умолчанию пусто).
- Uvicorn: `proxy_headers=False` (peer = TCP; клиентский IP только через CF/X-Real в `resolve_client_ip`).
- Ключ доступа дашборда задан до публикации SPA (см. [web-ui](../architecture/web-ui.md)).
- Smoke WebSocket: `wss://neyra.owyx.site/api/v1/ws/chat` доходит до Control API.

## Текущая схема web v2 (2026-11-22)

- `/` и `/api/*` (кроме `/api/v1/*`) → сайт Next.js `127.0.0.1:3000`.
- `/api/auth/*` → сайт без срезания `/api`; redirect URI Discord: `https://neyra.owyx.site/api/auth/callback/discord`.
- `/api/v1/*` → ядро `127.0.0.1:8787` со срезанием `/api`.
- WSS приложения: `wss://neyra.owyx.site/api/v1/ws/chat`, проверено 2026-11-22.
- `/legacy` остаётся на сайте до отдельного решения владельца.
