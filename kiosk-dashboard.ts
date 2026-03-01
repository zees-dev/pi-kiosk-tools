/**
 * Kiosk Dashboard - Single-file Bun fullstack server
 *
 * Remote control for the HDMI kiosk display. Navigate the kiosk Chrome
 * to any app or URL via Chrome DevTools Protocol (CDP).
 *
 * Usage: bun run kiosk-dashboard.ts
 * Then open http://localhost:3459
 */

import { serve, spawn } from "bun";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";

// ── uinput Virtual Mouse (via C helper) ─────────────────────────────────────

const EVENT_SIZE = 24; // sizeof(struct input_event) on aarch64
const EV_SYN = 0x00, EV_KEY = 0x01, EV_REL = 0x02;
const SYN_REPORT = 0x00;
const REL_X = 0x00, REL_Y = 0x01, REL_WHEEL = 0x08;
const BTN_LEFT = 0x110, BTN_RIGHT = 0x111, BTN_MIDDLE = 0x112;

// Pre-allocated event buffer: 3 events max (REL_X + REL_Y + SYN) = 72 bytes
const eventBuf = new Uint8Array(EVENT_SIZE * 3);
const eventView = new DataView(eventBuf.buffer);

let mouseProc: ReturnType<typeof spawn> | null = null;

function writeEvent(offset: number, type: number, code: number, value: number) {
  eventView.setUint16(16 + offset, type, true);
  eventView.setUint16(18 + offset, code, true);
  eventView.setInt32(20 + offset, value, true);
}

function sendEvents(count: number) {
  if (!mouseProc) return;
  mouseProc.stdin.write(eventBuf.slice(0, count * EVENT_SIZE));
}

function mouseMove(dx: number, dy: number) {
  eventBuf.fill(0);
  writeEvent(0, EV_REL, REL_X, dx);
  writeEvent(EVENT_SIZE, EV_REL, REL_Y, dy);
  writeEvent(EVENT_SIZE * 2, EV_SYN, SYN_REPORT, 0);
  sendEvents(3);
}

function mouseClick(button: number, pressed: number) {
  const btn = button === 1 ? BTN_RIGHT : button === 2 ? BTN_MIDDLE : BTN_LEFT;
  eventBuf.fill(0);
  writeEvent(0, EV_KEY, btn, pressed);
  writeEvent(EVENT_SIZE, EV_SYN, SYN_REPORT, 0);
  sendEvents(2);
}

function mouseScroll(dy: number) {
  eventBuf.fill(0);
  writeEvent(0, EV_REL, REL_WHEEL, dy);
  writeEvent(EVENT_SIZE, EV_SYN, SYN_REPORT, 0);
  sendEvents(2);
}

function keyPress(keycode: number, pressed: number) {
  eventBuf.fill(0);
  writeEvent(0, EV_KEY, keycode, pressed);
  writeEvent(EVENT_SIZE, EV_SYN, SYN_REPORT, 0);
  sendEvents(2);
}

// JS key → Linux evdev keycode mapping
const KEY_MAP: Record<string, number> = {
  Escape:27,Backspace:14,Tab:15,Enter:28,ShiftLeft:42,ShiftRight:54,ControlLeft:29,ControlRight:97,
  AltLeft:56,AltRight:100,MetaLeft:125,MetaRight:126,Space:57,CapsLock:58,Delete:111,Insert:110,
  Home:102,End:107,PageUp:104,PageDown:109,ArrowUp:103,ArrowDown:108,ArrowLeft:105,ArrowRight:106,
  F1:59,F2:60,F3:61,F4:62,F5:63,F6:64,F7:65,F8:66,F9:67,F10:68,F11:87,F12:88,
  Digit1:2,Digit2:3,Digit3:4,Digit4:5,Digit5:6,Digit6:7,Digit7:8,Digit8:9,Digit9:10,Digit0:11,
  Minus:12,Equal:13,BracketLeft:26,BracketRight:27,Backslash:43,Semicolon:39,Quote:40,Backquote:41,
  Comma:51,Period:52,Slash:53,
  KeyA:30,KeyB:48,KeyC:46,KeyD:32,KeyE:18,KeyF:33,KeyG:34,KeyH:35,KeyI:23,KeyJ:36,KeyK:37,KeyL:38,
  KeyM:50,KeyN:49,KeyO:24,KeyP:25,KeyQ:16,KeyR:19,KeyS:31,KeyT:20,KeyU:22,KeyV:47,KeyW:17,KeyX:45,
  KeyY:21,KeyZ:44,
};

