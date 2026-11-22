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
4. На VPS: **80/443 только для диапазонов Cloudflare** (https://www.cloudflare.com/ips/), если домен за orange-cloud; без Cloudflare — для всех. Поднять **frps + Caddy/nginx**. Порт `:8787` домашнего сервера в интернет **не** открывать.
5. Токены — в `server/.env` на домашнем сервере (`API_TOKEN` / `API_KEY`); публичный URL — в yaml.

### frpc: два HTTP-vhost

На домашнем сервере публикуются два proxy: ядро `8787` и сайт `3000`. На VPS edge различает их по `Host`:

```toml
[[proxies]]
name = "neyra-core"
type = "http"
localIP = "127.0.0.1"
localPort = 8787
customDomains = ["neyra-core-internal.owyx.site"]

[[proxies]]
name = "neyra-web"
type = "http"
localIP = "127.0.0.1"
localPort = 3000
customDomains = ["neyra-web-internal.owyx.site"]
```

`CORE_UPSTREAM`/`WEB_UPSTREAM` — адрес frps HTTP vhost на VPS (обычно `127.0.0.1:8080`), `CORE_HOST`/`WEB_HOST` — соответствующие `customDomains`. Если оба процесса на VPS: nginx — `proxy_set_header Host $host;`, Caddy — уберите строки `header_up Host …` (Caddy по умолчанию передаёт исходный Host). Ядро слушает `127.0.0.1:8787`, сайт — `127.0.0.1:3000`.

## Caddy (frp — upstream = vhost frps)

Подставьте upstreams ядра и сайта. Публичный префикс `/api` снимается только для `/api/v1/*`; `/api/auth/*` и BFF сайта сохраняют его. **80/443 должны быть закрыты диапазонами Cloudflare**, иначе `CF-Connecting-IP` можно подделать прямым запросом на IP VPS.

```caddy
neyra.owyx.site {
  encode gzip
  # CORE_UPSTREAM/WEB_UPSTREAM — адреса frps HTTP-vhost на VPS; дома localPort 8787/3000.
  # /api/v1 — ядро; /api снимает публичный префикс.
  handle /api/v1/* {
    uri strip_prefix /api
    reverse_proxy http://CORE_UPSTREAM {
      header_up Host CORE_HOST
      header_up X-Real-IP {http.request.header.CF-Connecting-IP}
    }
  }
  # Better Auth callback должен остаться на сайте, без срезания /api.
  handle /api/auth/* {
    reverse_proxy http://WEB_UPSTREAM {
      header_up Host WEB_HOST
      header_up X-Real-IP {http.request.header.CF-Connecting-IP}
    }
  }
  # BFF чата/вложений и UI сайта.
  handle /api/* {
    reverse_proxy http://WEB_UPSTREAM {
      header_up Host WEB_HOST
      header_up X-Real-IP {http.request.header.CF-Connecting-IP}
    }
  }
  handle {
    reverse_proxy http://WEB_UPSTREAM {
      header_up Host WEB_HOST
      header_up X-Real-IP {http.request.header.CF-Connecting-IP}
    }
  }
}
```

WebSocket для `/api/v1/ws/chat`. Предпочтительно Bearer; `?token=` — маскируйте в access-логах. Без Cloudflare замените `X-Real-IP` на `{remote_host}` и добавьте `header_up -CF-Connecting-IP`, чтобы клиент не подставил чужой адрес.

## nginx (frp — upstream = vhost frps)

За Cloudflare (orange-cloud) edge должен **перезаписывать** клиентский IP и прокидывать его в frp. **Обязательно** закрыть 80/443 на VPS диапазонами Cloudflare; иначе заголовок `CF-Connecting-IP` можно подделать, придя на IP VPS напрямую. Список: https://www.cloudflare.com/ips/.

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
    proxy_set_header Host CORE_HOST;
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
    proxy_set_header Host WEB_HOST;
    proxy_set_header CF-Connecting-IP $neyra_client_ip;
    proxy_set_header X-Real-IP $neyra_client_ip;
    proxy_set_header X-Forwarded-For $neyra_client_ip;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://WEB_UPSTREAM;
  }

  # BFF чата/вложений и остальные /api сайта.
  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Host WEB_HOST;
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
    proxy_set_header Host WEB_HOST;
    proxy_set_header CF-Connecting-IP $neyra_client_ip;
    proxy_set_header X-Real-IP $neyra_client_ip;
    proxy_set_header X-Forwarded-For $neyra_client_ip;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://WEB_UPSTREAM;
  }
}
```

Trailing slash у `proxy_pass` под `/api/v1/` снимает префикс `/api`; `/api/auth` и `/api/` сохраняют префикс.

### Smoke rate-limit / client IP (публичный хост)

После map: `POST /v1/dashboard/auth/login` с заведомо неверным ключом → **401**. В логе ядра на домашнем сервере должно быть:

`dashboard login failed ip=<реальный клиент>`

не `127.0.0.1`. На `neyra.owyx.site` smoke (2026-10-01) подтвердил реальный IP за Cloudflare/frp. Проверка подделки:

```bash
curl -sk --resolve neyra.owyx.site:443:<IP VPS> -X POST \
  https://neyra.owyx.site/api/v1/dashboard/auth/login \
  -H 'Content-Type: application/json' -H 'CF-Connecting-IP: 203.0.113.7' \
  -d '{"key":"smoke-wrong-key"}'
