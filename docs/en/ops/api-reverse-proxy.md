# Reverse proxy for public Neyra API

Target public URL: `https://neyra.owyx.site/api/v1/...`

App listens on `127.0.0.1:8787` with routes under `/v1` (see `api.host` / `api.port` in `server/config/server.yaml`).
Public settings: `api.public_base_url` + `api.public_path_prefix` (defaults: `https://neyra.owyx.site` + `/api`).

## Caddy

```caddy
neyra.owyx.site {
  encode gzip
  handle_path /api/* {
    reverse_proxy 127.0.0.1:8787
  }
  # Optional: serve nothing else, or proxy dashboard at /
}
```

`handle_path` strips `/api` so `/api/v1/health` → backend `/v1/health`.
WebSocket: Caddy upgrades automatically for `/api/v1/ws/chat`.

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

Trailing slash on `proxy_pass` strips the `/api/` prefix.

## Checklist before opening to the internet

- Set `API_TOKEN` / viewer / maint in `server/.env` (never leave anonymous API on a public host).
- TLS on the edge (Caddy automatic HTTPS or certbot).
- Firewall: only 80/443 public; uvicorn stays on localhost.
- Align `api.public_base_url` / `public_path_prefix` with the real DNS name (empty in examples by default; set via yaml or `API_PUBLIC_BASE_URL`).
- Uvicorn runs with `proxy_headers=True` and `forwarded_allow_ips=127.0.0.1` so `api.rate_limit_*` sees the real client IP from `X-Forwarded-For`. Prefer rate limits on the proxy for production.

VPS deploy of the Neyra server process is Stage 4 / ops; this recipe is enough for Stage 2 contract.