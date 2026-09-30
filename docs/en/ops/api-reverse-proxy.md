# Public hostname: dashboard + API

Example host: `https://neyra.owyx.site`

| Surface | Public URL | Config |
|---------|------------|--------|
| Dashboard UI | `https://neyra.owyx.site/` | **same** `api.public_base_url` |
| API | `https://neyra.owyx.site/api/v1/...` | `api.public_base_url` + `api.public_path_prefix` (`/api`) |

Configure **only** in `server/config/server.yaml` (not `.env`). In example layers `public_base_url` is empty (local-only).

```yaml
# server/config/server.yaml
api:
  public_base_url: "https://neyra.owyx.site"
  public_path_prefix: "/api"
```

App listens on `127.0.0.1:8787`. The reverse proxy terminates TLS and forwards to uvicorn.

## DNS (Cloudflare example)

DNS is **not** inside Neyra yaml — only at your DNS provider. Yaml stores the hostname you already pointed at the VPS.

1. Open Cloudflare DNS for the zone (e.g. `owyx.site`).
2. Add **A** (or **AAAA**):
   - **Name:** `neyra` → `neyra.owyx.site`
   - **IPv4:** public IP of the VPS
   - **Proxy:** DNS only while debugging TLS; orange cloud once HTTPS works.
3. Set `api.public_base_url` in `server/config/server.yaml` to that HTTPS origin.
4. On the VPS: firewall 80/443 only; uvicorn on localhost; Caddy/nginx below.
5. Tokens stay in `.env` (`API_TOKEN` / `API_KEY`); public URL stays in yaml.

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

WebSocket: upgrades for `/api/v1/ws/chat`. Prefer `Authorization: Bearer`. If using `?token=`, mask `token` in access logs.

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

Trailing slash on `proxy_pass` under `/api/` strips `/api/`.

## Checklist before opening to the internet

- `API_TOKEN` or `API_KEY` in `server/.env`.
- TLS on the edge.
- Firewall: 80/443 public; uvicorn localhost.
- `api.public_base_url` matches DNS (empty in examples by default).
- Uvicorn: `proxy_headers=True`, `forwarded_allow_ips=127.0.0.1`.

VPS process deploy is Stage 4 / ops.
