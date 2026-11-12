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

The public Instabox API blocks CORS from browser origins. Since API keys must be entered on the website (not stored in GitHub Secrets), the website uses a three-tier approach:

1. **Direct API call** — tries to call `api.instabox.sh` directly from the browser.
2. **CORS proxy (optional, automatic)** — if a CORS proxy URL is configured (via localStorage `instabox_cors_proxy` or URL param `cors_proxy`), failed direct calls automatically retry through the proxy. You can deploy your own proxy (Cloudflare Worker, Vercel, etc.) for zero-manual-step operation.
3. **GitHub Actions proxy (fallback)** — a workflow that fetches machine data using the key you enter, then returns it as an artifact. Used when no CORS proxy is configured or it fails.

### How it works

1. You enter your **Instabox API key** (`ibk_…`) on the page — it is stored in your browser's `localStorage` only.
2. The panel tries to fetch from the Instabox API directly. If the browser blocks it (CORS):
   - **If a CORS proxy is configured**, it retries automatically via the proxy (no user action needed).
   - **Otherwise**, the page shows instructions to use the **"Refresh from GitHub Actions"** button.
3. Click **"Refresh from GitHub Actions"**. The panel triggers the `proxy.yml` GitHub Actions workflow (`workflow_dispatch`). The workflow is manually triggered by the user — the API key is passed as an input to the workflow, not stored in GitHub Secrets.
4. The workflow curls the Instabox API with your key, gets the response, and uploads it as a workflow artifact.
5. The panel downloads the artifact and renders the machine list.

### Configuring a CORS proxy (recommended for seamless UX)

Deploy a simple CORS proxy (examples below) and set its URL:

- **Via URL param** (for testing): `https://aideveloper2000.github.io/instabox-panel/?cors_proxy=https://your-proxy.workers.dev/?url=`
- **Persisted in browser**: Open browser console and run `localStorage.setItem('instabox_cors_proxy', 'https://your-proxy.workers.dev/?url=')`

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

> **Note:** Write operations (start/stop/etc.) still go directly to the Instabox API from your browser. If you hit a CORS block on those endpoints, the CORS proxy will handle them automatically if configured. Otherwise, use the **"Refresh from GitHub Actions"** proxy for those operations too — the `proxy.yml` workflow accepts arbitrary HTTP methods and paths.

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
