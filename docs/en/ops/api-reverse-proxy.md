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

Diagram, `frpc.toml`, and token requirements: [`docs/PLAN.md`](../../PLAN.md) §3.

## DNS (Cloudflare example)

DNS is **not** inside Neyra yaml — only at your DNS provider.

1. Open Cloudflare DNS for the zone (e.g. `owyx.site`).
2. Add **A** (or **AAAA**): Name `neyra` → public IP of the **VPS**.
3. Set `api.public_base_url` in `server/config/server.yaml` to that HTTPS origin.
4. On the VPS: firewall **80/443** public; run **frps + Caddy/nginx**. Do **not** expose home-server `:8787` on the internet.
5. Tokens stay in `server/.env` on the home server (`API_TOKEN` / `API_KEY`); public URL stays in yaml.

## Caddy (frp — upstream = frps vhost)

Replace `8080` with your frps HTTP vhost port. `handle_path /api/*` strips the public `/api` prefix so the app sees `/v1/...`.

```caddy
neyra.owyx.site {
  encode gzip
  # Upstream = frps HTTP vhost on this VPS (NOT local uvicorn :8787)
  handle_path /api/* {
    reverse_proxy 127.0.0.1:8080
  }
  handle {
    reverse_proxy 127.0.0.1:8080
  }
}
```

WebSocket upgrades for `/api/v1/ws/chat`. Prefer `Authorization: Bearer`. If using `?token=`, mask `token` in access logs.

## nginx (frp — upstream = frps vhost)

```nginx
server {
  listen 443 ssl http2;
  server_name neyra.owyx.site;

  # Upstream = frps HTTP vhost (example :8080), not uvicorn :8787
  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://127.0.0.1:8080/;
  }

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://127.0.0.1:8080;
  }
}
```

Trailing slash on `proxy_pass` under `/api/` strips `/api`.

## Alternative: Neyra process on the VPS (no frp)

If uvicorn runs on the same VPS as Caddy/nginx, point reverse_proxy / `proxy_pass` at `127.0.0.1:8787` instead of the frps port. That layout is a fallback stand (demo / CI), not the Stage 3 personal-assistant canon — see [`docs/PLAN.md`](../../PLAN.md) §3 and Stage 4 ops.

## Checklist before opening to the internet

- `API_TOKEN` or `API_KEY` in home-server `server/.env` (required for non-loopback / public access).
- TLS on the VPS edge.
- Firewall: 80/443 public on VPS; home-server `:8787` only via frpc (or localhost-only if process is on the VPS).
- `api.public_base_url` matches DNS (empty in examples by default).
- Uvicorn: `proxy_headers=True`, `forwarded_allow_ips` restricted to your proxy/frp hop.
- Dashboard access key configured before exposing the SPA (see [web-ui](../architecture/web-ui.md)).
- WebSocket smoke: `wss://neyra.owyx.site/api/v1/ws/chat` reaches Control API.