```

Ожидание: `401 unauthorized` и в логе ядра `dashboard login failed ip=<твой реальный IP>`, но не `203.0.113.7`. Ключ дашборда должен быть задан (иначе `400 setup_required`), а повторный smoke без паузы может дать `429 rate_limited` — оба ответа означают, что проверка не состоялась. За Cloudflare прямой запрос к `/api/v1/health/live` на IP VPS должен не соединяться (200 = firewall не настроен); без Cloudflare соединение нормально, смотри только IP в логе.

## Альтернатива: процесс Neyra на VPS (без frp)

Если оба процесса на VPS, укажите для `/api/v1/*` upstream `127.0.0.1:8787`, для остального — `127.0.0.1:3000`. Это запасной стенд (демо / CI), не канон Этапа 3 для персонального ассистента — см. [`docs/PLAN.md`](../../PLAN.md) §3 и Этап 4.

## Перед выходом в интернет

- `API_TOKEN` или `API_KEY` в `server/.env` на домашнем сервере.
- TLS на edge VPS. За Cloudflare — 80/443 только с диапазонов Cloudflare; без Cloudflare — 80/443 всем, а Caddy/nginx берут `{remote_host}`/`$remote_addr` и вырезают `CF-Connecting-IP`. `:8787`/`:3000` дома только через frpc (или `127.0.0.1`, если оба процесса на VPS).
- `api.public_base_url` совпадает с DNS (в examples по умолчанию пусто).
- Uvicorn: `proxy_headers=False` (peer = TCP; клиентский IP только через CF/X-Real в `resolve_client_ip`).
- Ключ доступа дашборда задан до публикации SPA (см. [web-ui](../architecture/web-ui.md)).
- Smoke WebSocket: `wss://neyra.owyx.site/api/v1/ws/chat` доходит до Control API.

## Текущая схема web v2 (2026-11-22)

- На домашнем сервере: ядро `127.0.0.1:8787`, сайт `127.0.0.1:3000`; на VPS — только frps/Caddy/nginx.
- `/` и `/api/*` (кроме `/api/v1/*`) → сайт Next.js.
- `/api/auth/*` → сайт без срезания `/api`; redirect URI Discord: `https://neyra.owyx.site/api/auth/callback/discord`.
- `/api/v1/*` → ядро на домашнем сервере со срезанием `/api`; edge отправляет `Host` внутреннего vhost ядра.
- WSS приложения: `wss://neyra.owyx.site/api/v1/ws/chat`, проверено 2026-11-22.
- `/legacy` остаётся на сайте до отдельного решения владельца.
