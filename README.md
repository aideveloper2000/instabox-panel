# Instabox Panel

A web version of the **Instabox Manager** Android app. Manage your Instabox
machines from a browser — list every machine, watch live status with colour
coding, and run each action (start, stop, pause, resume, wake, fork, delete,
exec, logs, metrics, terminal, snapshots).

Plain HTML/CSS/JS — no build step, no framework — hosted on **Cloudflare Pages**
with a **Pages Functions** proxy that makes the API same-origin.

## Live

**https://instabox-panel-web.pages.dev**

## Quick start

1. Open the site.
2. Click **Add key** and paste your Instabox API key (`ibk_…`). Add every key
   you want — one dashboard lists the machines from all of them.
3. The machine list loads. Each row carries a quick action that matches its
   state (Pause while running, Resume while suspended, Start while stopped);
   click a machine for the full detail view and every action.

Keys are stored only in your browser's `localStorage`. They are sent in the
`X-API-Key` header to Instabox, either same-origin through the panel's `/api`
proxy or directly — never to a third party.

## Why the proxy exists

`api.instabox.sh` does not send CORS headers, so a browser cannot call it from
another origin. The panel therefore ships a tiny same-origin proxy:

```
functions/api/_middleware.js   ->   https://api.instabox.sh
```

Every request the panel makes goes to `/api/v1/...` on its own origin. The
middleware forwards it to Instabox, copies the API key and idempotency headers,
and adds `Access-Control-Allow-Origin: *` to the reply. From the browser's point
of view the API is same-origin, so there is no CORS error and no redirect.

The panel probes `GET /api/health` on load. If it answers, the proxy is used for
every call; if not (for example when opening `index.html` from a plain static
host), the panel calls the API directly and says so in the header.

## Deploy it yourself

The site is a static directory plus one Pages Function.

```bash
npm i -g wrangler
wrangler pages deploy . --project-name instabox-panel-web --branch main
```

Or connect the repo to Cloudflare Pages (Pages dashboard → Create project →
Connect to Git) with:

- **Build command**: empty
- **Build output directory**: `.`
- **Root directory**: empty

No environment variables are needed. `functions/api/_middleware.js` is picked up
automatically.

To deploy from GitHub Actions, add a `CLOUDFLARE_API_TOKEN` repository secret
with Pages:Edit access; `.github/workflows/deploy.yml` runs
`wrangler pages deploy` when it is present and skips the deploy when it is not.

## API surface used

- Base URL: `https://api.instabox.sh`
- Auth: `X-API-Key: <key>` (or `Authorization: Bearer <key>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/machines` | List machines |
| GET | `/v1/machines/{id}` | Machine details |
| POST | `/v1/machines/{id}/start\|stop\|suspend\|resume\|wake` | Lifecycle |
| POST | `/v1/machines/{id}/fork` | Clone a machine |
| DELETE | `/v1/machines/{id}` | Delete (`X-Confirm-Delete` required) |
| POST | `/v1/machines/{id}/exec` | Run a shell command (`{"cmd": "…"}`) |
| GET | `/v1/machines/{id}/history` | Command history |
| GET | `/v1/machines/{id}/logs` | Console log |
| GET | `/v1/machines/{id}/metrics` | CPU / memory / network / disk samples |
| GET | `/v1/snapshots` | List snapshots (filter by `sourceMachineId`) |
| POST | `/v1/machines/{id}/snapshots` | Create a snapshot |
| POST | `/v1/machines/{id}/restore` | Restore a snapshot |
| WS | `/v1/machines/{id}/terminal` | Browser terminal (PTY) |

## Notes

- Lifecycle changes answer `202 Accepted` with an **operation** id; the panel
  reports it and refreshes the list.
- Snapshot names must be 1–63 characters (`a-z`, `0-9`, `-`, starting with a
  letter or digit). The detail **Snapshot** action generates one; the Snapshots
  tab lets you name it, and auto-names when the field is left empty.
- The terminal is a WebSocket. The API expects browser sessions to come from the
  dashboard's origin, so the Terminal tab may refuse a connection from another
  domain; every other feature works from any origin.
- Logs are polled, not streamed.

## License

MIT
