/**
 * Kiosk Dashboard - Single-file Bun fullstack server
 *
 * Remote control for the HDMI kiosk display. Navigate the kiosk Chrome
 * to any app or URL via Chrome DevTools Protocol (CDP).
 *
 * Usage: bun run kiosk-dashboard.ts
 * Then open http://localhost:3459
 */

import { serve } from "bun";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const PORT = 3459;
const CDP_PORT = 9222;
const HISTORY_FILE = "./kiosk-history.json";
const MAX_HISTORY = 50;
const HOSTNAME = require("os").hostname();

function getLanIp(): string {
  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

// ── Registered Apps ─────────────────────────────────────────────────────────

interface App {
  id: string;
  name: string;
  icon: string;
  url: string;
  description: string;
}

function getApps(): App[] {
  const ip = getLanIp();
  return [
    { id: "retrobox", name: "Retrobox", icon: "🕹️", url: `http://${ip}:3333`, description: "Retro gaming emulator" },
    { id: "wifi", name: "WiFi Manager", icon: "📶", url: `http://${ip}:3457`, description: "Network settings" },
    { id: "bluetooth", name: "Bluetooth", icon: "🔵", url: `http://${ip}:3456`, description: "Controller pairing" },
    { id: "remotepad", name: "RemotePad", icon: "🎮", url: `http://${ip}:3458`, description: "PS4 controller bridge" },
  ];
}

// ── History Persistence ─────────────────────────────────────────────────────

interface HistoryEntry {
  url: string;
  title: string;
  timestamp: number;
}

function loadHistory(): HistoryEntry[] {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveHistory(history: HistoryEntry[]) {
  try { writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch {}
}

function addHistory(url: string, title?: string) {
  const history = loadHistory();
  // Remove duplicate if exists
  const filtered = history.filter(h => h.url !== url);
  filtered.unshift({ url, title: title || url, timestamp: Date.now() });
  saveHistory(filtered.slice(0, MAX_HISTORY));
}

function removeHistory(index: number) {
  const history = loadHistory();
  if (index >= 0 && index < history.length) {
    history.splice(index, 1);
    saveHistory(history);
  }
}

// ── CDP (Chrome DevTools Protocol) ──────────────────────────────────────────

async function getCdpTarget(): Promise<{ webSocketDebuggerUrl: string; url: string; title: string } | null> {
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
    const targets = await resp.json() as any[];
    // Find the first "page" target
    const page = targets.find((t: any) => t.type === "page");
    return page || null;
  } catch {
    return null;
  }
}

let cdpId = 1;

async function cdpSend(ws: WebSocket, method: string, params?: any): Promise<any> {
  const id = cdpId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP timeout")), 5000);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.id === id) {
        ws.removeEventListener("message", handler);
        clearTimeout(timeout);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function navigateKiosk(url: string, recordHistory = true): Promise<{ ok: boolean; error?: string }> {
  try {
    const target = await getCdpTarget();
    if (!target) return { ok: false, error: "Kiosk not reachable (CDP)" };

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket connect failed"));
      setTimeout(() => reject(new Error("WebSocket timeout")), 3000);
    });

    await cdpSend(ws, "Page.navigate", { url });
    ws.close();

    if (recordHistory) {
      addHistory(url, url);
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function getKioskStatus(): Promise<{ connected: boolean; url: string; title: string }> {
  try {
    const target = await getCdpTarget();
    if (!target) return { connected: false, url: "", title: "" };
    return { connected: true, url: target.url, title: target.title };
  } catch {
    return { connected: false, url: "", title: "" };
  }
}

// ── HTML Dashboard ──────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kiosk Dashboard</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📺</text></svg>">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; min-height: 100vh; }

  .container { max-width: 640px; margin: 0 auto; padding: 16px; }

  /* Header */
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; margin-bottom: 20px; border-bottom: 1px solid #222; }
  header h1 { font-size: 20px; font-weight: 600; line-height: 1.2; }
  header .hostname { font-size: 11px; color: #555; font-weight: 400; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 8px; }
  .status-dot.online { background: #4CAF50; box-shadow: 0 0 6px #4CAF5088; }
  .status-dot.offline { background: #666; }
  .current-url { font-size: 12px; color: #888; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header h1 { cursor: pointer; user-select: none; transition: opacity 0.2s; }
  header h1:hover { opacity: 0.7; }
  header h1:active { opacity: 0.5; }

  /* Navigate input */
  .nav-bar { display: flex; gap: 8px; margin-bottom: 20px; }
  .nav-bar input { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px 14px; color: #e0e0e0; font-size: 15px; outline: none; transition: border-color 0.2s; }
  .nav-bar input:focus { border-color: #4a9eff; }
  .nav-bar input::placeholder { color: #555; }
  .nav-bar button { background: #4a9eff; color: #fff; border: none; border-radius: 8px; padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; white-space: nowrap; }
  .nav-bar button:hover { background: #3a8eef; }
  .nav-bar button:active { background: #2a7edf; }

  /* App grid */
  .section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 10px; font-weight: 600; }
  .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 24px; }
  .app-card { background: #1a1a1a; border: 1px solid #282828; border-radius: 10px; padding: 16px 12px; text-align: center; cursor: pointer; transition: all 0.2s; }
  .app-card:hover { border-color: #444; background: #222; transform: translateY(-1px); }
  .app-card:active { transform: translateY(0); }
  .app-card.active { border-color: #4a9eff; background: #1a2a3a; }
  .app-card .icon { font-size: 32px; margin-bottom: 8px; }
  .app-card .name { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
  .app-card .desc { font-size: 11px; color: #666; }

  /* History */
  .history-list { list-style: none; }
  .history-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #1a1a1a; border: 1px solid #222; border-radius: 8px; margin-bottom: 6px; cursor: pointer; transition: all 0.15s; }
  .history-item:hover { border-color: #333; background: #1e1e1e; }
  .history-item .hist-info { flex: 1; overflow: hidden; }
  .history-item .hist-title { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .history-item .hist-url { font-size: 11px; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .history-item .hist-time { font-size: 11px; color: #555; white-space: nowrap; }
  .history-item .hist-delete { background: none; border: none; color: #555; font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 4px; transition: all 0.15s; }
  .history-item .hist-delete:hover { color: #f44336; background: #2a1a1a; }
  .empty { text-align: center; color: #444; padding: 20px; font-size: 14px; }

  /* Toast */
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; }
  .toast.visible { opacity: 1; }
  .toast.error { background: #c62828; }
  .toast.success { background: #2e7d32; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div><h1>📺 Kiosk Dashboard</h1><div class="hostname" id="hostnameText"></div></div>
    <div style="text-align:right">
      <div><span class="status-dot" id="statusDot"></span><span id="statusText">Checking...</span></div>
      <div class="current-url" id="currentUrl"></div>
    </div>
  </header>

  <div class="nav-bar">
    <input type="text" id="urlInput" placeholder="Enter URL or search history..." autocomplete="off" autocapitalize="off" spellcheck="false">
    <button id="goBtn">Go</button>
  </div>

  <div class="section-title">Apps</div>
  <div class="app-grid" id="appGrid"></div>

  <div class="section-title">Recent</div>
  <ul class="history-list" id="historyList"></ul>
</div>
<div class="toast" id="toast"></div>

<script>
const $ = id => document.getElementById(id);
const appGrid = $('appGrid');
const historyList = $('historyList');
const urlInput = $('urlInput');
const goBtn = $('goBtn');
const toast = $('toast');
const statusDot = $('statusDot');
const statusText = $('statusText');
const currentUrl = $('currentUrl');

let apps = [];
let history = [];
let toastTimer = null;

function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = 'toast visible ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.className = 'toast', 2500);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function fuzzyMatch(query, text) {
  query = query.toLowerCase();
  text = text.toLowerCase();
  if (text.includes(query)) return true;
  let qi = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

async function navigate(url, recordHistory = true) {
  if (!url) return;
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
    url = 'http://' + url;
  }
  goBtn.textContent = '...';
  goBtn.disabled = true;
  try {
    const resp = await fetch('/api/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, recordHistory }) });
    const data = await resp.json();
    if (data.ok) {
      showToast('Navigated to ' + url);
      urlInput.value = '';
      if (recordHistory) loadHistory();
      loadStatus();
    } else {
      showToast(data.error || 'Navigation failed', 'error');
    }
  } catch (e) {
    showToast('Request failed', 'error');
  }
  goBtn.textContent = 'Go';
  goBtn.disabled = false;
}

function renderApps(kioskUrl) {
  appGrid.innerHTML = '';
  for (const app of apps) {
    const card = document.createElement('div');
    card.className = 'app-card' + (kioskUrl && kioskUrl.startsWith(app.url) ? ' active' : '');
    card.innerHTML = '<div class="icon">' + app.icon + '</div><div class="name">' + app.name + '</div><div class="desc">' + app.description + '</div>';
    card.onclick = () => navigate(app.url, false);
    appGrid.appendChild(card);
  }
}

function renderHistory() {
  const query = urlInput.value.trim();
  const filtered = query ? history.filter(h => fuzzyMatch(query, h.url) || fuzzyMatch(query, h.title)) : history;

  if (filtered.length === 0) {
    historyList.innerHTML = '<li class="empty">' + (query ? 'No matches' : 'No recent history') + '</li>';
    return;
  }

  historyList.innerHTML = '';
  for (let i = 0; i < filtered.length; i++) {
    const h = filtered[i];
    const origIdx = history.indexOf(h);
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML =
      '<div class="hist-info"><div class="hist-title">' + escHtml(h.title) + '</div><div class="hist-url">' + escHtml(h.url) + '</div></div>' +
      '<span class="hist-time">' + timeAgo(h.timestamp) + '</span>' +
      '<button class="hist-delete" data-idx="' + origIdx + '" title="Remove">✕</button>';
    li.querySelector('.hist-info').onclick = () => navigate(h.url);
    li.querySelector('.hist-delete').onclick = async (e) => {
      e.stopPropagation();
      await fetch('/api/history/' + origIdx, { method: 'DELETE' });
      loadHistory();
    };
    historyList.appendChild(li);
  }
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function loadApps() {
  try {
    const resp = await fetch('/api/apps');
    apps = await resp.json();
  } catch {}
}

async function loadHistory() {
  try {
    const resp = await fetch('/api/history');
    history = await resp.json();
  } catch { history = []; }
  renderHistory();
}

async function loadStatus() {
  try {
    const resp = await fetch('/api/status');
    const data = await resp.json();
    statusDot.className = 'status-dot ' + (data.connected ? 'online' : 'offline');
    statusText.textContent = data.connected ? 'Connected' : 'Disconnected';
    currentUrl.textContent = data.url || '';
    if (data.hostname) $('hostnameText').textContent = data.hostname;
    renderApps(data.url);
  } catch {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Error';
  }
}

// Init
loadApps().then(() => loadStatus());
loadHistory();
setInterval(loadStatus, 10000);

document.querySelector('header h1').onclick = async () => {
  if (!confirm('Restart the kiosk service?')) return;
  showToast('Restarting kiosk...');
  try {
    const resp = await fetch('/api/restart-kiosk', { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      showToast('Kiosk restarted');
      setTimeout(loadStatus, 5000);
    } else {
      showToast(data.error || 'Restart failed', 'error');
    }
  } catch (e) {
    showToast('Request failed', 'error');
  }
};

urlInput.addEventListener('input', renderHistory);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(urlInput.value.trim()); });
goBtn.onclick = () => navigate(urlInput.value.trim());
</script>
</body>
</html>`;

// ── Server ──────────────────────────────────────────────────────────────────

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Dashboard page
    if (path === "/" || path === "/index.html") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // API: list apps
    if (path === "/api/apps" && req.method === "GET") {
      return Response.json(getApps());
    }

    // API: kiosk status
    if (path === "/api/status" && req.method === "GET") {
      const status = await getKioskStatus();
      return Response.json({ ...status, hostname: HOSTNAME, ip: getLanIp() });
    }

    // API: navigate kiosk
    if (path === "/api/navigate" && req.method === "POST") {
      try {
        const body = await req.json() as { url: string; recordHistory?: boolean };
        if (!body.url) return Response.json({ ok: false, error: "Missing url" }, { status: 400 });
        const result = await navigateKiosk(body.url, body.recordHistory !== false);
        return Response.json(result);
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: get history
    if (path === "/api/history" && req.method === "GET") {
      return Response.json(loadHistory());
    }

    // API: restart kiosk service
    if (path === "/api/restart-kiosk" && req.method === "POST") {
      try {
        execSync("/run/wrappers/bin/sudo systemctl restart kiosk.service", { timeout: 10000 });
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: delete history entry
    if (path.startsWith("/api/history/") && req.method === "DELETE") {
      const idx = parseInt(path.split("/").pop() || "");
      if (isNaN(idx)) return Response.json({ ok: false, error: "Invalid index" }, { status: 400 });
      removeHistory(idx);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Kiosk Dashboard running on http://localhost:${PORT}`);
