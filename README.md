# Instabox Panel

A web version of the **Instabox Manager** Android app. Manage your Instabox machines from a browser — list all machines, view live status with colour coding, and perform every action (start, stop, pause, resume, wake, fork, delete, run commands, view logs, metrics, and open a terminal).

Built with plain HTML/CSS/JS (no build step, no framework) and hosted on **Cloudflare Pages** with **Cloudflare Functions** for a built-in CORS proxy — zero-config, same-origin API access.

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

The public Instabox API blocks CORS from browser origins. Since API keys must be entered on the website (not stored in GitHub Secrets), the website uses a **four-tier automatic fallback**:

1. **Built-in `/api/` proxy (Cloudflare Pages Functions)** — **Primary, zero-config.** When deployed to Cloudflare Pages, a same-origin `/api/*` worker forwards requests to `api.instabox.sh` with CORS headers. No CORS issues, no user setup.
2. **Direct API call** — tries `api.instabox.sh` directly (works locally if CORS allowed).
3. **User CORS proxy (optional)** — if a proxy URL is configured (localStorage `instabox_cors_proxy` or URL param `cors_proxy`), failed direct calls retry through it.
4. **GitHub Actions proxy (fallback)** — manual workflow that fetches data and returns as artifact. Used when all above fail.

### How it works (automatic)

1. You enter your **Instabox API key** (`ibk_…`) on the page — stored in your browser's `localStorage` only.
2. On load, the panel probes `/api/v1/machines` (HEAD request).
   - **If it responds** (2xx/401/403), the built-in proxy is active → **all API calls go through `/api/` automatically** (same-origin, no CORS).
   - **If not**, it falls back to direct → user proxy → GitHub Actions.
3. No manual steps, no "Refresh from GitHub Actions" button needed when on Cloudflare Pages.

### Deploy to Cloudflare Pages (recommended)

1. Push this repo to GitHub.
2. Go to [Cloudflare Pages](https://dash.cloudflare.com/?account=pages) → **Create a project** → **Connect to Git** → select this repo.
3. Build settings:
   - **Build command**: (empty — static site)
   - **Build output directory**: `.` (root)
   - **Root directory**: (empty)
4. Add **Environment variables** (Settings → Environment variables):
   - None required for the proxy (it reads the API key from request headers).
5. Deploy. Your site gets a `*.pages.dev` URL with the `/api/` proxy built in.

The `functions/api-proxy.js` and `wrangler.toml` in this repo configure the worker automatically.

### Local development

Open `index.html` directly or serve with any static server:
```bash
python3 -m http.server 8000
# http://localhost:8000
```
Locally, the built-in proxy won't be available (404 on `/api/`), so the panel falls back to direct API calls. If your browser blocks CORS, configure a user CORS proxy (see below) or use the GitHub Actions fallback.

### Configuring a user CORS proxy (fallback only)

If not on Cloudflare Pages, deploy a simple CORS proxy and set its URL:

- **Via URL param**: `https://your-site.pages.dev/?cors_proxy=https://your-proxy.workers.dev/?url=`
- **Persisted in browser**: `localStorage.setItem('instabox_cors_proxy', 'https://your-proxy.workers.dev/?url=')`

#### Quick CORS proxy deploy (Cloudflare Worker)

1. Go to [Cloudflare Workers](https://dash.cloudflare.com/?account=workers) → Create Worker.
2. Paste this code:
```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url') || url.searchParams.get('target');
    if (!target) return new Response('Missing "url" or "target" query param', { status: 400 });
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization, Idempotency-Key',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const req = new Request(target, {
      method: request.method,
      headers: request.headers,
      body: ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'follow',
    });
    const resp = await fetch(req);
    return new Response(resp.body, { status: resp.status, headers: { ...corsHeaders, ...Object.fromEntries(resp.headers) } });
  }
};
```
3. Deploy and copy the Worker URL (e.g., `https://instabox-cors.your-subdomain.workers.dev`).
4. Set it as `cors_proxy` URL param or localStorage (append `?url=` if not already present).

> **Note:** Write operations (start/stop/etc.) go through the same proxy chain. On Cloudflare Pages, they use the built-in `/api/` proxy automatically. Otherwise, they fall back through the chain above.

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
