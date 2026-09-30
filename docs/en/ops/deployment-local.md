<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Local deployment

- Run `python server/main.py` (or `python main.py` from `server/` cwd).
- API default: `http://127.0.0.1:8787`.
- Dashboard static files from `server/dashboard/dist` when built.
- Frontend dev: `cd server/dashboard && npm run dev` (Vite proxy to the backend).
- First browser visit: create the dashboard **access key** ([web-ui](../architecture/web-ui.md)).
