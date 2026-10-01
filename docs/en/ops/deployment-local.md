# Local deployment

- Run `python server/main.py` (or `python main.py` from `server/` cwd).
- API default: `http://127.0.0.1:8787`.
- Dashboard static files from `server/dashboard/dist` when built.
- Frontend dev: `cd server/dashboard && npm run dev` (Vite proxy to the backend).
- First browser visit: create the dashboard **access key** ([web-ui](../architecture/web-ui.md)).
