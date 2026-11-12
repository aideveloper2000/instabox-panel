/**
 * Instabox Panel – web UI for managing Instabox machines.
 * Mirrors the feature set of the instabox-manager Android app.
 *
 * API surface (https://api.instabox.sh):
 *   GET    /v1/machines
 *   GET    /v1/machines/{id}
 *   POST   /v1/machines/{id}/start|stop|suspend|resume|wake|fork
 *   DELETE /v1/machines/{id}
 *   POST   /v1/machines/{id}/exec        ({cmd} or {argv})
 *   GET    /v1/machines/{id}/logs        (stream or poll)
 *   GET    /v1/machines/{id}/metrics
 *   GET    /v1/machines/{id}/terminal    (WebSocket)
 *   GET    /v1/machines/{id}/vnc         (WebSocket)
 *   GET    /v1/snapshots (list snapshots)
 *   POST   /v1/machines/{id}/snapshot    (create snapshot)
 *   POST   /v1/snapshots/{id}/restore    (restore)
 *
 * Auth: X-API-Key: <key>  (a.k.a. Authorization: Bearer <key>)
 */

const API_BASE = "https://api.instabox.sh";
const STORAGE_KEY = "instabox_panel_keys";

const state = {
  keys: [],
  currentKey: null,
  machines: [],
  loading: false,
  search: "",
  statusFilter: "",
  detailMachine: null,
  detailTab: "overview",
  logs: [],
  logsAlive: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const refreshMachines = fetchMachines;

/* -------------------------------------------------------------------------- */
/*  Utils                                                                       */
/* -------------------------------------------------------------------------- */

function toast(msg, type = "success") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast";
  if (type === "error") el.style.borderColor = "var(--red)";
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (state.currentKey && !headers["X-API-Key"]) {
    headers["X-API-Key"] = state.currentKey;
  }
  const config = {
    headers,
    ...opts,
    headers,
  };
  const idempotency = opts.idempotency ?? crypto.randomUUID();
  if (!opts.noIdempotency && (opts.method === "POST" || opts.method === "DELETE" || opts.method === "PATCH")) {
    config.headers["Idempotency-Key"] = idempotency;
  }

  // Try direct API call (may be blocked by browser CORS)
  try {
    const res = await fetch(`${API_BASE}${path}`, config);
    let body = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      body = await res.json().catch(() => null);
    }
    if (res.ok) {
      return { res, status: res.status, body };
    }
    const err = (body && body.error ? body.error : null) ?? null;
    const status = res.status;
    const msg = err?.message ?? err?.code ?? `Request failed (${status})`;
    throw { res, status, message: msg, body };
  } catch (corsErr) {
    // CORS blocked the direct call — throw a ProxyFetchError so the caller
    // knows to fall back to the GitHub Actions proxy workflow.
    throw new ProxyFetchError(
      "This page can't reach the Instabox API directly (browser CORS blocks external api.instabox.sh). " +
      "Please add your API key on the page, then use the \"Refresh from GitHub Actions\" button."
    );
  }
}

class ProxyFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProxyFetchError";
  }
}

/* -------------------------------------------------------------------------- */
/*  Key management                                                              */
/* -------------------------------------------------------------------------- */

function loadKeys() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state.keys = raw ? JSON.parse(raw) : [];
  } catch {
    state.keys = [];
  }
  if (!state.currentKey && state.keys.length) state.currentKey = state.keys[0].value;
}

function saveKeys() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.keys));
}

function renderKeybar() {
  const el = $("#keybarValue");
  if (!state.currentKey) {
    el.textContent = "—";
    $("#switchKeyBtn").hidden = true;
    $("#removeKeyBtn").hidden = true;
    return;
  }
  el.textContent = state.currentKey;
  $("#switchKeyBtn").hidden = false;
  $("#removeKeyBtn").hidden = false;
}

function renderKeyList() {
  const list = $("#keyList");
  if (!list) return;
  list.innerHTML = "";
  for (const k of state.keys) {
    const btn = document.createElement("button");
    btn.className = "chip " + (k.value === state.currentKey ? "active" : "");
    btn.textContent = k.name + (k.value === state.currentKey ? " (active)" : "");
    btn.addEventListener("click", () => {
      state.currentKey = k.value;
      saveKeys();
      renderKeybar();
      refreshMachines();
      closeAllModals();
    });
    list.appendChild(btn);
  }
  if (!state.keys.length) {
    list.innerHTML = '<span class="muted">No keys yet — add one below.</span>';
  }
}

