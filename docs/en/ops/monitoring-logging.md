<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Monitoring and logs

- Health monitor: `server/core/health_monitor.py`.
- Status reports: `server/logs/health_status.jsonl` (or path from `server/config/runtime.yaml` / root logging keys).
- System logs: path from `logging.system_log` (default under `server/logs/`).
- Chat logs: path from `logging.chat_log`.

For alerts in integrations, use webhook routes and track `deliveries` / `dlq`.
