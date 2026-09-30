# Public hostname: dashboard + API

Example host: `https://neyra.owyx.site`

| Surface | Public URL | Config |
|---------|------------|--------|
| Dashboard UI | `https://neyra.owyx.site/` | `dashboard.public_base_url` (or inherit `api.public_base_url`) |
| API | `https://neyra.owyx.site/api/v1/...` | `api.public_base_url` + `api.public_path_prefix` (`/api`) |

In **example** configs both public URLs are **empty** (local-only). Set them when you have a real DNS name — via yaml or env (`API_PUBLIC_BASE_URL`, optional `DASHBOARD_PUBLIC_BASE_URL`).

App listens on `127.0.0.1:8787` (`api.host` / `api.port`). The reverse proxy terminates TLS and forwards to uvicorn.

## DNS (Cloudflare example)

DNS is **not** configured inside Neyra yaml — only at your DNS provider. Config files just store the hostname you already pointed at the VPS.

1. Buy/use a domain (e.g. `owyx.site`) and open Cloudflare DNS for that zone.
2. Add an **A** (or **AAAA**) record:
   - **Name:** `neyra` (→ `neyra.owyx.site`)
   - **IPv4:** public IP of the VPS where Neyra runs
   - **Proxy status:** DNS only (grey cloud) while debugging TLS; orange cloud OK once Caddy/nginx TLS works (or use Cloudflare Full SSL).
3. Wait for propagation, then set in `server/config/server.yaml` (or `.env`):

```yaml
api:
  public_base_url: "https://neyra.owyx.site"
  public_path_prefix: "/api"
dashboard:
  public_base_url: ""   # empty = same as api.public_base_url
```

```env
API_PUBLIC_BASE_URL=https://neyra.owyx.site
# Optional override if UI lives on another host:
# DASHBOARD_PUBLIC_BASE_URL=https://neyra.owyx.site
API_TOKEN=...   # or API_KEY=... (admin Bearer); required for non-loopback bind
```

4. On the VPS: firewall only 80/443; uvicorn stays on localhost; install Caddy/nginx as below.

## Caddy

```caddy
neyra.owyx.site {
  encode gzip
  # API: strip /api so /api/v1/health → backend /v1/health
  handle_path /api/* {
    reverse_proxy 127.0.0.1:8787
  }
  # Dashboard + SPA routes (same FastAPI static mount)
  handle {
    reverse_proxy 127.0.0.1:8787
  }
}
```

WebSocket: Caddy upgrades automatically for `/api/v1/ws/chat`. Prefer `Authorization: Bearer` (not `?token=`). If you must use query tokens, mask `token` / `access_token` in access logs.

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

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:8787;
  }
}
```

Trailing slash on `proxy_pass` under `/api/` strips the `/api/` prefix.

## Checklist before opening to the internet

- Set `API_TOKEN` or `API_KEY` (and optional viewer/maint) in `server/.env`.
- TLS on the edge (Caddy automatic HTTPS or certbot).
- Firewall: only 80/443 public; uvicorn on localhost.
- Align `api.public_*` / `dashboard.public_base_url` with the DNS name (empty in examples by default).
- Uvicorn uses `proxy_headers=True` and `forwarded_allow_ips=127.0.0.1` so app rate limits see real client IPs; prefer proxy-level limits in production.

VPS deploy of the Neyra process is Stage 4 / ops; this recipe is enough for the public URL contract.
