/* Instabox Panel — machine manager UI.
 *
 * Plain HTML/CSS/JS, no build step. All REST calls go through the same-origin
 * /api proxy (Cloudflare Pages Functions) when it is present, so the browser
 * never hits the API's missing CORS headers. Locally, or on a static host with
 * no proxy, calls fall back to the API directly.
 */
(() => {
  "use strict";

  const API_BASE = "https://api.instabox.sh";
  const PROXY_PREFIX = "/api";
  // If this copy has no same-origin proxy (e.g. GitHub Pages), use the deployed one.
  const REMOTE_PROXY = "https://instabox-panel-web.pages.dev/api";
  const STORAGE_KEY = "instabox_panel_keys";

  const state = {
    keys: [],
    currentKey: null,
    machines: [],
    selectedId: null,
    detail: null,
    loading: false,
    loaded: false,
    error: null,
    search: "",
    statusFilter: "",
    tab: "overview",
    proxy: null, // null = unknown, "local" = same-origin /api, "remote" = deployed proxy
    keyErrors: {}, // key name -> error message, when only some keys fail
    busy: new Set(),
    logTimer: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* -------------------------------------------------------------- helpers */

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  const icon = (name) =>
    `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

  const shortKey = (key) =>
    key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : key;

  const stateLabel = (s) =>
    (s || "unknown").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const fmtBytes = (n) => {
    if (n === null || n === undefined || n === "") return "—";
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    if (v < 1024) return `${v} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let i = -1;
    let x = v;
    do { x /= 1024; i += 1; } while (x >= 1024 && i < units.length - 1);
    return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[i]}`;
  };

  const fmtSecs = (n) => {
    if (!n && n !== 0) return "—";
    const s = Number(n);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  };

  const fmtTime = (iso) => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "—";
    return new Date(t).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  };

  const relTime = (iso) => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "—";
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  const fmtUptime = (iso) => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "—";
    return fmtSecs(Math.floor((Date.now() - t) / 1000));
  };

  /* ---------------------------------------------------------------- toast */

  let toastTimer = null;
  function toast(message, type = "success") {
    const el = $("#toast");
    el.hidden = false;
    el.dataset.type = type;
    el.innerHTML = `${icon(type === "error" ? "alert" : "check")}<span>${escapeHtml(message)}</span>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  /* ------------------------------------------------------------ confirm */

  function confirmDialog(title, message, confirmLabel = "Confirm") {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "dialog";
      dialog.innerHTML = `
        <form method="dialog" class="dialog-form">
          <div class="dialog-head"><h2 class="dialog-title">${escapeHtml(title)}</h2></div>
          <p class="dialog-sub">${escapeHtml(message)}</p>
          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">${escapeHtml(confirmLabel)}</button>
          </div>
        </form>`;
      document.body.appendChild(dialog);
      const done = (value) => {
        dialog.removeEventListener("close", onClose);
        resolve(value);
        dialog.remove();
      };
      const onClose = () => done(false);
      dialog.addEventListener("close", onClose);
      $('[data-act="cancel"]', dialog).addEventListener("click", () => dialog.close());
      dialog.addEventListener("submit", (e) => { e.preventDefault(); done(true); });
      dialog.showModal();
    });
  }

  /* ------------------------------------------------------------------ api */

  async function detectProxy() {
    try {
      const res = await fetch(`${PROXY_PREFIX}/health`, { headers: { Accept: "application/json" } });
      state.proxy = res.ok ? "local" : "remote";
    } catch {
      state.proxy = "remote";
    }
    renderConn();
  }

  async function api(path, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const headers = new Headers();
    if (opts.body !== undefined) headers.set("Content-Type", "application/json");
    if (opts.accept) headers.set("Accept", opts.accept);
    const apiKey = opts.apiKey || state.currentKey;
    if (apiKey) headers.set("X-API-Key", apiKey);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && opts.idempotency !== false) {
      headers.set("Idempotency-Key", opts.idempotency || crypto.randomUUID());
    }
    if (opts.confirmDelete) headers.set("X-Confirm-Delete", opts.confirmDelete);

    const base = state.proxy === "local" ? PROXY_PREFIX : REMOTE_PROXY;
    const url = base + path;
    const init = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw {
        status: 0,
        code: "network",
        message: "The panel proxy could not be reached. Check your connection and retry.",
        retryable: true,
      };
    }

    const type = res.headers.get("content-type") || "";
    let body = null;
    if (type.includes("application/json")) {
      try { body = await res.json(); } catch { body = null; }
    } else if (type.includes("text/")) {
      body = await res.text();
    }

    if (!res.ok) {
      const err = (body && body.error) || {};
      throw {
        status: res.status,
        code: err.code || `http_${res.status}`,
        message: err.message || res.statusText || `Request failed (${res.status})`,
        hint: err.hint,
        retryable: err.retryable,
        raw: body,
      };
    }
    return { res, status: res.status, body };
  }

  /* ----------------------------------------------------------- key storage */

  function loadKeys() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      state.keys = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.keys)) state.keys = [];
    } catch {
      state.keys = [];
    }
    if (!state.keys.some((k) => k.value === state.currentKey)) {
      state.currentKey = state.keys[0]?.value ?? null;
    }
  }

  function saveKeys() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.keys));
  }

  /* -------------------------------------------------------------- rendering */

  function renderConn() {
    const conn = $("#conn");
    const text = $(".conn-text", conn);
    conn.dataset.state = "idle";
    if (state.proxy === null) { text.textContent = "Checking…"; return; }
    if (state.error && !state.machines.length) {
      conn.dataset.state = "error";
      text.textContent = state.error.status === 401 ? "Key rejected" : "API unreachable";
      conn.title = state.error.message;
      return;
    }
    conn.dataset.state = "ok";
    text.textContent = "API proxy";
    conn.title = state.proxy === "local"
      ? "Same-origin /api proxy — no CORS"
      : "Using the panel proxy at instabox-panel-web.pages.dev";
  }

  function renderKeySelect() {
    const select = $("#keySelect");
    select.innerHTML = "";
    if (!state.keys.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No key";
      select.appendChild(opt);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const key of state.keys) {
      const opt = document.createElement("option");
      opt.value = key.value;
      opt.textContent = `${key.name} · ${shortKey(key.value)}`;
      opt.selected = key.value === state.currentKey;
      select.appendChild(opt);
    }
  }

  function renderKeyList() {
    const list = $("#keyList");
    if (!list) return;
    list.innerHTML = "";
    if (!state.keys.length) {
      list.innerHTML = `<p class="field-hint" style="margin:0">No keys stored in this browser yet.</p>`;
      return;
    }
    for (const key of state.keys) {
      const row = document.createElement("div");
      row.className = "key-item" + (key.value === state.currentKey ? " active" : "");
      row.innerHTML = `
        <div>
          <div class="key-item-name">${escapeHtml(key.name)}</div>
          <div class="key-item-value">${escapeHtml(shortKey(key.value))}</div>
        </div>
        <div class="key-item-actions">
          ${key.value === state.currentKey
            ? '<span class="snap-status ready">Active</span>'
            : '<button type="button" class="btn btn-sm" data-act="use">Use</button>'}
          <button type="button" class="btn btn-sm btn-danger" data-act="remove">Remove</button>
        </div>`;
      const useBtn = $('[data-act="use"]', row);
      if (useBtn) {
        useBtn.addEventListener("click", () => {
          state.currentKey = key.value;
          saveKeys();
          renderAll();
          fetchMachines(true);
        });
      }
      $('[data-act="remove"]', row).addEventListener("click", async () => {
        const ok = await confirmDialog("Remove API key?", `Remove “${key.name}” from this browser? The key itself is not revoked at Instabox.`, "Remove key");
        if (!ok) return;
        state.keys = state.keys.filter((k) => k.value !== key.value);
        if (state.currentKey === key.value) state.currentKey = state.keys[0]?.value ?? null;
        saveKeys();
        renderAll();
        fetchMachines(true);
      });
      list.appendChild(row);
    }
  }

  function rowActions(m) {
    if (state.busy.has(m.id)) return [];
    if (m.state === "running") return [{ act: "suspend", label: "Pause", icon: "i-pause" }];
    if (m.state === "suspended") return [{ act: "resume", label: "Resume", icon: "i-play" }];
    if (m.state === "stopped" || m.state === "error") return [{ act: "start", label: "Start", icon: "i-play" }];
    return [];
  }

  function filteredMachines() {
    const q = state.search.trim().toLowerCase();
    return state.machines.filter((m) => {
      if (q) {
        const hay = `${m.name || ""} ${m.id || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (state.statusFilter && m.state !== state.statusFilter) return false;
      return true;
    });
  }

  function renderList() {
    const list = $("#machineList");
    const status = $("#listStatus");

    if (state.loading && !state.loaded) {
      list.innerHTML = Array.from({ length: 6 }, () => `
        <div class="sk-row">
          <span class="sk" style="width:8px;height:8px;border-radius:50%"></span>
          <span class="sk" style="height:12px"></span>
          <span class="sk" style="width:52px;height:10px"></span>
        </div>`).join("");
      status.textContent = "Loading machines…";
      return;
    }

    if (state.error) {
      list.innerHTML = "";
      const banner = document.createElement("div");
      banner.className = "banner";
      banner.innerHTML = `<strong>${escapeHtml(state.error.message)}</strong>` +
        (state.error.hint ? `<div style="margin-top:4px">${escapeHtml(state.error.hint)}</div>` : "") +
        `<div style="margin-top:8px"><button class="btn btn-sm btn-ghost" data-act="retry">Retry</button></div>`;
      $("[data-act='retry']", banner).addEventListener("click", () => fetchMachines(true));
      list.appendChild(banner);
      status.textContent = "Could not load machines";
      renderConn();
      return;
    }

    if (!state.currentKey) {
      list.innerHTML = `<div class="list-empty"><strong>No API key</strong>Add an Instabox API key to list your machines.<div style="margin-top:12px"><button class="btn btn-primary btn-sm" data-act="add-key">${icon("i-plus")}<span>Add API key</span></button></div></div>`;
      status.textContent = "";
      return;
    }

    const rows = filteredMachines();
    if (!state.machines.length) {
      list.innerHTML = `<div class="list-empty"><strong>No machines</strong>This account has no sandboxes yet.</div>`;
      status.textContent = "0 machines";
      return;
    }
    if (!rows.length) {
      list.innerHTML = `<div class="list-empty"><strong>Nothing matches</strong>Try a different search or status filter.</div>`;
      status.textContent = `${state.machines.length} machine${state.machines.length === 1 ? "" : "s"}`;
      return;
    }

    list.innerHTML = "";
    const errNames = Object.keys(state.keyErrors);
    if (errNames.length) {
      const banner = document.createElement("div");
      banner.className = "banner";
      banner.innerHTML = `<strong>Could not load machines for ${escapeHtml(errNames.join(", "))}.</strong>` +
        `<div style="margin-top:4px">${escapeHtml(state.keyErrors[errNames[0]].message)}</div>`;
      list.appendChild(banner);
    }
    for (const m of rows) {
      const row = document.createElement("button");
      row.className = "mrow";
      row.type = "button";
      row.dataset.state = m.state || "unknown";
      row.setAttribute("aria-selected", String(m.id === state.selectedId));
      const acts = rowActions(m);
      row.innerHTML = `
        <span class="dot" data-state="${escapeHtml(m.state || "unknown")}"></span>
        <span class="mrow-main">
          <span class="mrow-name">${escapeHtml(m.name || "Unnamed")}</span>
          <span class="mrow-id">${escapeHtml(m.id || "")}</span>
        </span>
        <span class="mrow-actions">${acts.map((a) => `
          <button type="button" class="rowbtn" data-act="${a.act}" data-id="${escapeHtml(m.id)}" title="${a.label}" aria-label="${a.label} ${escapeHtml(m.name || "")}">${icon(a.icon)}</button>`).join("")}
        </span>
        <span class="mrow-state">${escapeHtml(stateLabel(m.state))}</span>`;
      row.addEventListener("click", () => selectMachine(m.id));
      row.querySelectorAll(".rowbtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const target = state.machines.find((x) => x.id === btn.dataset.id);
          if (target) void performAction(btn.dataset.act, target);
        });
      });
      list.appendChild(row);
    }
    status.innerHTML = `<span>${rows.length} of ${state.machines.length} machine${state.machines.length === 1 ? "" : "s"}</span><span>Updated ${escapeHtml(relTime(state.lastFetch))}</span>`;
  }

  function availableActions(m) {
    const s = m.state;
    const busy = Boolean(m.operationId) || state.busy.has(m.id);
    const acts = [];
    const can = (...states) => states.includes(s) && !busy;
    if (can("stopped", "suspended", "error")) acts.push({ act: "start", label: "Start", icon: "i-play", cls: "btn-primary" });
    if (can("suspended")) acts.push({ act: "resume", label: "Resume", icon: "i-play" });
    if (can("suspended")) acts.push({ act: "wake", label: "Wake", icon: "i-bolt" });
    if (can("running")) acts.push({ act: "suspend", label: "Pause", icon: "i-pause" });
    if (can("running")) acts.push({ act: "stop", label: "Stop", icon: "i-stop" });
    if (!busy && !["creating", "deleting", "deleted"].includes(s)) acts.push({ act: "fork", label: "Fork", icon: "i-fork" });
    if (!busy && !["deleting", "deleted"].includes(s)) acts.push({ act: "snapshot", label: "Snapshot", icon: "i-camera" });
    if (!["deleting", "deleted"].includes(s)) acts.push({ act: "delete", label: "Delete", icon: "i-trash", cls: "btn-danger" });
    return acts;
  }

  function renderDetail() {
    const empty = $("#detailEmpty");
    const main = $("#detailMain");
    const m = state.detail;

    if (!state.selectedId || !m) {
      empty.hidden = false;
      main.hidden = true;
      return;
    }
    empty.hidden = true;
    main.hidden = false;

    $("#detailName").textContent = m.name || "Unnamed machine";
    $("#detailId").textContent = m.id || "";
    const pill = $("#detailStatus");
    pill.dataset.state = m.state || "unknown";
    $(".label", pill).textContent = stateLabel(m.state);

    const actions = $("#detailActions");
    actions.innerHTML = "";
    for (const a of availableActions(m)) {
      const btn = document.createElement("button");
      btn.className = `btn btn-sm ${a.cls || ""}`.trim();
      btn.innerHTML = `${icon(a.icon)}<span>${a.label}</span>`;
      if (state.busy.has(m.id)) btn.disabled = true;
      btn.addEventListener("click", () => performAction(a.act, m));
      actions.appendChild(btn);
    }

    $$("#detailTabs .tab").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === state.tab));
    });

    renderTab();
  }

  function renderTab(error) {
    const body = $("#detailBody");
    const m = state.detail;
    if (!m) return;
    stopLogTimer();

    if (error) {
      body.innerHTML = `<div class="banner">${escapeHtml(error.message)}</div>`;
      return;
    }

    switch (state.tab) {
      case "logs": renderLogs(m); break;
      case "commands": renderCommands(m); break;
      case "metrics": renderMetrics(m); break;
      case "terminal": renderTerminal(m); break;
      case "snapshots": renderSnapshots(m); break;
      default: renderOverview(m);
    }
  }

  function renderOverview(m) {
    const body = $("#detailBody");
    const spec = m.spec || {};
    const storage = m.storage || {};
    const runtime = m.runtime || {};
    const cards = [
      { k: "State", v: stateLabel(m.state) },
      { k: "vCPUs", v: spec.vcpus ?? "—" },
      { k: "Memory", v: spec.memMiB != null ? `${spec.memMiB} MiB` : "—" },
      { k: "Disk (/data)", v: spec.persistentDiskGiB != null ? `${spec.persistentDiskGiB} GiB` : "—" },
      { k: "Uptime", v: fmtUptime(m.runStartedAt) },
      { k: "Created", v: fmtTime(m.createdAt) },
    ];

    const rows = [
      ["Machine ID", m.id, true],
      ["Name", m.name],
      ["Template", m.template?.id, true],
      ["Guest user", m.guestUser, true],
      ["Desired state", m.desiredState],
      ["Runtime ready", runtime.ready ? "yes" : "no"],
      ["Storage synced", storage.synced ? "yes" : storage.synced === false ? "no" : "—"],
      ["Snapshot sequence", storage.snapshotSeq],
      ["Updated", fmtTime(m.updatedAt)],
      ["Run started", fmtTime(m.runStartedAt)],
      ["Auto-suspend", m.autoSuspendAfterSeconds ? `${fmtSecs(m.autoSuspendAfterSeconds)} idle` : "off"],
      ["Operation", m.operationId, true],
      ["Free tier", m.free ? "yes" : "no"],
      ["Org", m.orgId, true],
    ].filter(([, v]) => v !== undefined && v !== null && v !== "");

    const err = m.lastError
      ? `<div class="banner" style="margin-top:14px"><strong>${escapeHtml(m.lastError.message || m.lastError.code || "Last error")}</strong></div>`
      : "";

    body.innerHTML = `
      <div class="ov-grid">${cards.map((c) => `
        <div class="ov-card"><div class="k">${c.k}</div><div class="v">${escapeHtml(c.v)}</div></div>`).join("")}
      </div>
      <div class="kv">${rows.map(([k, v, mono]) => `
        <div class="kv-row"><div class="k">${k}</div><div class="v${mono ? " mono" : ""}">${escapeHtml(v)}</div></div>`).join("")}
      </div>
      ${err}`;
  }

  /* ----------------------------------------------------------------- logs */

  function stopLogTimer() {
    if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  }

  async function renderLogs(m) {
    const body = $("#detailBody");
    body.innerHTML = `
      <div class="panel-note">Console output and recent operations.</div>
      <div class="term-bar">
        <span class="term-state" id="logState">Loading…</span>
        <button class="btn btn-ghost btn-sm" id="logRefresh">${icon("i-refresh")}<span>Refresh</span></button>
      </div>
      <div class="out" id="logOut"><span class="empty">Loading…</span></div>`;
    $("#logRefresh").addEventListener("click", () => loadLogs(m));
    await loadLogs(m);
    stopLogTimer();
    state.logTimer = setInterval(() => { if (state.tab === "logs") loadLogs(m, true); }, 10000);
  }

  async function loadLogs(m, quiet = false) {
    const out = $("#logOut");
    const status = $("#logState");
    if (!quiet && out) out.innerHTML = `<span class="empty">Loading…</span>`;
    try {
      const { body } = await api(`/v1/machines/${encodeURIComponent(m.id)}/logs`, { apiKey: m._key });
      if (state.selectedId !== m.id || state.tab !== "logs") return;
      const text = body?.console ?? "";
      if (out) {
        out.innerHTML = text
          ? escapeHtml(text)
          : `<span class="empty">No console output${body?.consoleUnavailable ? `: ${escapeHtml(body.consoleUnavailable)}` : "."}</span>`;
        out.scrollTop = out.scrollHeight;
      }
      if (status) status.textContent = body?.state ? `State: ${stateLabel(body.state)}` : "";
    } catch (e) {
      if (state.selectedId !== m.id || state.tab !== "logs") return;
      if (out) out.innerHTML = `<span class="empty">${escapeHtml(e.message)}</span>`;
      if (status) status.textContent = "Unavailable";
    }
  }

  /* ------------------------------------------------------------- commands */

  async function renderCommands(m) {
    const body = $("#detailBody");
    body.innerHTML = `
      <div class="panel-note">Run a shell command with <code class="mono">bash -lc</code> on the machine.</div>
      <div class="cmd-bar">
        <input class="input" id="cmdInput" type="text" placeholder="e.g. uptime" autocomplete="off" spellcheck="false" />
        <button class="btn btn-primary" id="cmdRun">${icon("i-play")}<span>Run</span></button>
      </div>
      <div class="cmd-result" id="cmdResult"></div>
      <div class="section-title">History</div>
      <div class="kv" id="cmdHistory"><div class="kv-row"><div class="k">Loading…</div></div></div>`;

    $("#cmdRun").addEventListener("click", () => runCommand(m));
    $("#cmdInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") runCommand(m);
    });
    $("#cmdInput").focus();

    try {
      const { body } = await api(`/v1/machines/${encodeURIComponent(m.id)}/history`, { apiKey: m._key });
      if (state.selectedId !== m.id || state.tab !== "commands") return;
      const cmds = body?.commands || [];
      $("#cmdHistory").innerHTML = cmds.length
        ? cmds.slice(0, 12).map((c) => `
          <div class="kv-row">
            <div class="k mono">${escapeHtml(c.command)}</div>
            <div class="v"><span class="cmd-exit ${c.exitCode === 0 ? "ok" : "bad"}">exit ${c.exitCode ?? "—"}</span> · ${escapeHtml(relTime(c.endedAt || c.startedAt))}</div>
          </div>`).join("")
        : `<div class="kv-row"><div class="k">No commands recorded yet.</div></div>`;
    } catch {
      if (state.selectedId !== m.id || state.tab !== "commands") return;
      $("#cmdHistory").innerHTML = `<div class="kv-row"><div class="k">History unavailable.</div></div>`;
    }
  }

  async function runCommand(m) {
    const input = $("#cmdInput");
    const btn = $("#cmdRun");
    const result = $("#cmdResult");
    const cmd = input.value.trim();
    if (!cmd) return;
    btn.disabled = true;
    btn.innerHTML = `${icon("i-clock")}<span>Running…</span>`;
    try {
      const { body } = await api(`/v1/machines/${encodeURIComponent(m.id)}/exec`, {
        method: "POST",
        body: { cmd },
        apiKey: m._key,
      });
      const ok = (body?.exitCode ?? 0) === 0 && !body?.timedOut;
      result.innerHTML = `
        <div class="cmd-result-head">
          <span class="cmd-exit ${ok ? "ok" : "bad"}">exit ${body?.exitCode ?? "—"}</span>
          <span class="mono">${escapeHtml(cmd)}</span>
          ${body?.timedOut ? '<span class="snap-status pending">timed out</span>' : ""}
        </div>
        <div class="out">${body?.stderr ? `<div class="out-stderr">${escapeHtml(body.stderr)}</div>` : ""}${escapeHtml(body?.stdout || "(no output)")}</div>`;
      toast(`Command finished (exit ${body?.exitCode ?? "—"})`);
      input.select();
    } catch (e) {
      result.innerHTML = `<div class="banner"><strong>${escapeHtml(e.message)}</strong>${e.hint ? `<div style="margin-top:4px">${escapeHtml(e.hint)}</div>` : ""}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon("i-play")}<span>Run</span>`;
    }
  }

  /* --------------------------------------------------------------- metrics */

  async function renderMetrics(m) {
    const body = $("#detailBody");
    body.innerHTML = `
      <div class="panel-note">Latest sample, taken every 30 seconds.</div>
      <div id="metricBody"><div class="out"><span class="empty">Loading…</span></div></div>`;
    try {
      const { body: data } = await api(`/v1/machines/${encodeURIComponent(m.id)}/metrics`, { apiKey: m._key });
      if (state.selectedId !== m.id || state.tab !== "metrics") return;
      const samples = data?.metrics || [];
      const latest = samples[samples.length - 1];
      if (!latest) {
        $("#metricBody").innerHTML = `<div class="out"><span class="empty">No metrics yet. Metrics appear while the machine is running.</span></div>`;
        return;
      }
      const pct = (latest.cpuUsedPct ?? 0).toFixed(1);
      const mem = latest.memTotal ? Math.round((latest.memUsed / latest.memTotal) * 100) : null;
      const cards = [
        { k: "CPU", v: `${pct}`, unit: "%" },
        { k: "Memory", v: latest.memUsed != null ? fmtBytes(latest.memUsed) : "—", unit: mem != null ? `(${mem}%)` : "" },
        { k: "Network in", v: fmtBytes(latest.netInBytesPerSec), unit: "/s" },
        { k: "Network out", v: fmtBytes(latest.netOutBytesPerSec), unit: "/s" },
        { k: "Disk read", v: fmtBytes(latest.diskReadBytesPerSec), unit: "/s" },
        { k: "Disk write", v: fmtBytes(latest.diskWriteBytesPerSec), unit: "/s" },
      ];
      const fs = data?.disk?.filesystems?.[0];
      $("#metricBody").innerHTML = `
        <div class="metric-grid">${cards.map((c) => `
          <div class="metric"><div class="k">${c.k}</div><div class="v">${escapeHtml(String(c.v))}<small>${c.unit || ""}</small></div></div>`).join("")}
        </div>
        <div class="kv">
          <div class="kv-row"><div class="k">Disk used</div><div class="v">${fs && fs.used != null ? `${fmtBytes(fs.used)} of ${fmtBytes(fs.total)}` : "—"}</div></div>
          <div class="kv-row"><div class="k">CPU count</div><div class="v">${latest.cpuCount ?? "—"}</div></div>
          <div class="kv-row"><div class="k">Sample time</div><div class="v">${escapeHtml(fmtTime(latest.timestamp))}</div></div>
        </div>`;
    } catch (e) {
      $("#metricBody").innerHTML = `<div class="banner">${escapeHtml(e.message)}</div>`;
    }
  }

  /* -------------------------------------------------------------- terminal */

  function renderTerminal(m) {
    const body = $("#detailBody");
    body.innerHTML = `
      <div class="panel-note">A persistent PTY on the machine. Binary output is rendered as text.</div>
      <div class="term">
        <div class="term-bar">
          <span class="term-title">${icon("i-terminal")}<span>PTY · ${escapeHtml(m.guestUser || "user")}</span></span>
          <span class="term-state" id="termState" data-state="idle">disconnected</span>
          <button class="btn btn-ghost btn-sm" id="termToggle">${icon("i-play")}<span>Connect</span></button>
        </div>
        <pre class="out term-out" id="termOut"></pre>
        <div class="term-inputrow">
          <span class="term-prompt">$</span>
          <input class="term-input" id="termInput" type="text" autocomplete="off" spellcheck="false" placeholder="Type a command and press Enter" disabled />
        </div>
      </div>`;

    const out = $("#termOut");
    const stateEl = $("#termState");
    const toggle = $("#termToggle");
    const input = $("#termInput");
    let ws = null;
    const decoder = new TextDecoder();

    const setState = (s, text) => { stateEl.dataset.state = s; stateEl.textContent = text; };

    function append(text) {
      out.textContent += text;
      out.scrollTop = out.scrollHeight;
    }

    function connect() {
      if (ws && ws.readyState <= WebSocket.OPEN) return;
      setState("idle", "connecting…");
      const host = API_BASE.replace(/^https:\/\//, "");
      const url = `wss://${host}/v1/machines/${encodeURIComponent(m.id)}/terminal?cols=120&rows=32&session=panel&token=${encodeURIComponent(m._key || state.currentKey || "")}`;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        setState("error", "failed");
        append(`\n[failed to open: ${e.message}]`);
        return;
      }
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        setState("open", "connected");
        toggle.innerHTML = `${icon("i-close")}<span>Disconnect</span>`;
        input.disabled = false;
        input.focus();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "exit") setState("idle", `exited (${msg.code})`);
            else if (msg.type === "error") setState("error", msg.message || "error");
            else if (msg.type === "taken") setState("error", "opened elsewhere");
          } catch { append(ev.data); }
        } else {
          append(decoder.decode(ev.data, { stream: true }));
        }
      };
      ws.onclose = () => {
        setState("idle", "disconnected");
        toggle.innerHTML = `${icon("i-play")}<span>Connect</span>`;
        input.disabled = true;
        append("\n[disconnected]");
      };
      ws.onerror = () => setState("error", "error");
    }

    function disconnect() {
      if (ws) ws.close();
    }

    toggle.addEventListener("click", () => (ws && ws.readyState === WebSocket.OPEN ? disconnect() : connect()));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const text = input.value + "\n";
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(text));
      input.value = "";
    });

    connect();
  }

  /* ------------------------------------------------------------- snapshots */

  async function renderSnapshots(m) {
    const body = $("#detailBody");
    body.innerHTML = `
      <div class="snap-head">
        <div class="field" style="max-width:280px">
          <input class="input" id="snapName" type="text" placeholder="Snapshot name (a-z, 0-9, -)" autocomplete="off" />
        </div>
        <button class="btn btn-primary btn-sm" id="snapCreate">${icon("i-camera")}<span>Create snapshot</span></button>
      </div>
      <div class="snap-list" id="snapList"><div class="out"><span class="empty">Loading…</span></div></div>`;

    $("#snapCreate").addEventListener("click", async () => {
      const name = $("#snapName").value.trim();
      if (!name) return toast("Enter a snapshot name.", "error");
      const btn = $("#snapCreate");
      btn.disabled = true;
      try {
        await api(`/v1/machines/${encodeURIComponent(m.id)}/snapshots`, {
          method: "POST", body: { name }, apiKey: m._key,
        });
        toast(`Snapshot “${name}” queued`);
        $("#snapName").value = "";
        await loadSnapshots(m);
      } catch (e) {
        toast(e.message, "error");
      } finally {
        btn.disabled = false;
      }
    });

    await loadSnapshots(m);
  }

  async function loadSnapshots(m) {
    const list = $("#snapList");
    try {
      const { body } = await api(`/v1/machines/${encodeURIComponent(m.id)}/snapshots`, { apiKey: m._key });
      if (state.selectedId !== m.id || state.tab !== "snapshots") return;
      const snaps = body?.snapshots || [];
      if (!snaps.length) {
        list.innerHTML = `<div class="out"><span class="empty">No snapshots for this machine.</span></div>`;
        return;
      }
      list.innerHTML = snaps.map((s) => `
        <div class="snap">
          <div>
            <div class="snap-name">${escapeHtml(s.name)}</div>
            <div class="snap-meta mono">${escapeHtml(s.id)} · ${escapeHtml(fmtTime(s.createdAt))} · ${escapeHtml(fmtBytes(s.dataSizeBytes || s.rootSizeBytes))}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="snap-status ${escapeHtml(s.status || "ready")}">${escapeHtml(s.status || "ready")}</span>
            <button class="btn btn-ghost btn-sm" data-snap="${escapeHtml(s.id)}" ${s.status && s.status !== "ready" ? "disabled" : ""}>Restore</button>
          </div>
        </div>`).join("");
      $$("#snapList [data-snap]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.snap;
          const ok = await confirmDialog("Restore snapshot?", "The machine's disks are put back to this snapshot, in place. This replaces its current state.", "Restore");
          if (!ok) return;
          try {
            await api(`/v1/machines/${encodeURIComponent(m.id)}/restore`, {
              method: "POST", body: { snapshotId: id }, apiKey: m._key,
            });
            toast("Restore queued");
          } catch (e) {
            toast(e.message, "error");
          }
        });
      });
    } catch (e) {
      list.innerHTML = `<div class="banner">${escapeHtml(e.message)}</div>`;
    }
  }

  /* --------------------------------------------------------------- actions */

  async function performAction(action, m) {
    if (state.busy.has(m.id)) return;

    if (action === "delete") {
      const ok = await confirmDialog(
        "Delete machine?",
        `Delete “${m.name}” (${m.id})? Its system files and storage are removed. This cannot be undone.`,
        "Delete machine"
      );
      if (!ok) return;
    }

    const def = {
      start: { method: "POST", path: `/v1/machines/${encodeURIComponent(m.id)}/start`, body: {} },
      stop: { method: "POST", path: `/v1/machines/${encodeURIComponent(m.id)}/stop`, body: {} },
      suspend: { method: "POST", path: `/v1/machines/${encodeURIComponent(m.id)}/suspend`, body: {} },
      resume: { method: "POST", path: `/v1/machines/${encodeURIComponent(m.id)}/resume`, body: {} },
      wake: { method: "POST", path: `/v1/machines/${encodeURIComponent(m.id)}/wake`, body: {} },
      fork: { method: "POST", path: `/v1/machines/${encodeURIComponent(m.id)}/fork`, body: {} },
      snapshot: { method: "POST", path: `/v1/machines/${encodeURIComponent(m.id)}/snapshots`, body: {} },
      delete: { method: "DELETE", path: `/v1/machines/${encodeURIComponent(m.id)}`, confirmDelete: m.id },
    }[action];

    if (!def) return;
    state.busy.add(m.id);
    renderDetail();

    try {
      const { body } = await api(def.path, {
        method: def.method,
        body: def.body,
        confirmDelete: def.confirmDelete,
        apiKey: m._key,
      });
      const opId = body?.id || body?.operationId;
      const label = { start: "Start", stop: "Stop", suspend: "Pause", resume: "Resume", wake: "Wake", fork: "Fork", snapshot: "Snapshot", delete: "Delete" }[action];
      toast(opId ? `${label} queued · operation ${opId}` : `${label} requested`);
      await fetchMachines(true);
      if (action === "delete" && state.selectedId === m.id) selectMachine(null);
    } catch (e) {
      toast(e.message || "Action failed", "error");
    } finally {
      state.busy.delete(m.id);
      renderDetail();
    }
  }

  /* ------------------------------------------------------------ selection */

  function selectMachine(id) {
    state.selectedId = id;
    state.detail = id ? state.machines.find((m) => m.id === id) || null : null;
    state.tab = "overview";
    renderList();
    renderDetail();
    if (window.matchMedia("(max-width: 900px)").matches) {
      document.body.classList.toggle("show-detail", Boolean(id));
    }
    if (id) void loadDetail();
  }

  async function loadDetail() {
    const id = state.selectedId;
    const { body } = await api(`/v1/machines/${encodeURIComponent(id)}`, { apiKey: state.detail?._key });
    if (state.selectedId !== id) return;
    const key = (state.detail && state.detail._key) || state.currentKey;
    state.detail = { ...body, _key: key };
    const idx = state.machines.findIndex((m) => m.id === id);
    if (idx >= 0) state.machines[idx] = { ...body, _key: key };
    renderList();
    renderDetail();
  }

  /* -------------------------------------------------------------- machines */

  async function fetchMachines(force = false) {
    if (state.loading && !force) return;
    if (!state.keys.length) {
      state.machines = [];
      state.loaded = false;
      state.error = null;
      state.keyErrors = {};
      renderList();
      renderConn();
      return;
    }
    state.loading = true;
    state.error = null;
    state.keyErrors = {};
    renderList();

    // Ask every saved key and merge, so one dashboard shows all machines.
    const results = await Promise.all(state.keys.map(async (k) => {
      try {
        const { body } = await api("/v1/machines", { apiKey: k.value });
        return { name: k.name, key: k.value, machines: body?.machines || [] };
      } catch (e) {
        return { name: k.name, key: k.value, error: e };
      }
    }));

    const merged = new Map();
    for (const r of results) {
      if (r.error) { state.keyErrors[r.name] = r.error; continue; }
      for (const m of r.machines) {
        if (!merged.has(m.id)) merged.set(m.id, { ...m, _key: r.key });
      }
    }

    const rank = { running: 0, creating: 1, starting: 1, resuming: 1, suspended: 2, stopping: 3, suspending: 3, deleting: 3, stopped: 4, error: 5, deleted: 6 };
    state.machines = [...merged.values()].sort((a, b) => {
      const d = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
      return d !== 0 ? d : String(a.name || "").localeCompare(String(b.name || ""));
    });

    state.loaded = true;
    state.lastFetch = new Date().toISOString();

    if (!state.machines.length && Object.keys(state.keyErrors).length) {
      state.error = Object.values(state.keyErrors)[0];
      if (!state.error.hint) state.error.hint = "Check that API key and its scopes.";
    }

    if (state.selectedId && !state.machines.some((m) => m.id === state.selectedId)) {
      state.selectedId = null;
      state.detail = null;
      document.body.classList.remove("show-detail");
    }
    renderConn();
    renderList();
    renderDetail();
    state.loading = false;
    renderList();
    renderDetail();
  }

  /* ------------------------------------------------------------ key dialog */

  function openKeyDialog() {
    renderKeyList();
    $("#keyName").value = "";
    $("#keyValue").value = "";
    $("#keyDialog").showModal();
    $("#keyName").focus();
  }

  function exportKeys() {
    if (!state.keys.length) return toast("No keys to export.", "error");
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), keys: state.keys }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `instabox-panel-keys-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Keys exported");
  }

  function importKeys(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.keys)) throw new Error("expected a JSON object with a 'keys' array");
        let added = 0;
        for (const k of data.keys) {
          if (!k?.name || !k?.value) continue;
          if (state.keys.some((x) => x.value === k.value)) continue;
          state.keys.push({ name: String(k.name), value: String(k.value) });
          added += 1;
        }
        saveKeys();
        renderAll();
        toast(added ? `Imported ${added} key${added === 1 ? "" : "s"}` : "No new keys in that file");
      } catch (e) {
        toast(`Import failed: ${e.message}`, "error");
      }
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------ boot */

  function renderAll() {
    renderConn();
    renderKeySelect();
    renderControls();
    renderKeyList();
    renderList();
    renderDetail();
  }

  function renderControls() {
    const hasKey = Boolean(state.currentKey);
    $("#searchInput").disabled = !hasKey;
    $("#statusFilter").disabled = !hasKey;
    $("#refreshBtn").disabled = !hasKey;
  }

  function init() {
    loadKeys();
    renderAll();

    $("#addKeyBtn").addEventListener("click", openKeyDialog);
    $("#keyDialogClose").addEventListener("click", () => $("#keyDialog").close());
    $("#keyForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#keyName").value.trim();
      const value = $("#keyValue").value.trim();
      if (!name || !value) return toast("Name and key are required.", "error");
      if (!value.startsWith("ibk_")) toast("That does not look like an API key (expected ibk_…).", "error");
      if (state.keys.some((k) => k.value === value)) return toast("That key is already saved.", "error");
      state.keys.push({ name, value });
      state.currentKey = value;
      saveKeys();
      renderAll();
      $("#keyDialog").close();
      toast("API key added");
      void fetchMachines(true);
    });

    $("#exportKeysBtn").addEventListener("click", exportKeys);
    $("#importKeysBtn").addEventListener("click", () => $("#importKeyInput").click());
    $("#importKeyInput").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) importKeys(file);
      e.target.value = "";
    });

    $("#keySelect").addEventListener("change", (e) => {
      state.currentKey = e.target.value || null;
      saveKeys();
      renderAll();
      void fetchMachines(true);
    });

    $("#searchInput").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderList();
    });
    $("#statusFilter").addEventListener("change", (e) => {
      state.statusFilter = e.target.value;
      renderList();
    });
    $("#refreshBtn").addEventListener("click", () => fetchMachines(true));
    $("#machineList").addEventListener("click", (e) => {
      if (e.target.closest('[data-act="add-key"]')) openKeyDialog();
    });

    $("#detailTabs").addEventListener("click", (e) => {
      const tab = e.target.closest(".tab");
      if (!tab) return;
      state.tab = tab.dataset.tab;
      renderDetail();
    });

    $("#backBtn").addEventListener("click", () => {
      document.body.classList.remove("show-detail");
      selectMachine(null);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("#keyDialog").open) $("#keyDialog").close();
      if (window.matchMedia("(max-width: 900px)").matches) {
        document.body.classList.remove("show-detail");
        selectMachine(null);
      }
    });

    void detectProxy().then(() => fetchMachines(true));
  }

  document.addEventListener("DOMContentLoaded", init);
})();