/* -------------------------------------------------------------------------- */
/*  Import / Export                                                               */
/* -------------------------------------------------------------------------- */

function exportKeys() {
  if (!state.keys.length) {
    toast("No keys to export.");
    return;
  }
  const data = { exported_at: new Date().toISOString(), keys: state.keys };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `instabox-panel-keys-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("Keys exported");
}

function importKeys(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.keys)) {
        return toast("Invalid file format. Expected JSON with a 'keys' array.");
      }
      for (const k of data.keys) {
        if (!k.name || !k.value) continue;
        if (state.keys.some((x) => x.value === k.value)) continue;
        state.keys.push({ name: k.name, value: k.value });
      }
      saveKeys();
      renderKeybar();
      renderKeyList();
      toast(`Imported ${state.keys.length} key(s)`);
    } catch (e) {
      toast("Failed to parse file: " + e.message, "error");
    }
  };
  reader.readAsText(file);
}

function handleImportFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  importKeys(file);
  e.target.value = "";
}
function openKeyModal(editKey = null) {
  $("#keyName").value = editKey?.name ?? "";
  $("#keyValue").value = editKey?.value ?? "";
  $("#keyModal").hidden = false;
  $("#keyName").focus();
}

function closeKeyModal() {
  $("#keyModal").hidden = true;
}

function closeAllModals() {
  closeKeyModal();
  closeDetailModal();
}

/* -------------------------------------------------------------------------- */
/*  Machines                                                                    */
/* -------------------------------------------------------------------------- */

async function fetchMachines(refresh = false) {
  if (state.loading && !refresh) return;
  state.loading = true;
  $("#refreshBtn").disabled = true;
  try {
    const { body } = await apiFetch("/v1/machines", { readOnly: true });
    const list = (body && body.machines) ?? [];
    state.machines = list;
    renderMachineList();
    updateEmptyState();
    $("#footerCount").textContent = `${list.length} machine${list.length !== 1 ? "s" : ""}`;
  } catch (e) {
    showApiError(e);
  } finally {
    state.loading = false;
    $("#refreshBtn").disabled = false;
  }
}

function renderMachineList() {
  const list = $("#machineList");
  const filtered = state.machines.filter((m) => {
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = `${m.name ?? ""} ${m.id ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.statusFilter && m.state !== state.statusFilter) return false;
    return true;
  });

  list.innerHTML = "";
  for (const m of filtered) {
    list.appendChild(renderCard(m));
  }
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">▦</div><p class="empty-title">No machines match</p></div>';
  }
}

