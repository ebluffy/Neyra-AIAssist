# Public hostname: dashboard + API

Example host: `https://neyra.owyx.site`

| Surface | Public URL | Config |
|---------|------------|--------|
| Dashboard UI | `https://neyra.owyx.site/` | **same** `api.public_base_url` |
| REST API | `https://neyra.owyx.site/api/v1/...` | `api.public_base_url` + `api.public_path_prefix` (`/api`) |
| WebSocket chat | `wss://neyra.owyx.site/api/v1/ws/chat` | same prefix + WS upgrade through proxy |

Configure **only** in `server/config/server.yaml` (section `api:`). In example layers `public_base_url` is empty (local-only).

```yaml
# server/config/server.yaml
api:
  public_base_url: "https://neyra.owyx.site"
  public_path_prefix: "/api"
```

Neyra listens on `127.0.0.1:8787` on the machine that runs the process. Public TLS terminates on the VPS edge.

## Canonical path: home server + frp (Stage 3)

**Home server** here means whatever box runs Neyra at home — mini PC, spare desktop, laptop, NAS VM, etc.

1. Neyra + **frpc** on the home server (`127.0.0.1:8787`).
2. **frps** on the VPS (HTTP vhost, example listen port `8080`).
3. **Caddy** or nginx on the VPS: TLS for `neyra.owyx.site` → reverse-proxy to **frps vhost**, not to `:8787`.
4. Memory, `server/.env`, logs, models stay on the home server; the VPS is proxy + frps only.

Chain: client → `https://` / `wss://neyra.owyx.site/api/v1/ws/chat` → TLS on VPS → frps → frpc → Control API `127.0.0.1:8787`.

Diagram, `frpc.toml`, and token requirements: [`docs/PLAN.md`](../../PLAN.md) §9.

## DNS (Cloudflare example)

DNS is **not** inside Neyra yaml — only at your DNS provider.

1. Open Cloudflare DNS for the zone (e.g. `owyx.site`).
2. Add **A** (or **AAAA**): Name `neyra` → public IP of the **VPS**.
3. Set `api.public_base_url` in `server/config/server.yaml` to that HTTPS origin.
4. On the VPS: firewall **80/443** public; run **frps + Caddy/nginx**. Do **not** expose home-server `:8787` on the internet.
5. Tokens stay in `server/.env` on the home server (`API_TOKEN` / `API_KEY`); public URL stays in yaml.

### frpc: two HTTP vhosts

The home server publishes two proxies: core `8787` and site `3000`. The VPS edge selects them by `Host`:

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

`CORE_UPSTREAM`/`WEB_UPSTREAM` are the frps HTTP vhost addresses on the VPS (usually `127.0.0.1:8080`); `CORE_HOST`/`WEB_HOST` are the matching `customDomains`. If both processes run on the VPS: nginx — `proxy_set_header Host $host;`, Caddy — remove the `header_up Host …` lines (Caddy forwards the original Host by default). The core listens on `127.0.0.1:8787`, the site on `127.0.0.1:3000`.

## Caddy (frp — upstream = frps vhost)

CORE_UPSTREAM/WEB_UPSTREAM are the frps HTTP vhost addresses on the VPS; the home localPorts are 8787/3000. `/api/v1` targets the core and strips the public `/api` prefix; `/api/auth` must stay on the site.

```caddy
neyra.owyx.site {
  encode gzip
  handle /api/v1/* {
    uri strip_prefix /api
    reverse_proxy http://CORE_UPSTREAM {
      header_up Host CORE_HOST
      header_up X-Real-IP {http.request.header.CF-Connecting-IP}
    }
  }
  handle /api/auth/* {
    reverse_proxy http://WEB_UPSTREAM {
      header_up Host WEB_HOST
      header_up X-Real-IP {http.request.header.CF-Connecting-IP}
    }
  }
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

WebSocket upgrades for `/api/v1/ws/chat`. Prefer `Authorization: Bearer`. If using `?token=`, mask `token` in access logs. Without Cloudflare (and with a firewall that drops non-Cloudflare IPs), use `X-Real-IP {remote_host}` and add `header_up -CF-Connecting-IP` so clients cannot inject an address.

## nginx (frp — upstream = frps vhost)

Behind Cloudflare, derive the real client IP once. **Restrict VPS ports 80/443 to Cloudflare ranges** (https://www.cloudflare.com/ips/); otherwise a direct request to the VPS IP can spoof `CF-Connecting-IP`.

```nginx
map $http_cf_connecting_ip $neyra_client_ip {
    ""      $remote_addr;
    default $http_cf_connecting_ip;
}
```

```nginx
server {
  listen 443 ssl http2;
  server_name neyra.owyx.site;

  # Core: strip /api; WebSocket Upgrade passes through.
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

  # Better Auth callback stays on the site; do not strip /api.
  location /api/auth/ {
    proxy_http_version 1.1;
    proxy_set_header Host WEB_HOST;
    proxy_set_header CF-Connecting-IP $neyra_client_ip;
    proxy_set_header X-Real-IP $neyra_client_ip;
    proxy_set_header X-Forwarded-For $neyra_client_ip;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://WEB_UPSTREAM;
  }

  # Chat/attachment BFF and the rest of the site API.
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

Trailing slash on `proxy_pass` under `/api/v1/` strips `/api`; `/api/auth` and `/api/` keep the prefix.

## Alternative: Neyra process on the VPS (no frp)

If both processes run on the VPS, use upstream `127.0.0.1:8787` for `/api/v1/*` and `127.0.0.1:3000` for everything else. That layout is a fallback stand (demo / CI), not the Stage 3 personal-assistant canon — see [`docs/PLAN.md`](../../PLAN.md) §3 and Stage 4 ops.

## Checklist before opening to the internet

- `API_TOKEN` or `API_KEY` in home-server `server/.env` (required for non-loopback / public access).
- TLS on the VPS edge.
- Firewall: 80/443 public on VPS; home-server `:8787` only via frpc (or localhost-only if process is on the VPS).
- `api.public_base_url` matches DNS (empty in examples by default).
- Uvicorn: `proxy_headers=False` (peer = TCP; client IP only via CF/X-Real in `resolve_client_ip`).
- Dashboard access key configured before exposing the SPA (see [web-ui](../architecture/web-ui.md)).
- WebSocket smoke: `wss://neyra.owyx.site/api/v1/ws/chat` reaches Control API.

## Current web v2 routing (2026-11-22)

- Home server: core `127.0.0.1:8787`, site `127.0.0.1:3000`; the VPS runs only frps/Caddy/nginx.
- `/` and `/api/*` except `/api/v1/*` go to the Next.js site.
- `/api/auth/*` goes to the site without stripping `/api`; Discord redirect URI is `https://neyra.owyx.site/api/auth/callback/discord`.
- `/api/v1/*` goes to the home-server core with `/api` stripped; the edge sends the core vhost `Host`.
- App WSS: `wss://neyra.owyx.site/api/v1/ws/chat`, verified 2026-11-22.
- `/legacy` stays on the site until the owner decides otherwise.
