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

// ── System Diagnostics ──────────────────────────────────────────────────────

function getSystemDiagnostics() {
  const read = (p: string) => { try { return readFileSync(p, "utf-8").trim(); } catch { return null; } };
  const run = (cmd: string) => { try { return execSync(cmd, { timeout: 3000 }).toString().trim(); } catch { return ""; } };

  // CPU temp
  const cpuTemp = parseFloat(read("/sys/class/thermal/thermal_zone0/temp") || "0") / 1000;

  // GPU temp (vcgencmd on Pi 5)
  let gpuTemp = 0;
  const gpuRaw = run("/run/current-system/sw/bin/vcgencmd measure_temp 2>/dev/null");
  const gpuMatch = gpuRaw.match(/temp=([\d.]+)/);
  if (gpuMatch) gpuTemp = parseFloat(gpuMatch[1]);

  // CPU usage (1s sample)
  let cpuUsage = 0;
  const statLines = run("head -1 /proc/stat");
  if (statLines) {
    const parts = statLines.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    // Use /proc/loadavg for instant reading instead
    const loadAvg = read("/proc/loadavg");
    if (loadAvg) {
      const cores = parseInt(run("nproc") || "4");
      cpuUsage = Math.min(100, Math.round((parseFloat(loadAvg.split(" ")[0]) / cores) * 100));
    }
  }

  // RAM
  const memInfo = read("/proc/meminfo") || "";
  const memTotal = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || "0") / 1024;
  const memAvail = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || "0") / 1024;
  const memUsed = memTotal - memAvail;

  // Uptime
  const uptimeSec = parseFloat(read("/proc/uptime")?.split(" ")[0] || "0");
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const uptime = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  // Disk usage
  const dfLine = run("df -h / | tail -1");
  const dfParts = dfLine.split(/\s+/);
  const diskUsed = dfParts[2] || "?";
  const diskTotal = dfParts[1] || "?";
  const diskPct = parseInt(dfParts[4] || "0");

  // Throttle status
  const throttleRaw = run("/run/current-system/sw/bin/vcgencmd get_throttled 2>/dev/null");
  const throttleHex = parseInt(throttleRaw.split("=")[1] || "0", 16);
  const throttleFlags: string[] = [];
  if (throttleHex & 0x1) throttleFlags.push("Under-voltage");
  if (throttleHex & 0x2) throttleFlags.push("Freq capped");
  if (throttleHex & 0x4) throttleFlags.push("Throttled");
  if (throttleHex & 0x8) throttleFlags.push("Soft temp limit");
  // Historical flags (bits 16-19)
  const histFlags: string[] = [];
  if (throttleHex & 0x10000) histFlags.push("Under-voltage occurred");
  if (throttleHex & 0x20000) histFlags.push("Freq cap occurred");
  if (throttleHex & 0x40000) histFlags.push("Throttled occurred");
  if (throttleHex & 0x80000) histFlags.push("Soft temp limit occurred");

  // HDMI
  const hdmiRaw = run("cat /sys/class/drm/card?-HDMI-A-1/status 2>/dev/null");
  const hdmiConnected = hdmiRaw === "connected";
  let hdmiRes = "";
  if (hdmiConnected) {
    const modeRaw = run("cat /sys/class/drm/card?-HDMI-A-1/modes 2>/dev/null");
    hdmiRes = modeRaw.split("\n")[0] || "";
  }

  // Audio (PipeWire)
  const audioSink = run("pactl info 2>/dev/null | grep 'Default Sink'");
  const audioName = audioSink.split(":").slice(1).join(":").trim() || null;

  // Docker containers
  let containers: { name: string; status: string }[] = [];
  const dockerRaw = run("/run/current-system/sw/bin/docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null");
  if (dockerRaw) {
    containers = dockerRaw.split("\n").filter(Boolean).map(l => {
      const [name, ...rest] = l.split("\t");
      return { name, status: rest.join("\t") };
    });
  }

  // Services health
  const serviceNames = ["kiosk", "retrobox", "bluetooth-manager", "wifi-manager", "remote-pad", "kiosk-dashboard"];
  const services = serviceNames.map(name => ({
    name,
    active: run(`systemctl is-active ${name}.service 2>/dev/null`) === "active",
  }));

  // CPU frequency (MHz)
  const cpuFreqCur = Math.round(parseInt(read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq") || "0") / 1000);
  const cpuFreqMax = Math.round(parseInt(read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") || "0") / 1000);

  // Core voltage
  const voltRaw = run("/run/current-system/sw/bin/vcgencmd measure_volts core 2>/dev/null");
  const voltage = voltRaw.match(/volt=([\d.]+)V/)?.[1] || null;

  // Fan RPM
  let fanRpm = 0;
  const fanRaw = read("/sys/class/hwmon/hwmon2/fan1_input");
  if (fanRaw) fanRpm = parseInt(fanRaw) || 0;

  // Load average
  const loadRaw = read("/proc/loadavg") || "";
  const loadParts = loadRaw.split(" ");
  const loadAvg = { m1: loadParts[0] || "0", m5: loadParts[1] || "0", m15: loadParts[2] || "0" };

  // Process count
  const procCount = parseInt(loadParts[3]?.split("/")[1] || "0");

  // Swap
  const swapTotal = parseInt(memInfo.match(/SwapTotal:\s+(\d+)/)?.[1] || "0") / 1024;
  const swapFree = parseInt(memInfo.match(/SwapFree:\s+(\d+)/)?.[1] || "0") / 1024;
  const swapUsed = swapTotal - swapFree;

  // IP addresses
  const ipRaw = run("/run/current-system/sw/bin/ip -4 -o addr show 2>/dev/null");
  const ips: { iface: string; addr: string }[] = [];
  for (const line of ipRaw.split("\n").filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    const iface = parts[1];
    const addr = parts[3]?.split("/")[0];
    if (iface && addr && iface !== "lo") ips.push({ iface, addr });
  }

  // Kernel + NixOS
  const kernel = run("uname -r");
  const nixosGen = run("readlink /nix/var/nix/profiles/system 2>/dev/null").replace("system-", "").replace("-link", "");
  const nixosBuilt = run("stat -c '%Y' /nix/var/nix/profiles/system 2>/dev/null");
  let nixosDate = "";
  if (nixosBuilt) {
    const d = new Date(parseInt(nixosBuilt) * 1000);
    nixosDate = d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  return {
    cpu: { temp: cpuTemp, usage: cpuUsage, freqMhz: cpuFreqCur, maxFreqMhz: cpuFreqMax },
    gpu: { temp: gpuTemp },
    voltage,
    fan: { rpm: fanRpm },
    memory: { usedMb: Math.round(memUsed), totalMb: Math.round(memTotal) },
    swap: { usedMb: Math.round(swapUsed), totalMb: Math.round(swapTotal) },
    load: loadAvg,
    processes: procCount,
    uptime,
    disk: { used: diskUsed, total: diskTotal, percent: diskPct },
    throttle: { current: throttleFlags, history: histFlags, raw: `0x${throttleHex.toString(16)}` },
    hdmi: { connected: hdmiConnected, resolution: hdmiRes },
    audio: audioName,
    network: ips,
    kernel,
    nixos: { generation: nixosGen, date: nixosDate },
    containers,
    services,
  };
}

const PORT = 80;
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
  diagnosticsUrl?: string;
}

function getApps(): App[] {
  const ip = getLanIp();
  return [
    { id: "retrobox", name: "Retrobox", icon: "🕹️", url: `http://${ip}:3333`, description: "Retro gaming emulator" },
    { id: "wifi", name: "WiFi Manager", icon: "📶", url: `http://${ip}:3457`, description: "Network settings", diagnosticsUrl: `http://${ip}:3457/api/diagnostics` },
    { id: "bluetooth", name: "Bluetooth", icon: "🔵", url: `http://${ip}:3456`, description: "Controller pairing", diagnosticsUrl: `http://${ip}:3456/api/diagnostics` },
    { id: "remotepad", name: "RemotePad", icon: "🎮", url: `http://${ip}:3458`, description: "PS4 controller bridge", diagnosticsUrl: `http://${ip}:3458/api/diagnostics` },
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

  /* Status bar */
  .status-bar { display: flex; flex-wrap: wrap; align-items: center; margin-bottom: 16px; font-size: 12px; color: #666; line-height: 1.8; }
  .status-bar .metric { white-space: nowrap; }
  .status-bar .sep { margin: 0 8px; color: #333; }
  .status-bar .val { color: #aaa; }
  .status-bar .val.warn { color: #FF9800; }
  .status-bar .val.danger { color: #f44336; }
  .status-bar .val.ok { color: #4CAF50; }

  /* Status bar clickable */
  .status-bar { cursor: pointer; border-radius: 8px; padding: 6px 10px; transition: background 0.15s; }
  .status-bar:hover { background: #1a1a1a; }

  /* System modal */
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 200; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #181818; border: 1px solid #333; border-radius: 12px; width: 90%; max-width: 500px; max-height: 80vh; overflow-y: auto; padding: 20px; position: relative; }
  .modal-close { position: absolute; top: 10px; right: 14px; background: none; border: none; color: #666; font-size: 22px; cursor: pointer; padding: 4px 8px; border-radius: 4px; transition: all 0.15s; line-height: 1; }
  .modal-close:hover { color: #fff; background: #333; }
  .modal h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
  .sys-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .sys-card { background: #111; border: 1px solid #262626; border-radius: 8px; padding: 10px 12px; }
  .sys-card .sys-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .sys-card .sys-value { font-size: 13px; color: #ccc; }
  .sys-card .sys-value .ok { color: #4CAF50; }
  .sys-card .sys-value .warn { color: #FF9800; }
  .sys-card .sys-value .off { color: #666; }
  .svc-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .svc-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 3px; }
  .svc-dot.up { background: #4CAF50; }
  .svc-dot.down { background: #f44336; }
  .svc-item { font-size: 12px; color: #aaa; display: inline-flex; align-items: center; }

  /* Navigate input */
  .nav-bar { display: flex; gap: 8px; margin-bottom: 20px; }
  .nav-bar input { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px 14px; color: #e0e0e0; font-size: 15px; outline: none; transition: border-color 0.2s; }
  .nav-bar input:focus { border-color: #4a9eff; }
  .nav-bar input::placeholder { color: #555; }
  .nav-bar button { background: #4a9eff; color: #fff; border: none; border-radius: 8px; padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; white-space: nowrap; }
  .nav-bar button:hover { background: #3a8eef; }
  .nav-bar button:active { background: #2a7edf; }

  /* App list */
  .section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 10px; font-weight: 600; }
  .app-grid { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
  .app-card { display: flex; align-items: center; gap: 12px; background: #1a1a1a; border: 1px solid #282828; border-radius: 10px; padding: 12px 14px; cursor: pointer; transition: all 0.2s; }
  .app-card:hover { border-color: #444; background: #222; }
  .app-card:active { background: #252525; }
  .app-card.active { border-color: #4a9eff; background: #1a2a3a; }
  .app-card .icon { font-size: 28px; flex-shrink: 0; width: 36px; text-align: center; }
  .app-card .app-info { flex: 1; min-width: 0; }
  .app-card .name { font-size: 14px; font-weight: 600; }
  .app-card .desc { font-size: 11px; color: #666; }
  .app-card .diag { flex-shrink: 0; text-align: right; font-size: 11px; color: #888; max-width: 200px; }
  .app-card .diag .diag-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .app-card .diag .diag-ok { color: #4CAF50; }
  .app-card .diag .diag-off { color: #666; }
  .app-card .diag .diag-warn { color: #FF9800; }
  .app-card .open-link { flex-shrink: 0; color: #555; font-size: 16px; padding: 6px 8px; border-radius: 6px; text-decoration: none; transition: all 0.15s; line-height: 1; }
  .app-card .open-link:hover { color: #4a9eff; background: rgba(74,158,255,0.1); }

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

  <div class="status-bar" id="statusBar"></div>

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
<div class="modal-overlay" id="sysModal">
  <div class="modal">
    <button class="modal-close" id="sysClose">✕</button>
    <h2>System Info</h2>
    <div id="sysDetail"></div>
  </div>
</div>

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
// ── System Diagnostics UI ──
function valClass(val, warnAt, dangerAt) {
  if (val >= dangerAt) return 'val danger';
  if (val >= warnAt) return 'val warn';
  return 'val';
}

function renderStatusBar(sys) {
  if (!sys) { $('statusBar').innerHTML = ''; return; }
  const sep = '<span class="sep">|</span>';
  const m = [];
  m.push('<span class="metric">🌡 <span class="' + valClass(sys.cpu.temp, 65, 75) + '">' + sys.cpu.temp.toFixed(0) + '°C</span></span>');
  m.push('<span class="metric">CPU <span class="' + valClass(sys.cpu.usage, 70, 90) + '">' + sys.cpu.usage + '%</span></span>');
  const memPct = Math.round(sys.memory.usedMb / sys.memory.totalMb * 100);
  m.push('<span class="metric">RAM <span class="' + valClass(memPct, 75, 90) + '">' + (sys.memory.usedMb / 1024).toFixed(1) + '/' + (sys.memory.totalMb / 1024).toFixed(1) + 'G</span></span>');
  m.push('<span class="metric">Up <span class="val">' + sys.uptime + '</span></span>');
  m.push('<span class="metric">Disk <span class="' + valClass(sys.disk.percent, 80, 95) + '">' + sys.disk.percent + '%</span></span>');
  const thr = sys.throttle.current.length ? sys.throttle.current.join(', ') : 'OK';
  const thrCls = sys.throttle.current.length ? 'val danger' : 'val ok';
  m.push('<span class="metric">⚡ <span class="' + thrCls + '">' + thr + '</span></span>');
  $('statusBar').innerHTML = m.join(sep);
}

function sysCard(label, value) { return '<div class="sys-card"><div class="sys-label">' + label + '</div><div class="sys-value">' + value + '</div></div>'; }
function sysWide(label, value) { return '<div class="sys-card" style="grid-column:1/-1"><div class="sys-label">' + label + '</div><div class="sys-value">' + value + '</div></div>'; }

function renderSysDetail(sys) {
  if (!sys) return;
  let html = '<div class="sys-grid">';

  // CPU
  const freqStr = sys.cpu.freqMhz + ' / ' + sys.cpu.maxFreqMhz + ' MHz';
  const freqCls = sys.cpu.freqMhz < sys.cpu.maxFreqMhz ? 'warn' : 'ok';
  html += sysCard('CPU Freq', '<span class="' + freqCls + '">' + freqStr + '</span>');
  html += sysCard('CPU Temp', '<span class="' + (sys.cpu.temp >= 75 ? 'warn' : 'ok') + '">' + sys.cpu.temp.toFixed(1) + '°C</span>');

  // GPU + Voltage
  html += sysCard('GPU Temp', sys.gpu.temp > 0 ? '<span class="' + (sys.gpu.temp >= 75 ? 'warn' : 'ok') + '">' + sys.gpu.temp.toFixed(1) + '°C</span>' : '<span class="off">N/A</span>');
  html += sysCard('Core Voltage', sys.voltage ? sys.voltage + 'V' : '<span class="off">N/A</span>');

  // Fan + Load
  html += sysCard('Fan', sys.fan.rpm > 0 ? sys.fan.rpm + ' RPM' : '<span class="off">Off</span>');
  html += sysCard('Load Avg', sys.load.m1 + ' / ' + sys.load.m5 + ' / ' + sys.load.m15);

  // Memory + Swap
  html += sysCard('RAM', (sys.memory.usedMb / 1024).toFixed(1) + ' / ' + (sys.memory.totalMb / 1024).toFixed(1) + ' GB');
  html += sysCard('Swap', sys.swap.totalMb > 0 ? (sys.swap.usedMb / 1024).toFixed(1) + ' / ' + (sys.swap.totalMb / 1024).toFixed(1) + ' GB' : '<span class="off">None</span>');

  // Storage + Processes
  html += sysCard('Storage', sys.disk.used + ' / ' + sys.disk.total + ' (' + sys.disk.percent + '%)');
  html += sysCard('Processes', sys.processes);

  // HDMI + Audio
  html += sysCard('HDMI', sys.hdmi.connected ? '<span class="ok">' + (sys.hdmi.resolution || 'Connected') + '</span>' : '<span class="off">Disconnected</span>');
  html += sysCard('Audio', sys.audio ? '<span class="ok">' + escHtml(sys.audio.replace(/.*\\./, '').replace(/_/g, ' ').slice(0, 30)) + '</span>' : '<span class="off">N/A</span>');

  // Network IPs
  if (sys.network && sys.network.length) {
    html += sysWide('Network', sys.network.map(n => '<span class="ok">' + n.iface + '</span> ' + n.addr).join(' &nbsp;·&nbsp; '));
  }

  // Throttle
  const thrCur = sys.throttle.current.length ? '<span class="warn">' + sys.throttle.current.join(', ') + '</span>' : '<span class="ok">None</span>';
  const thrHist = sys.throttle.history.length ? '<span class="warn">' + sys.throttle.history.join(', ') + '</span>' : '<span class="ok">Clean</span>';
  html += sysWide('Throttle', thrCur + ' &nbsp;<span class="off">History: </span>' + thrHist + ' <span class="off">(' + sys.throttle.raw + ')</span>');

  // System info
  html += sysCard('Kernel', sys.kernel);
  html += sysCard('NixOS', 'Gen ' + sys.nixos.generation + (sys.nixos.date ? ' · ' + sys.nixos.date : ''));

  // Docker
  if (sys.containers.length) {
    html += sysWide('Docker', sys.containers.map(c => escHtml(c.name) + ' <span class="ok">' + escHtml(c.status) + '</span>').join('<br>'));
  }

  // Services
  html += sysWide('Services', '<div class="svc-list">' + sys.services.map(s => '<span class="svc-item"><span class="svc-dot ' + (s.active ? 'up' : 'down') + '"></span>' + s.name + '</span>').join('') + '</div>');

  html += '</div>';
  $('sysDetail').innerHTML = html;
}

async function loadSystem() {
  try {
    const resp = await fetch('/api/system', { signal: AbortSignal.timeout(5000) });
    const sys = await resp.json();
    renderStatusBar(sys);
    renderSysDetail(sys);
  } catch {}
}

$('statusBar').onclick = () => { $('sysModal').classList.add('open'); };
$('sysClose').onclick = () => { $('sysModal').classList.remove('open'); };
$('sysModal').onclick = (e) => { if (e.target === $('sysModal')) $('sysModal').classList.remove('open'); };

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

let diagCache = {};

function formatDiag(app, diag) {
  if (!diag) return '<div class="diag"><div class="diag-line diag-off">…</div></div>';
  if (diag.error) return '<div class="diag"><div class="diag-line diag-warn">⚠ error</div></div>';

  if (app.id === 'bluetooth') {
    const power = diag.powered ? '<span class="diag-ok">On</span>' : '<span class="diag-off">Off</span>';
    const devs = (diag.connectedDevices || []);
    const devStr = devs.length ? devs.map(d => d.name).join(', ') : '<span class="diag-off">No devices</span>';
    return '<div class="diag"><div class="diag-line">' + power + '</div><div class="diag-line">' + devStr + '</div></div>';
  }
  if (app.id === 'wifi') {
    const radio = diag.radioEnabled ? '<span class="diag-ok">On</span>' : '<span class="diag-off">Off</span>';
    const conn = diag.connection === 'No connection'
      ? '<span class="diag-warn">No connection</span>'
      : '<span class="diag-ok">' + escHtml(diag.connection) + (diag.signal ? ' (' + diag.signal + '%)' : '') + '</span>';
    return '<div class="diag"><div class="diag-line">' + radio + '</div><div class="diag-line">' + conn + '</div></div>';
  }
  if (app.id === 'remotepad') {
    const ps4 = diag.ps4Connected ? '<span class="diag-ok">PS4 connected</span>' : '<span class="diag-off">PS4 disconnected</span>';
    const ctrls = (diag.controllers || []);
    const ctrlStr = ctrls.length ? ctrls.join(', ') : '<span class="diag-off">No controllers</span>';
    return '<div class="diag"><div class="diag-line">' + ps4 + '</div><div class="diag-line">' + ctrlStr + '</div></div>';
  }
  return '';
}

function renderApps(kioskUrl) {
  appGrid.innerHTML = '';
  for (const app of apps) {
    const card = document.createElement('div');
    card.className = 'app-card' + (kioskUrl && kioskUrl.startsWith(app.url) ? ' active' : '');
    const diagHtml = formatDiag(app, diagCache[app.id]);
    card.innerHTML = '<div class="icon">' + app.icon + '</div><div class="app-info"><div class="name">' + app.name + '</div><div class="desc">' + app.description + '</div></div>' + diagHtml + '<a class="open-link" href="' + app.url + '" target="_blank" title="Open in browser">↗</a>';
    card.onclick = (e) => { if (!e.target.closest('.open-link')) navigate(app.url, false); };
    appGrid.appendChild(card);
  }
}

async function loadDiagnostics() {
  for (const app of apps) {
    if (!app.diagnosticsUrl) continue;
    try {
      const resp = await fetch(app.diagnosticsUrl, { signal: AbortSignal.timeout(3000) });
      diagCache[app.id] = await resp.json();
    } catch { diagCache[app.id] = null; }
  }
  renderApps(currentUrl.textContent || '');
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
loadApps().then(() => { loadStatus(); loadDiagnostics(); });
loadHistory();
loadSystem();
setInterval(loadStatus, 10000);
setInterval(loadDiagnostics, 10000);
setInterval(loadSystem, 10000);

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

    // API: system diagnostics
    if (path === "/api/system" && req.method === "GET") {
      return Response.json(getSystemDiagnostics());
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