function renderCard(m) {
  const card = document.createElement("div");
  card.className = `machine-card status-${m.state ?? "unknown"}`;

  const stateLabel = m.state ?? "unknown";
  const dots = {
    running: '<span class="dot" style="background:#22c55e"></span>',
    stopped: '<span class="dot" style="background:#ef4444"></span>',
    paused: '<span class="dot" style="background:#f59e0b"></span>',
    creating: '<span class="dot" style="background:#a855f7"></span>',
    deleting: '<span class="dot" style="background:#6b7288"></span>',
  };
  const pillClass = `status-${m.state ?? "unknown"}`.replace(/_/g, "-");
  const label = stateLabel
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  card.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-title">${escapeHtml(m.name ?? "Unnamed")}</div>
        <div class="card-id">${escapeHtml(m.id ?? "")}</div>
      </div>
      <span class="status-pill ${pillClass}">${dots[stateLabel] ?? ""}${label}</span>
    </div>

    <div class="card-stats">
      <div class="stat"><div class="stat-label">CPU</div><div class="stat-value">${formatMetric(m.cpu ?? m.cpu_percent ?? "")}</div></div>
      <div class="stat"><div class="stat-label">RAM</div><div class="stat-value">${formatMetric(m.memory ?? m.ram ?? "")}</div></div>
      <div class="stat"><div class="stat-label">Disk</div><div class="stat-value">${formatMetric(m.disk ?? "")}</div></div>
      <div class="stat"><div class="stat-label">Uptime</div><div class="stat-value">${formatUptime(m.created_at ?? m.updated_at ?? "")}</div></div>
    </div>

    <div class="card-actions">
      <button class="btn accent" data-act="start" data-id="${escapeAttr(m.id)}">Start</button>
      <button class="btn" data-act="stop" data-id="${escapeAttr(m.id)}">Stop</button>
      <button class="btn" data-act="suspend" data-id="${escapeAttr(m.id)}">Pause</button>
      <button class="btn" data-act="resume" data-id="${escapeAttr(m.id)}">Resume</button>
      <button class="btn" data-act="wake" data-id="${escapeAttr(m.id)}">Wake</button>
      <button class="btn" data-act="fork" data-id="${escapeAttr(m.id)}">Fork</button>
      <button class="btn btn-outline btn-sm" data-act="snapshot" data-id="${escapeAttr(m.id)}">Snapshot</button>
      <button class="btn btn-outline btn-sm btn-danger" data-act="delete" data-id="${escapeAttr(m.id)}">Delete</button>
    </div>
  `;

  // Attach actions
  card.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => performAction(btn.dataset.act, btn.dataset.id));
  });

  return card;
}

function formatMetric(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") {
    if (v < 1024) return `${v} ${v === 1 ? "B" : "B"}`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KiB`;
    return `${(v / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return String(v);
}

function formatUptime(v) {
  if (!v) return "—";
  const t = Date.parse(v);
  if (isNaN(t)) return String(v);
  const s = Math.floor((Date.now() - t) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function updateEmptyState() {
  const show = !state.machines.length;
  $("#emptyState").hidden = !show;
  $("#machineList").hidden = show;
}

function showApiError(e) {
  if (e instanceof ProxyFetchError) {
    toast(e.message, "error");
    // When CORS blocks the direct call, offer the GitHub Actions proxy route.
    const isCors = e.message && (e.message.includes("can't reach") || e.message.includes("CORS"));
    if (isCors) {
      $("#proxyHint").style.display = "inline-block";
      $("#refreshViaActionsBtn").style.display = "inline-block";
      toast("Browser blocked the direct API call. Use \"Refresh via Actions\" and follow the on-screen instructions.", "error");
    }
  } else if (e.status === 401 || e.code === "missing_key" || e.code === "malformed_key") {
    toast("Invalid or missing API key — please add a valid key.", "error");
  } else {
    toast(e.message ?? "Something went wrong", "error");
  }
}

/** Show UI instructing the user to manually trigger the GitHub Actions proxy workflow. */
function onRefreshViaActions() {
  $("#proxyHint").style.display = "inline-block";
  $("#refreshViaActionsBtn").style.display = "none";
  $("#refreshStatus").textContent = "Proxy mode — follow these steps:";
  toast("1) Click the GitHub Actions tab in your repo.\n2) Click \"Actions\" → \"Instabox API Proxy\" → \"Run workflow\".\n3) Enter your API key, method, and path, then click \"Run workflow\".\n4) After it completes, click \"⟳ Refresh\" to load the data.");
}

/* -------------------------------------------------------------------------- */
/*  Detail view                                                                 */
/* -------------------------------------------------------------------------- */

function openDetail(m) {
  state.detailMachine = m;
  state.detailTab = "overview";
  $("#detailTitle").textContent = `${m.name ?? "Machine"} — details`;
  $("#detailBody").innerHTML = '<div class="muted">Loading…</div>';
  $("#detailModal").hidden = false;
  renderDetailTab("overview");
}

function closeDetailModal() {
  $("#detailModal").hidden = true;
  state.detailMachine = null;
}

function renderDetailTab(tab) {
  const m = state.detailMachine;
  const pane = (t) => ({ overview: "overview", logs: "logs", commands: "commands", metrics: "metrics", terminal: "terminal" }[t] ?? "overview");
  document.querySelectorAll(".detail-tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  $$(".detail-pane").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  if (tab === "overview") renderOverview(m);
  else if (tab === "logs") renderLogs(m);
  else if (tab === "commands") renderCommands(m);
  else if (tab === "metrics") renderMetrics(m);
  else if (tab === "terminal") renderTerminal(m);
}

function renderOverview(m) {
  const rows = [];
  for (const [k, label] of [
    ["id", "Machine ID"],
    ["name", "Name"],
    ["state", "State"],
    ["created_at", "Created"],
    ["updated_at", "Updated"],
    ["cpu", "CPU"],
    ["memory", "Memory"],
    ["disk", "Disk"],
    ["template_id", "Template"],
    ["vcpus", "vCPUs"],
    ["guest_user", "User"],
    ["labels", "Labels"],
  ]) {
    const val = m[k] ?? "";
    if (val === "" || val == null) continue;
    rows.push(`<div class="detail-card"><div class="k">${label}</div><div class="v mono">${escapeHtml(String(val))}</div></div>`);
  }
  $("#detailBody").innerHTML = `
    <div class="detail-tabs">
      <button class="detail-tab active" data-tab="overview">Overview</button>
      <button class="detail-tab" data-tab="logs">Logs</button>
      <button class="detail-tab" data-tab="commands">Commands</button>
      <button class="detail-tab" data-tab="metrics">Metrics</button>
      <button class="detail-tab" data-tab="terminal">Terminal</button>
    </div>
    <div class="detail-pane active" data-tab="overview">${rows.join("")}</div>
    <div class="detail-pane" data-tab="logs"></div>
    <div class="detail-pane" data-tab="commands"></div>
    <div class="detail-pane" data-tab="metrics"></div>
    <div class="detail-pane" data-tab="terminal"></div>
  `;
}

function fetchLogs(m) {
  return apiFetch(`/v1/machines/${m.id}/logs`);
}

function renderLogs(m) {
  const el = $("#detailBody");
  if (!m) return;
  // fetch snippet
  apiFetch(`/v1/machines/${m.id}/logs`)
    .then(({ body }) => {
      const log = body?.logs ?? body ?? "";
      el.innerHTML = `<div class="logs">${escapeHtml(String(log ?? ""))}</div>`;
    })
    .catch(() => {
      el.innerHTML = '<div class="muted">Logs endpoint unavailable in this API version.</div>';
    });
}

function renderCommands(m) {
  const el = $("#detailBody");
  apiFetch(`/v1/machines/${m.id}/exec`)
    .then(({ body }) => {
      const cmds = body?.commands ?? body ?? [];
      el.innerHTML = `
        <div class="command-input">
          <input id="cmdInput" type="text" placeholder="e.g. uptime" autocomplete="off" />
          <button class="btn accent" id="cmdRun">Run</button>
        </div>
        <div class="logs" style="height:180px">${cmds.map((c) => `<div class="mono muted">${(c?.command ?? c)?.slice(0, 120)}</div>`).join("")}</div>
      `;
      $("#cmdRun").addEventListener("click", () => runCommand(m, $("#cmdInput").value));
      $("#cmdInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runCommand(m, $("#cmdInput").value); });
    })
    .catch(() => {
      el.innerHTML = '<div class="muted">Commands endpoint unavailable.</div>';
    });
}

function runCommand(m, cmd) {
  if (!cmd.trim()) return;
  const btn = $("#cmdRun");
  if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
  apiFetch(`/v1/machines/${m.id}/exec`, {
    method: "POST",
    body: JSON.stringify({ cmd }),
  })
    .then(({ body }) => {
      toast(`Command "done" (${body?.exit_code ?? ""})`);
      return fetchCommands(m);
    })
    .catch((e) => toast(e.message, "error"))
    .finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = "Run"; }
    });
}

function fetchCommands(m) {
  return apiFetch(`/v1/machines/${m.id}/exec`);
}

function renderMetrics(m) {
  const el = $("#detailBody");
  apiFetch(`/v1/machines/${m.id}/metrics`)
    .then(({ body }) => {
      const data = body ?? {};
      const rows = Object.entries(data).map(([k, v]) => {
        const val = v ?? "—";
        return `<div class="metric-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(val))}</span></div>`;
      }).join("");
      el.innerHTML = `<div class="metric-row" style="gap:12px"><span class="k">Machine</span><span class="v mono">${escapeHtml(m.id ?? "")}</span></div>
        <div class="logs" style="height:240px">${rows || '<div class="muted">No metrics available.</div>'}</div>`;
    })
    .catch(() => {
      el.innerHTML = '<div class="muted">Metrics endpoint unavailable.</div>';
    });
}