function createVirtualMouse(): boolean {
  try {
    const helperPath = import.meta.dir + "/uinput-mouse";
    mouseProc = spawn([helperPath], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
    console.log("🖱️  Virtual mouse created (pid " + mouseProc.pid + ")");
    return true;
  } catch (e: any) {
    console.error("Failed to create virtual mouse:", e.message);
    mouseProc = null;
    return false;
  }
}

// Create virtual mouse on startup
createVirtualMouse();

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
const FAVOURITES_FILE = "./kiosk-favourites.json";

interface Favourite {
  url: string;
  title: string;
  addedAt: number;
}

function loadFavourites(): Favourite[] {
  try {
    if (existsSync(FAVOURITES_FILE)) return JSON.parse(readFileSync(FAVOURITES_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveFavourites(favs: Favourite[]) {
  try { writeFileSync(FAVOURITES_FILE, JSON.stringify(favs, null, 2)); } catch {}
}

function addFavourite(url: string, title?: string) {
  const favs = loadFavourites();
  if (favs.some(f => f.url === url)) return; // already exists
  favs.unshift({ url, title: title || url, addedAt: Date.now() });
  saveFavourites(favs);
}

function removeFavourite(index: number) {
  const favs = loadFavourites();
  if (index >= 0 && index < favs.length) { favs.splice(index, 1); saveFavourites(favs); }
}
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

// Persistent CDP WebSocket for keyboard input
let cdpKbdWs: WebSocket | null = null;
let cdpKbdReady = false;

async function getCdpKeyboardWs(): Promise<WebSocket | null> {
  if (cdpKbdWs && cdpKbdReady) return cdpKbdWs;
  try {
    const target = await getCdpTarget();
    if (!target) return null;
    cdpKbdWs = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      cdpKbdWs!.onopen = () => { cdpKbdReady = true; resolve(); };
      cdpKbdWs!.onerror = () => reject(new Error("CDP connect failed"));
      cdpKbdWs!.onclose = () => { cdpKbdReady = false; cdpKbdWs = null; };
      setTimeout(() => reject(new Error("CDP timeout")), 3000);
    });
    return cdpKbdWs;
  } catch {
    cdpKbdWs = null;
    cdpKbdReady = false;
    return null;
  }
}

// CDP key name → { keyCode, code, key } for special keys
const CDP_SPECIAL_KEYS: Record<string, { key: string; code: string; keyCode: number; windowsVirtualKeyCode: number }> = {
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8, windowsVirtualKeyCode: 8 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, windowsVirtualKeyCode: 13 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46, windowsVirtualKeyCode: 46 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27, windowsVirtualKeyCode: 27 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36, windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35, windowsVirtualKeyCode: 35 },
};

async function cdpInsertText(text: string) {
  const ws = await getCdpKeyboardWs();
  if (!ws) return;
  await cdpSend(ws, "Input.insertText", { text });
}

async function cdpDispatchKey(keyName: string) {
  const info = CDP_SPECIAL_KEYS[keyName];
  if (!info) return;
  const ws = await getCdpKeyboardWs();
  if (!ws) return;
  const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.keyCode };
  await cdpSend(ws, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdpSend(ws, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
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
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; min-height: 100vh; overflow-x: hidden; }

  .container { max-width: 640px; margin: 0 auto; padding: 16px; overflow-x: hidden; }

  /* Header */
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; margin-bottom: 20px; border-bottom: 1px solid #222; gap: 12px; }
  header > div:last-child { min-width: 0; flex-shrink: 1; overflow: hidden; }
  header h1 { font-size: 20px; font-weight: 600; line-height: 1.2; }
  header .hostname { font-size: 11px; color: #555; font-weight: 400; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 8px; }
  .status-dot.online { background: #4CAF50; box-shadow: 0 0 6px #4CAF5088; }
  .status-dot.offline { background: #666; }
  .current-url { font-size: 12px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; cursor: pointer; }
  .current-url:active { color: #4a9eff; }
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

  /* Remote input button */
  .remote-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; background: #1a1a1a; border: 1px solid #282828; border-radius: 8px; padding: 10px; margin-bottom: 16px; color: #888; font-size: 13px; cursor: pointer; transition: all 0.15s; }
  .remote-btn:hover { border-color: #444; color: #ccc; background: #1e1e1e; }
  .remote-btn:active { background: #222; }

  /* Remote input modal */
  .ri-overlay { display: none; position: fixed; inset: 0; background: #0a0a0a; z-index: 300; flex-direction: column; overflow: hidden; height: 100dvh; }
  .ri-overlay.open { display: flex; }
  .ri-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: #111; border-bottom: 1px solid #222; flex-shrink: 0; }
  .ri-header .ri-title { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
  .ri-close { background: none; border: none; color: #888; font-size: 20px; cursor: pointer; padding: 4px 10px; }
  .ri-close:hover { color: #fff; }
  .ri-status { width: 7px; height: 7px; border-radius: 50%; background: #666; flex-shrink: 0; }
  .ri-status.connected { background: #4CAF50; box-shadow: 0 0 6px #4CAF5088; }
  .ri-sens { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #666; }
  .ri-sens input { width: 50px; accent-color: #4a9eff; }

  /* Touchpad */
  .ri-pad { flex: 1; touch-action: none; position: relative; background: #0f0f0f; min-height: 0; }
  .ri-pad::after { content: ''; position: absolute; top: 50%; left: 50%; width: 40px; height: 40px; transform: translate(-50%, -50%); border: 1px solid #1a1a1a; border-radius: 50%; pointer-events: none; }
  .ri-scroll { position: absolute; right: 0; top: 0; bottom: 0; width: 40px; background: rgba(255,255,255,0.02); border-left: 1px solid #1a1a1a; touch-action: none; }
  .ri-scroll::before { content: '⇕'; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #333; font-size: 16px; pointer-events: none; }

  /* Bottom input bar (nav + keyboard + enter) */
  .ri-input-bar { display: flex; align-items: center; gap: 0; padding: 6px 8px; background: #111; border-top: 1px solid #222; flex-shrink: 0; }
  .ri-nav-btn { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: none; border: 1px solid #333; color: #aaa; font-size: 15px; cursor: pointer; transition: all 0.1s; flex-shrink: 0; -webkit-tap-highlight-color: transparent; }
  .ri-nav-btn:first-child { border-radius: 8px 0 0 8px; border-right: none; }
  .ri-nav-btn:nth-child(2) { border-radius: 0 8px 8px 0; }
  .ri-nav-btn:active { background: #2a2a2a; color: #fff; }
  .ri-nav-btn[disabled] { color: #333; border-color: #222; }
  .ri-text-input { flex: 1; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; padding: 8px 10px; color: #e0e0e0; font-size: 14px; outline: none; margin: 0 6px; min-width: 0; }
  .ri-text-input:focus { border-color: #4a9eff; }
  .ri-text-input::placeholder { color: #444; }
  .ri-go-btn { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: #4a9eff; border: none; border-radius: 8px; color: #fff; font-size: 15px; cursor: pointer; flex-shrink: 0; transition: background 0.1s; -webkit-tap-highlight-color: transparent; }
  .ri-go-btn:active { background: #2a7edf; }

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

  /* Collapsible sections */
  .collapsible { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 4px; }
  .collapsible .chevron { font-size: 10px; transition: transform 0.2s; }
  .collapsible:not(.open) .chevron { transform: rotate(-90deg); }
  .collapsible:not(.open) + .history-list { display: none; }

  /* Star / favourite button */
  .hist-star { background: none; border: none; color: #555; font-size: 16px; cursor: pointer; padding: 4px 6px; border-radius: 4px; transition: all 0.15s; }
  .hist-star:hover { color: #ffc107; background: rgba(255,193,7,0.1); }
  .hist-star.faved { color: #ffc107; }

  /* Favourite remove */
  .fav-remove { background: none; border: none; color: #555; font-size: 16px; cursor: pointer; padding: 4px 6px; border-radius: 4px; transition: all 0.15s; }
  .fav-remove:hover { color: #f44336; background: #2a1a1a; }

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
  <div class="remote-btn" id="remoteBtn">🖱️ Remote Input</div>

  <div class="section-title">Apps</div>
  <div class="app-grid" id="appGrid"></div>

  <div class="section-title collapsible open" id="favsToggle">⭐ Favourites <span class="chevron">▾</span></div>
  <ul class="history-list" id="favsList" style="margin-bottom:16px"></ul>

  <div class="nav-bar">
    <input type="text" id="urlInput" placeholder="Enter URL..." autocomplete="off" autocapitalize="off" spellcheck="false">
    <button id="goBtn">Go</button>
  </div>

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

<div class="ri-overlay" id="riOverlay">
  <div class="ri-header">
    <div class="ri-title"><span class="ri-status" id="riStatus"></span> Remote Input</div>
    <div class="ri-sens"><span>Sens</span><input type="range" id="riSens" min="1" max="20" value="8"></div>
    <button class="ri-close" id="riClose">✕</button>
  </div>
  <div class="ri-pad" id="riPad">
    <div class="ri-scroll" id="riScroll"></div>
  </div>
  <div class="ri-input-bar">
    <button class="ri-nav-btn" id="riBack" disabled>◀</button>
    <button class="ri-nav-btn" id="riForward" disabled>▶</button>
    <input type="text" class="ri-text-input" id="riKbdInput" placeholder="Type here..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <button class="ri-go-btn" id="riGo">↵</button>
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

let favourites = [];

async function loadFavourites() {
  try {
    const resp = await fetch('/api/favourites');
    favourites = await resp.json();
  } catch { favourites = []; }
  renderFavourites();
}

function renderFavourites() {
  const favsList = $('favsList');
  if (favourites.length === 0) {
    favsList.innerHTML = '<li class="empty">No favourites yet</li>';
    return;
  }
  favsList.innerHTML = '';
  for (let i = 0; i < favourites.length; i++) {
    const f = favourites[i];
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML =
      '<div class="hist-info"><div class="hist-title">' + escHtml(f.title) + '</div><div class="hist-url">' + escHtml(f.url) + '</div></div>' +
      '<button class="fav-remove" data-idx="' + i + '" title="Remove favourite">✕</button>';
    li.querySelector('.hist-info').onclick = () => navigate(f.url, false);
    li.querySelector('.fav-remove').onclick = async (e) => {
      e.stopPropagation();
      await fetch('/api/favourites/' + i, { method: 'DELETE' });
      await loadFavourites();
      renderHistory();
    };
    favsList.appendChild(li);
  }
}

function isFavourited(url) { return favourites.some(f => f.url === url); }

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
    const faved = isFavourited(h.url);
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML =
      '<div class="hist-info"><div class="hist-title">' + escHtml(h.title) + '</div><div class="hist-url">' + escHtml(h.url) + '</div></div>' +
      '<span class="hist-time">' + timeAgo(h.timestamp) + '</span>' +
      '<button class="hist-star' + (faved ? ' faved' : '') + '" title="' + (faved ? 'Favourited' : 'Add to favourites') + '">★</button>' +
      '<button class="hist-delete" data-idx="' + origIdx + '" title="Remove">✕</button>';
    li.querySelector('.hist-info').onclick = () => navigate(h.url);
    li.querySelector('.hist-star').onclick = async (e) => {
      e.stopPropagation();
      if (faved) return; // already favourited
      await fetch('/api/favourites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: h.url, title: h.title }) });
      await loadFavourites();
      renderHistory();
      showToast('Added to favourites');
    };
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

// Click URL to copy to clipboard (with fallback for non-HTTPS)
currentUrl.onclick = () => {
  const url = currentUrl.textContent;
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => showToast('URL copied')).catch(() => copyFallback(url));
  } else { copyFallback(url); }
};
function copyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast('URL copied'); } catch { showToast('Copy failed', 'error'); }
  document.body.removeChild(ta);
}

// ── Remote Input ──
const MOVE = 0x01, CLICK = 0x02, SCROLL = 0x03, KEY = 0x04;
const moveBuf = new ArrayBuffer(5); const moveV = new DataView(moveBuf); moveV.setUint8(0, MOVE);
const clickBuf = new ArrayBuffer(3); const clickV = new DataView(clickBuf); clickV.setUint8(0, CLICK);
const scrollBuf = new ArrayBuffer(3); const scrollV = new DataView(scrollBuf); scrollV.setUint8(0, SCROLL);
const keyBuf = new ArrayBuffer(4); const keyV = new DataView(keyBuf); keyV.setUint8(0, KEY);
const CDP_TEXT = 0x05, CDP_KEY = 0x06;

let riWs = null;
let riSens = parseInt(localStorage.getItem('ri-sens') || '8');
$('riSens').value = riSens;

const KEY_MAP = {
  Escape:27,Backspace:14,Tab:15,Enter:28,ShiftLeft:42,ShiftRight:54,ControlLeft:29,ControlRight:97,
  AltLeft:56,AltRight:100,MetaLeft:125,MetaRight:126,Space:57,CapsLock:58,Delete:111,Insert:110,
  Home:102,End:107,PageUp:104,PageDown:109,ArrowUp:103,ArrowDown:108,ArrowLeft:105,ArrowRight:106,
  Digit1:2,Digit2:3,Digit3:4,Digit4:5,Digit5:6,Digit6:7,Digit7:8,Digit8:9,Digit9:10,Digit0:11,
  Minus:12,Equal:13,BracketLeft:26,BracketRight:27,Backslash:43,Semicolon:39,Quote:40,Backquote:41,
  Comma:51,Period:52,Slash:53,
  KeyA:30,KeyB:48,KeyC:46,KeyD:32,KeyE:18,KeyF:33,KeyG:34,KeyH:35,KeyI:23,KeyJ:36,KeyK:37,KeyL:38,
  KeyM:50,KeyN:49,KeyO:24,KeyP:25,KeyQ:16,KeyR:19,KeyS:31,KeyT:20,KeyU:22,KeyV:47,KeyW:17,KeyX:45,
  KeyY:21,KeyZ:44,
};

function riAccel(d) {
  const a = Math.abs(d);
  return Math.sign(d) * Math.round(a * (0.5 + a * 0.08) * (riSens / 8));
}

function riSend(buf) { if (riWs && riWs.readyState === 1) riWs.send(buf); }
function riSendMove(dx, dy) { moveV.setInt16(1, dx, true); moveV.setInt16(3, dy, true); riSend(moveBuf); }
function riSendClick(b, p) { clickV.setUint8(1, b); clickV.setUint8(2, p); riSend(clickBuf); }
function riSendScroll(dy) { scrollV.setInt16(1, dy, true); riSend(scrollBuf); }
function riSendKey(code, pressed) { keyV.setUint16(1, code, true); keyV.setUint8(3, pressed); riSend(keyBuf); }
function riSendCdpText(text) { const enc = new TextEncoder().encode(text); const buf = new Uint8Array(1 + enc.length); buf[0] = CDP_TEXT; buf.set(enc, 1); riSend(buf.buffer); }
function riSendCdpKey(id) { const buf = new Uint8Array([CDP_KEY, id]); riSend(buf.buffer); }
// Special key name → CDP_KEY id: 1=Backspace, 2=Enter, 3=Delete, 4=Tab, 5=Escape, 6-9=Arrows, 10=Home, 11=End
const CDP_KEY_IDS = { Backspace: 1, Enter: 2, Delete: 3, Tab: 4, Escape: 5, ArrowUp: 6, ArrowDown: 7, ArrowLeft: 8, ArrowRight: 9, Home: 10, End: 11 };

function riConnect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  riWs = new WebSocket(proto + '//' + location.host + '/ws/mousepad');
  riWs.binaryType = 'arraybuffer';
  riWs.onopen = () => $('riStatus').classList.add('connected');
  riWs.onclose = () => { $('riStatus').classList.remove('connected'); setTimeout(riConnect, 1000); };
  riWs.onerror = () => riWs.close();
}

// Open/close
let riNavPoll = null;
$('remoteBtn').onclick = () => {
  $('riOverlay').classList.add('open');
  if (!riWs) riConnect();
  updateNavState();
  riNavPoll = setInterval(updateNavState, 2000);
};
$('riClose').onclick = () => {
  $('riOverlay').classList.remove('open');
  if (riNavPoll) { clearInterval(riNavPoll); riNavPoll = null; }
};

// Navigation back/forward
async function updateNavState() {
  try {
    const resp = await fetch('/api/nav-state');
    const s = await resp.json();
    $('riBack').disabled = !s.canGoBack;
    $('riForward').disabled = !s.canGoForward;
  } catch { /* ignore */ }
}
$('riBack').onclick = async () => {
  try { await fetch('/api/nav-back', { method: 'POST' }); } catch {}
  setTimeout(updateNavState, 300);
};
$('riForward').onclick = async () => {
  try { await fetch('/api/nav-forward', { method: 'POST' }); } catch {}
  setTimeout(updateNavState, 300);
};

// Go/Enter button
$('riGo').onclick = () => kbdSendEnter();

// Sensitivity
$('riSens').oninput = () => { riSens = parseInt($('riSens').value); localStorage.setItem('ri-sens', riSens); };

// ── Mouse pad ──
const riPad = $('riPad'), riScroll = $('riScroll');
let pLastX = 0, pLastY = 0, pTouchId = -1, pTapT = 0, pTapX = 0, pTapY = 0;
let pTwoFingerTap = false, pTouchCount = 0;

riPad.addEventListener('touchstart', (e) => {
  // Track total finger count on pad (excluding scroll strip)
  pTouchCount = 0;
  for (let i = 0; i < e.touches.length; i++) {
    const t = e.touches[i];
    if (t.target !== riScroll && t.target.parentElement !== riScroll) pTouchCount++;
  }
  // Two-finger tap detection
  if (pTouchCount === 2) { pTwoFingerTap = true; }
  for (const t of e.changedTouches) {
    if (t.target === riScroll || t.target.parentElement === riScroll) continue;
    if (pTouchId < 0) { pTouchId = t.identifier; pLastX = t.clientX; pLastY = t.clientY; pTapT = performance.now(); pTapX = t.clientX; pTapY = t.clientY; pTwoFingerTap = false; }
  }
}, { passive: true });

riPad.addEventListener('touchmove', (e) => {
  pTwoFingerTap = false; // moved = not a tap
  for (const t of e.changedTouches) {
    if (t.identifier === pTouchId) {
      const dx = riAccel(t.clientX - pLastX), dy = riAccel(t.clientY - pLastY);
      pLastX = t.clientX; pLastY = t.clientY;
      if (dx !== 0 || dy !== 0) riSendMove(dx, dy);
    }
  }
}, { passive: true });

riPad.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === pTouchId) {
      pTouchId = -1;
      const elapsed = performance.now() - pTapT;
      const dist = Math.abs(t.clientX - pTapX) + Math.abs(t.clientY - pTapY);
      if (elapsed < 250 && dist < 15) {
        if (pTwoFingerTap) {
          // Two-finger tap → right click
          riSendClick(1, 1); riSendClick(1, 0);
        } else {
          // Single tap → left click
          riSendClick(0, 1); riSendClick(0, 0);
        }
      }
      pTwoFingerTap = false;
    }
  }
  // Reset touch count
  pTouchCount = 0;
  for (let i = 0; i < e.touches.length; i++) {
    const t = e.touches[i];
    if (t.target !== riScroll && t.target.parentElement !== riScroll) pTouchCount++;
  }
}, { passive: true });

// Scroll
let sLastY = 0, sTouchId = -1, sAccum = 0;
riScroll.addEventListener('touchstart', (e) => { e.stopPropagation(); const t = e.changedTouches[0]; sTouchId = t.identifier; sLastY = t.clientY; sAccum = 0; }, { passive: true });
riScroll.addEventListener('touchmove', (e) => { e.stopPropagation(); for (const t of e.changedTouches) { if (t.identifier === sTouchId) { sAccum += (sLastY - t.clientY) * (riSens / 8); sLastY = t.clientY; while (sAccum >= 10) { riSendScroll(1); sAccum -= 10; } while (sAccum <= -10) { riSendScroll(-1); sAccum += 10; } } } }, { passive: true });
riScroll.addEventListener('touchend', (e) => { e.stopPropagation(); sTouchId = -1; }, { passive: true });

// (click buttons removed — tap = left click, two-finger tap = right click)

// ── Keyboard (value-diff approach — handles all mobile keyboard quirks) ──
const kbdInput = $('riKbdInput');
let kbdPrev = '';
let kbdClearing = false; // flag to skip diff when we clear the field

// Single source of truth: diff old vs new value on every input event
kbdInput.addEventListener('input', () => {
  if (kbdClearing) return;
  const cur = kbdInput.value;
  if (cur === kbdPrev) return;

  // Find longest common prefix
  let prefixLen = 0;
  const minLen = Math.min(kbdPrev.length, cur.length);
  while (prefixLen < minLen && kbdPrev[prefixLen] === cur[prefixLen]) prefixLen++;

  // Send backspaces for everything after the common prefix in the old value
  const backspaces = kbdPrev.length - prefixLen;
  for (let i = 0; i < backspaces; i++) riSendCdpKey(CDP_KEY_IDS.Backspace);

  // Send new characters after the common prefix
  const added = cur.slice(prefixLen);
  if (added) riSendCdpText(added);

  kbdPrev = cur;
}, { passive: true });

// Enter: send enter key + clear field
function kbdSendEnter() {
  riSendCdpKey(CDP_KEY_IDS.Enter);
  kbdClearing = true;
  kbdInput.value = '';
  kbdPrev = '';
  kbdClearing = false;
}

kbdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); kbdSendEnter(); return; }
  const id = CDP_KEY_IDS[e.key];
  if (id && (e.key === 'Tab' || e.key === 'Escape' || e.key.startsWith('Arrow'))) {
    riSendCdpKey(id);
    e.preventDefault();
  }
}, { passive: false });

// Collapsible favourites
$('favsToggle').onclick = () => { $('favsToggle').classList.toggle('open'); };

// Init
loadApps().then(() => { loadStatus(); loadDiagnostics(); });
loadHistory();
loadFavourites();
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

// (mousepad UI is now a modal in the main dashboard)
const _MOUSEPAD_LEGACY = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Mousepad</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🖱️</text></svg>">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-user-select: none; user-select: none; }
  html, body { height: 100%; overflow: hidden; background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, system-ui, sans-serif; }

  .container { display: flex; flex-direction: column; height: 100%; }

  /* Header */
  .header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #111; border-bottom: 1px solid #222; flex-shrink: 0; }
  .header a { color: #888; text-decoration: none; font-size: 14px; }
  .header a:hover { color: #fff; }
  .status-indicator { width: 8px; height: 8px; border-radius: 50%; background: #666; }
  .status-indicator.connected { background: #4CAF50; box-shadow: 0 0 6px #4CAF5088; }
  .header .title { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .sensitivity { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #666; }
  .sensitivity input { width: 60px; accent-color: #4a9eff; }

  /* Touchpad */
  .pad { flex: 1; touch-action: none; position: relative; background: #0f0f0f; cursor: crosshair; }
  .pad::after { content: ''; position: absolute; top: 50%; left: 50%; width: 40px; height: 40px; transform: translate(-50%, -50%); border: 1px solid #1a1a1a; border-radius: 50%; pointer-events: none; }
  .debug { position: absolute; bottom: 8px; left: 8px; font-size: 10px; color: #333; pointer-events: none; font-family: monospace; }

  /* Scroll strip */
  .scroll-strip { position: absolute; right: 0; top: 0; bottom: 0; width: 40px; background: rgba(255,255,255,0.02); border-left: 1px solid #1a1a1a; touch-action: none; }
  .scroll-strip::before { content: '⇕'; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #333; font-size: 16px; pointer-events: none; }

  /* Buttons */
  .buttons { display: flex; flex-shrink: 0; border-top: 1px solid #222; }
  .btn { flex: 1; padding: 18px; text-align: center; font-size: 13px; font-weight: 600; color: #888; background: #111; border: none; cursor: pointer; transition: background 0.05s; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
  .btn:active, .btn.pressed { background: #2a2a2a; color: #fff; }
  .btn-left { border-right: 1px solid #222; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <a href="/">← Back</a>
    <div class="title"><span class="status-indicator" id="status"></span> Mousepad</div>
    <div class="sensitivity">
      <span>Sens</span>
      <input type="range" id="sens" min="1" max="20" value="8">
    </div>
  </div>
  <div class="pad" id="pad">
    <div class="debug" id="dbg">waiting...</div>
    <div class="scroll-strip" id="scrollStrip"></div>
  </div>
  <div class="buttons">
    <button class="btn btn-left" id="btnLeft">Left Click</button>
    <button class="btn btn-right" id="btnRight">Right Click</button>
  </div>
</div>
<script>
// Binary protocol: 0x01=move(dx:i16,dy:i16), 0x02=click(btn:u8,pressed:u8), 0x03=scroll(dy:i16)
const MOVE = 0x01, CLICK = 0x02, SCROLL = 0x03;

// Pre-allocated buffers
const moveBuf = new ArrayBuffer(5);
const moveView = new DataView(moveBuf);
moveView.setUint8(0, MOVE);

const clickBuf = new ArrayBuffer(3);
const clickView = new DataView(clickBuf);
clickView.setUint8(0, CLICK);

const scrollBuf = new ArrayBuffer(3);
const scrollView = new DataView(scrollBuf);
scrollView.setUint8(0, SCROLL);

const pad = document.getElementById('pad');
const scrollStrip = document.getElementById('scrollStrip');
const statusEl = document.getElementById('status');
const sensEl = document.getElementById('sens');

let ws = null;
let sensitivity = 8;

sensEl.addEventListener('input', () => { sensitivity = parseInt(sensEl.value); });

// Acceleration curve: small = precise, large = fast
function accel(d) {
  const a = Math.abs(d);
  return Math.sign(d) * Math.round(a * (0.5 + a * 0.08) * (sensitivity / 8));
}

const dbg = document.getElementById('dbg');
let moveCount = 0;

function sendMove(dx, dy) {
  moveCount++;
  dbg.textContent = 'moves:' + moveCount + ' dx:' + dx + ' dy:' + dy + ' ws:' + (ws ? ws.readyState : 'null');
  if (!ws || ws.readyState !== 1) return;
  moveView.setInt16(1, dx, true);
  moveView.setInt16(3, dy, true);
  ws.send(moveBuf);
}

function sendClick(button, pressed) {
  if (!ws || ws.readyState !== 1) return;
  clickView.setUint8(1, button);
  clickView.setUint8(2, pressed);
  ws.send(clickBuf);
}

function sendScroll(dy) {
  if (!ws || ws.readyState !== 1) return;
  scrollView.setInt16(1, dy, true);
  ws.send(scrollBuf);
}

// ── Pad touch handling ──
let padLastX = 0, padLastY = 0, padTouchId = -1;
let tapStart = 0, tapX = 0, tapY = 0;

pad.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    if (t.target === scrollStrip || t.target.parentElement === scrollStrip) continue;
    if (padTouchId < 0) {
      padTouchId = t.identifier;
      padLastX = t.clientX;
      padLastY = t.clientY;
      tapStart = performance.now();
      tapX = t.clientX;
      tapY = t.clientY;
    }
  }
}, { passive: true });

pad.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === padTouchId) {
      const rawDx = t.clientX - padLastX;
      const rawDy = t.clientY - padLastY;
      padLastX = t.clientX;
      padLastY = t.clientY;
      const dx = accel(rawDx);
      const dy = accel(rawDy);
      if (dx !== 0 || dy !== 0) sendMove(dx, dy);
    }
  }
}, { passive: true });

pad.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === padTouchId) {
      padTouchId = -1;
      // Tap-to-click: short tap with minimal movement
      const dt = performance.now() - tapStart;
      const dist = Math.abs(t.clientX - tapX) + Math.abs(t.clientY - tapY);
      if (dt < 200 && dist < 15) {
        sendClick(0, 1); sendClick(0, 0);
      }
    }
  }
}, { passive: true });

// ── Scroll strip ──
let scrollLastY = 0, scrollTouchId = -1, scrollAccum = 0;

scrollStrip.addEventListener('touchstart', (e) => {
  e.stopPropagation();
  const t = e.changedTouches[0];
  scrollTouchId = t.identifier;
  scrollLastY = t.clientY;
  scrollAccum = 0;
}, { passive: true });

scrollStrip.addEventListener('touchmove', (e) => {
  e.stopPropagation();
  for (const t of e.changedTouches) {
    if (t.identifier === scrollTouchId) {
      scrollAccum += (scrollLastY - t.clientY) * (sensitivity / 8);
      scrollLastY = t.clientY;
      // Send in discrete steps
      while (scrollAccum >= 10) { sendScroll(1); scrollAccum -= 10; }
      while (scrollAccum <= -10) { sendScroll(-1); scrollAccum += 10; }
    }
  }
}, { passive: true });

scrollStrip.addEventListener('touchend', (e) => {
  e.stopPropagation();
  scrollTouchId = -1;
}, { passive: true });

// ── Click buttons ──
function setupBtn(el, button) {
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    el.classList.add('pressed');
    sendClick(button, 1);
  }, { passive: false });
  el.addEventListener('touchend', (e) => {
    e.preventDefault();
    el.classList.remove('pressed');
    sendClick(button, 0);
  }, { passive: false });
  el.addEventListener('touchcancel', () => {
    el.classList.remove('pressed');
    sendClick(button, 0);
  });
}
setupBtn(document.getElementById('btnLeft'), 0);
setupBtn(document.getElementById('btnRight'), 1);

// ── WebSocket ──
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/mousepad');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { statusEl.classList.add('connected'); };
  ws.onclose = () => { statusEl.classList.remove('connected'); setTimeout(connect, 1000); };
  ws.onerror = () => { ws.close(); };
}
connect();
</script>
</body>
</html>`;

// ── Server ──────────────────────────────────────────────────────────────────

const server = serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade for mousepad
    if (path === "/ws/mousepad") {
      if (server.upgrade(req)) return undefined as any;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

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

    // API: browser navigation state (can go back/forward?)
    if (path === "/api/nav-state" && req.method === "GET") {
      try {
        const target = await getCdpTarget();
        if (!target) return Response.json({ canGoBack: false, canGoForward: false });
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject();
          setTimeout(() => reject(), 2000);
        });
        const nav = await cdpSend(ws, "Page.getNavigationHistory");
        ws.close();
        return Response.json({
          canGoBack: nav.currentIndex > 0,
          canGoForward: nav.currentIndex < nav.entries.length - 1,
        });
      } catch {
        return Response.json({ canGoBack: false, canGoForward: false });
      }
    }

    // API: browser back
    if (path === "/api/nav-back" && req.method === "POST") {
      try {
        const target = await getCdpTarget();
        if (!target) return Response.json({ ok: false });
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject();
          setTimeout(() => reject(), 2000);
        });
        const nav = await cdpSend(ws, "Page.getNavigationHistory");
        if (nav.currentIndex > 0) {
          await cdpSend(ws, "Page.navigateToHistoryEntry", { entryId: nav.entries[nav.currentIndex - 1].id });
        }
        ws.close();
        return Response.json({ ok: true });
      } catch { return Response.json({ ok: false }); }
    }

    // API: browser forward
    if (path === "/api/nav-forward" && req.method === "POST") {
      try {
        const target = await getCdpTarget();
        if (!target) return Response.json({ ok: false });
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject();
          setTimeout(() => reject(), 2000);
        });
        const nav = await cdpSend(ws, "Page.getNavigationHistory");
        if (nav.currentIndex < nav.entries.length - 1) {
          await cdpSend(ws, "Page.navigateToHistoryEntry", { entryId: nav.entries[nav.currentIndex + 1].id });
        }
        ws.close();
        return Response.json({ ok: true });
      } catch { return Response.json({ ok: false }); }
    }

    // API: favourites
    if (path === "/api/favourites" && req.method === "GET") {
      return Response.json(loadFavourites());
    }
    if (path === "/api/favourites" && req.method === "POST") {
      const body = await req.json() as { url: string; title?: string };
      if (!body.url) return Response.json({ ok: false }, { status: 400 });
      addFavourite(body.url, body.title);
      return Response.json({ ok: true });
    }
    if (path.startsWith("/api/favourites/") && req.method === "DELETE") {
      const idx = parseInt(path.split("/").pop() || "");
      if (isNaN(idx)) return Response.json({ ok: false }, { status: 400 });
      removeFavourite(idx);
      return Response.json({ ok: true });
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

  websocket: {
    message(ws, msg) {
      let buf: ArrayBuffer;
      if (msg instanceof ArrayBuffer) { buf = msg; }
      else if (msg instanceof Uint8Array || Buffer.isBuffer(msg)) { buf = (msg as Uint8Array).buffer.slice((msg as Uint8Array).byteOffset, (msg as Uint8Array).byteOffset + (msg as Uint8Array).byteLength); }
      else return;
      if (buf.byteLength < 1) return;
      const view = new DataView(buf);
      const type = view.getUint8(0);

      if (type === 0x01 && buf.byteLength >= 5) {
        const dx = view.getInt16(1, true), dy = view.getInt16(3, true);
        if (dx !== 0 || dy !== 0) mouseMove(dx, dy);
      } else if (type === 0x02 && buf.byteLength >= 3) {
        mouseClick(view.getUint8(1), view.getUint8(2));
      } else if (type === 0x03 && buf.byteLength >= 3) {
        mouseScroll(view.getInt16(1, true));
      } else if (type === 0x04 && buf.byteLength >= 4) {
        const kc = view.getUint16(1, true);
        if (kc > 0) keyPress(kc, view.getUint8(3));
      } else if (type === 0x05 && buf.byteLength > 1) {
        // CDP text insert
        const text = new TextDecoder().decode(new Uint8Array(buf, 1));
        if (text) cdpInsertText(text);
      } else if (type === 0x06 && buf.byteLength >= 2) {
        // CDP special key
        const SPECIAL_KEY_IDS = ["", "Backspace", "Enter", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];
        const keyName = SPECIAL_KEY_IDS[view.getUint8(1)];
        if (keyName) cdpDispatchKey(keyName);
      }
    },
    open(ws) { ws.binaryType = "arraybuffer"; console.log("🖱️  Mousepad client connected"); },
    close(ws) { console.log("🖱️  Mousepad client disconnected"); },
  },
});

console.log(`Kiosk Dashboard running on http://localhost:${PORT}`);
