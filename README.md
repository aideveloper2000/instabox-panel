# Instabox Panel

A web version of the **Instabox Manager** Android app. Manage your Instabox machines from a browser — list all machines, view live status with colour coding, and perform every action (start, stop, pause, resume, wake, fork, delete, run commands, view logs, metrics, and open a terminal).

Built with plain HTML/CSS/JS (no build step, no framework) and hosted on **GitHub Pages** with a **GitHub Actions** CI workflow that validates the site on every push.

## What it does

| Feature | Status |
|---|---|
| Add / switch / remove API keys | ✅ |
| List all machines | ✅ |
| Live status indicators | ✅ |
| Start / Stop / Pause / Resume / Wake | ✅ |
| Fork machine | ✅ |
| Run command (`exec`) | ✅ |
| View logs | ✅ |
| View metrics | ✅ |
| Open terminal (WebSocket) | ✅ |
| VNC / Snapshots | 📌 (API endpoints exposed, see README notes) |

## How it works

1. You enter your **Instabox API key** (`ibk_…`) on the page.
2. The panel calls the public **Instabox API** at `https://api.instabox.sh` on your behalf.
3. All state is stored in your browser's `localStorage` — no data leaves your machine except the API requests to Instabox.

## Quick start

1. **Clone the repo** (or just open `index.html`? — no, use this hosted version):
   ```bash
   git clone https://github.com/aideveloper2000/instabox-panel.git
   cd instabox-panel
   ```
2. **Run locally** (no server needed — just open `index.html`):
   ```bash
   open index.html
   ```
   Note: the Instabox API must allow CORS for local file access. It does. If you prefer, serve it with any static server:
   ```bash
   python3 -m http.server 8000
   # http://localhost:8000
   ```
3. **Use the panel:**
   - Click **+ Add API Key** and paste your `ibk_…` key.
   - Refresh to load machines.
   - Click any machine to see actions and tabs.

## Data proxy (CORS workaround)

The public Instabox API blocks CORS from browser origins, so the website uses a two-part approach:

1. **Static site** (GitHub Pages) — the HTML/CSS/JS frontend you see.
2. **Data proxy** (GitHub Actions) — a workflow that fetches machine data from the Instabox API and stores it in `data/machines.json`.

The frontend reads from `data/machines.json` when the direct API call is blocked by CORS.

### Setting up the API key

1. Go to your repo's **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name: `INSTABOX_API_KEY` — value: your Instabox API key (`ibk_...`).
4. Save.

### How it works

- The `deploy.yml` workflow fetches machine data from the Instabox API using the `INSTABOX_API_KEY` secret.
- The data is stored in `data/machines.json` and deployed alongside the site.
- The frontend reads from `data/machines.json` when the direct API call is blocked by CORS.

> **Note:** Write operations (start/stop/etc.) still go directly to the Instabox API from your browser. If you hit a CORS block on those endpoints, set up a small reverse proxy (e.g. Cloudflare Workers, a lightweight server, or a `workflow_dispatch` triggered GitHub Action) that forwards requests and adds the `X-API-Key` header.

## API reference used

- Base URL: `https://api.instabox.sh`
- Auth header: `X-API-Key: <your-api-key>` (or `Authorization: Bearer <key>`)

Endpoints used:

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/machines` | List all machines |
| GET | `/v1/machines/{id}` | Machine details |
| POST | `/v1/machines/{id}/start\|stop\|suspend\|resume\|wake` | Lifecycle |
| POST | `/v1/machines/{id}/fork` | Clone a machine |
| POST | `/v1/machines/{id}/exec` | Run a shell command (`{"cmd": "..."}`) |
| GET | `/v1/machines/{id}/logs` | Machine logs |
| GET | `/v1/machines/{id}/metrics` | Metrics |
| GET | `/v1/machines/{id}/terminal` | WebSocket terminal |
| GET | `/v1/machines/{id}/vnc` | WebSocket VNC |
| POST | `/v1/machines/{id}/snapshot` | Create snapshot |
| POST | `/v1/snapshots/{id}/restore` | Restore snapshot |

## Notes

- The Instabox API returns a **202 Accepted** with an operation ID for lifecycle actions. This panel shows a success toast and refreshes the list; you can check operation status via the API if needed.
- Logs may stream via **SSE** on the server; the panel polls the logs endpoint for simplicity in a static site.
- Terminal is implemented with a browser **WebSocket** — the API key is passed in the URL, so keep the panel private.
- VNC is a WebSocket connection; pair it with a VNC viewer for the desktop.

## License

MIT — see `LICENSE`.