function renderTerminal(m) {
  const el = $("#detailBody");
  el.className = "terminal";
  el.textContent = "Connecting… (this uses the browser WebSocket, so the API key is passed in the URL)";
  connectTerminal(m, el);
}

function connectTerminal(m, out) {
  const url = `${API_BASE}/v1/machines/${m.id}/terminal?token=${encodeURIComponent(state.currentKey)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    out.textContent = "Failed to open WebSocket: " + e.message;
    return;
  }
  ws.onopen = () => { out.textContent += "\n[connected]"; out.scrollTop = out.scrollHeight; };
  ws.onmessage = (ev) => { out.textContent += "\n" + ev.data; out.scrollTop = out.scrollHeight; };
  ws.onclose = () => { out.textContent += "\n[closed]"; };
  ws.onerror = () => { out.textContent += "\n[error]"; };
}

/* -------------------------------------------------------------------------- */
/*  Actions                                                                     */
/* -------------------------------------------------------------------------- */

async function performAction(action, id) {
  const map = {
    start: "start",
    stop: "stop",
    suspend: "suspend",
    resume: "resume",
    wake: "wake",
    fork: "fork",
  };
  const label = map[action] ?? action;
  const btn = event?.target.closest("button");
  if (btn) { btn.disabled = true; btn.textContent = `${label}…`; }
  try {
    const method = action === "delete" ? "DELETE" : "POST";
    const link = action === "fork" || action === "wake" || action === "suspend" || action === "resume" ? `fork` : undefined;
    const body = action === "fork" ? JSON.stringify({}) : undefined;
    const meta = { idempotency: crypto.randomUUID() };
    await apiFetch(`/v1/machines/${id}/${action}`, { method, body, ...meta });
    toast(`Machine ${label}d`);
    await fetchMachines(true);
  } catch (e) {
    toast(e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/* -------------------------------------------------------------------------- */
/*  Snapshots                                                                   */
/* -------------------------------------------------------------------------- */

async function fetchSnapshots(m) {
  try {
    const { body } = await apiFetch(`/v1/machines/${m.id}/snapshots`);
    return (body && body.snapshots) ?? [];
  } catch {
    return [];
  }
}

async function createSnapshot(m) {
  try {
    const { body } = await apiFetch(`/v1/machines/${m.id}/snapshot`, { method: "POST", body: JSON.stringify({}) });
    toast("Snapshot created");
    return body;
  } catch (e) {
    toast(e.message, "error");
    return null;
  }
}

async function restoreSnapshot(m, snapId) {
  try {
    const { body } = await apiFetch(`/v1/snapshots/${snapId}/restore`, { method: "POST", body: JSON.stringify({}) });
    toast("Snapshot restore requested");
    return body;
  } catch (e) {
    toast(e.message, "error");
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Boot                                                                          */
/* -------------------------------------------------------------------------- */

function init() {
  loadKeys();
  renderKeybar();
  renderKeyList();

  $("#addKeyBtn").addEventListener("click", () => openKeyModal());
  $("#switchKeyBtn").addEventListener("click", () => {
    const next = state.keys.find((k) => k.value !== state.currentKey);
    if (!next) return toast("No other key to switch to.");
    state.currentKey = next.value;
    saveKeys();
    renderKeybar();
    refreshMachines();
  });
  $("#removeKeyBtn").addEventListener("click", () => {
    if (!state.currentKey) return;
    if (!confirm("Remove this API key?")) return;
    state.keys = state.keys.filter((k) => k.value !== state.currentKey);
    if (state.currentKey) state.currentKey = state.keys[0]?.value ?? null;
    saveKeys();
    renderKeybar();
    renderKeyList();
    toast("Key removed");
  });

  $("#exportKeyBtn").addEventListener("click", exportKeys);
  $("#importKeyBtn").addEventListener("click", () => $("#importKeyInput").click());
  $("#exportKeyBtn2").addEventListener("click", exportKeys);
  $("#importKeyBtn2").addEventListener("click", () => $("#importKeyInput2").click());
  $("#importKeyInput").addEventListener("change", handleImportFile);
  $("#importKeyInput2").addEventListener("change", handleImportFile);

  $("#keyForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#keyName").value.trim();
    const value = $("#keyValue").value.trim();
    if (!name || !value) return toast("Name and key are required.");
    if (!value.startsWith("ibk_")) toast("Key should start with ibk_.");
    if (state.keys.some((k) => k.value === value)) return toast("Key already added.");
    state.keys.push({ name, value });
    state.currentKey = value;
    saveKeys();
    renderKeybar();
    renderKeyList();
    closeKeyModal();
    toast("Key added");
    refreshMachines();
  });

  $("#searchInput").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    renderMachineList();
  });
  $("#statusFilter").addEventListener("change", (e) => {
    state.statusFilter = e.target.value;
    renderMachineList();
  });
  $("#refreshBtn").addEventListener("click", () => fetchMachines(true));
  $("#refreshViaActionsBtn").addEventListener("click", onRefreshViaActions);

  // Close modals on backdrop click
  $$("[data-close]").forEach((el) => {
    el.addEventListener("click", () => {
      const modal = el.closest(".modal");
      if (modal) modal.hidden = true;
    });
  });

  // Detail modal tabs
  $("#detailPanel").addEventListener("click", (e) => {
    const tab = e.target.closest(".detail-tab");
    if (tab) renderDetailTab(tab.dataset.tab);
  });

  // Keyboard: Escape closes modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAllModals();
      $("#searchInput").blur();
    }
  });

  fetchMachines();
}

document.addEventListener("DOMContentLoaded", init);
