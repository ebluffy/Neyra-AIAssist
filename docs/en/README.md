# Neyra documentation (English)

**Other language:** [Русская документация](../ru/README.md)

English docs live under `docs/en/**`.

| Area | Topics |
|------|--------|
| [architecture/](architecture/overview.md) | System design, config model, security, **Web UI** |
| [setup/](setup/quickstart.md) | Quickstart, env vars, config reference, **MCP debug server** |
| [ops/](ops/deployment-local.md) | Deploy, monitoring, troubleshooting, backup, **WSS deployment** |
| [api/](api/overview.md) | REST, WebSocket, OpenAPI, errors, examples |
| [usage/](usage/end-user-guide.md) | End-user, admin, integration guides, FAQ |
| [plugins/](plugins/overview.md) | Plugin SDK, manifests, events, cookbooks |
| [development/](development/contributing.md) | Contributing |
| [reference/](reference/vocard-upstream.md) | Upstream references (e.g. Vocard) |

Client reform documents (English summaries; the Russian text is canonical):

- [architecture/web-v2.md](architecture/web-v2.md) — web client v2: decisions D1–D27, data model, identity, deployment, stages P0–P6.
- [architecture/adr-0001-client-monorepo.md](architecture/adr-0001-client-monorepo.md) — ADR: client monorepo `packages/ui` + `packages/contracts` + `apps/web` + `apps/desktop`; Rust and IPC unchanged.

**Repository:** [github.com/ebluffy/Neyra-AIAssist](https://github.com/ebluffy/Neyra-AIAssist)

Root project files: `README.md`, `README-RU.md`, roadmap in [`docs/PLAN.md`](../PLAN.md).  
Plugin examples (do not relocate): `server/modules/000EXAMPLE/`.
