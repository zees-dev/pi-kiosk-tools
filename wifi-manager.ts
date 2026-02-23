/**
 * WiFi Manager - Single-file Bun fullstack server
 *
 * Web-based WiFi manager using NetworkManager (nmcli).
 * Supports scanning, connecting, saving, and forgetting WiFi networks.
 *
 * Usage: bun run server.ts
 * Then open http://localhost:3457
 */

import { serve } from "bun";

const PORT = 3457;

// Run a shell command and return stdout
function run(cmd: string, timeout = 10000): string {
  const { execSync } = require("child_process");
  try {
    return execSync(cmd, { timeout, encoding: "utf-8", env: { ...process.env, PATH: "/run/current-system/sw/bin:/run/wrappers/bin:" + (process.env.PATH || "") } }).trim();
  } catch (e: any) {
    return e.stdout?.toString()?.trim() || "";
  }
}

// Parse nmcli terse output (handles escaped colons in SSIDs)
function parseTerse(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) {
      current += line[i + 1];
      i++;
    } else if (line[i] === ":") {
      fields.push(current);
      current = "";
    } else {
      current += line[i];
    }
  }
  fields.push(current);
  return fields;
}

// Determine band from WiFi channel number
function getBand(channel: number): string {
  if (channel >= 1 && channel <= 14) return "2.4";
  if (channel >= 36 && channel <= 177) return "5";
  if (channel >= 233) return "6";
  return "?";
}

// Signal strength to bars emoji
function signalBars(signal: number): string {
  if (signal >= 75) return "▂▄▆█";
  if (signal >= 50) return "▂▄▆_";
  if (signal >= 25) return "▂▄__";
  return "▂___";
}

// ==========================================
// API handlers
// ==========================================

// GET /api/status — network connection info (both ethernet and WiFi)
function getStatus() {
  try {
    const lines = run("nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status")
      .split("\n")
      .map((l) => parseTerse(l));

    // Ethernet status
    const eth = lines.find((f) => f[1] === "ethernet");
    let ethernet: any = null;
    if (eth) {
      const [ethDev, , ethState, ethConn] = eth;
      ethernet = { device: ethDev, state: ethState, connection: ethConn || null, ip: "" };
      if (ethState === "connected") {
        try {
          const ipLines = run(`nmcli -t -f IP4.ADDRESS device show ${ethDev}`).split("\n");
          const ipLine = ipLines.find((l: string) => l.includes("IP4.ADDRESS"));
          if (ipLine) ethernet.ip = ipLine.split(":").slice(1).join(":").trim();
        } catch {}
      }
    }

    // WiFi status
    const wifi = lines.find((f) => f[1] === "wifi");
    let wireless: any = null;
    if (wifi) {
      const [wifiDev, , wifiState, wifiConn] = wifi;
      wireless = { device: wifiDev, state: wifiState, connection: wifiConn || null, ip: "", signal: 0, freq: "", speed: "", channel: 0 };
      if (wifiState === "connected" && wifiConn) {
        try {
          const ipLines = run(`nmcli -t -f IP4.ADDRESS device show ${wifiDev}`).split("\n");
          const ipLine = ipLines.find((l: string) => l.includes("IP4.ADDRESS"));
          if (ipLine) wireless.ip = ipLine.split(":").slice(1).join(":").trim();
        } catch {}

        const activeLines = run("nmcli -t -f IN-USE,SSID,CHAN,RATE,SIGNAL device wifi list")
          .split("\n")
          .map((l) => parseTerse(l));
        const active = activeLines.find((f) => f[0] === "*");
        if (active) {
          wireless.channel = parseInt(active[2]) || 0;
          wireless.speed = active[3];
          wireless.signal = parseInt(active[4]) || 0;
          wireless.freq = getBand(wireless.channel) + " GHz";
        }
      }
    }

    // Determine default route (which interface is primary)
    const defaultRoute = run("ip -4 route show default 2>/dev/null").split("\n")[0] || "";
    let activeInterface = "none";
    if (defaultRoute.includes("end0") || defaultRoute.includes("eth0")) activeInterface = "ethernet";
    else if (defaultRoute.includes("wlan0")) activeInterface = "wifi";

    // WiFi radio state
    const radioState = run("nmcli radio wifi").trim();
    const radioEnabled = radioState === "enabled";

    return { ethernet, wireless, activeInterface, radioEnabled };
  } catch (e: any) {
    return { error: e.message };
  }
}

// GET /api/networks — available WiFi networks (triggers rescan)
function getNetworks() {
  try {
    run("nmcli device wifi rescan 2>/dev/null", 5000);

    const raw = run("nmcli -t -f IN-USE,BSSID,SSID,CHAN,RATE,SIGNAL,SECURITY device wifi list");
    if (!raw) return { networks: [] };

    const entries = raw
      .split("\n")
      .map((line) => {
        const f = parseTerse(line);
        const ch = parseInt(f[3]) || 0;
        return {
          inUse: f[0] === "*",
          bssid: f[1],
          ssid: f[2],
          channel: ch,
          band: getBand(ch),
          rate: f[4],
          signal: parseInt(f[5]) || 0,
          security: f[6] || "",
        };
      })
      .filter((n) => n.ssid); // Skip hidden SSIDs

    // Group by SSID — keep best signal, collect all bands
    const grouped = new Map<string, any>();
    for (const entry of entries) {
      const existing = grouped.get(entry.ssid);
      if (!existing) {
        grouped.set(entry.ssid, { ...entry, bands: new Set([entry.band]) });
      } else {
        existing.bands.add(entry.band);
        if (entry.signal > existing.signal) {
          existing.signal = entry.signal;
          existing.channel = entry.channel;
          existing.band = entry.band;
          existing.rate = entry.rate;
          existing.bssid = entry.bssid;
        }
        if (entry.inUse) existing.inUse = true;
        // Merge security info
        if (entry.security && !existing.security.includes(entry.security)) {
          existing.security = entry.security;
        }
      }
    }

    const networks = Array.from(grouped.values())
      .map((n) => ({ ...n, bands: Array.from(n.bands).sort() }))
      .sort((a, b) => {
        if (a.inUse !== b.inUse) return a.inUse ? -1 : 1;
        return b.signal - a.signal;
      });

    return { networks };
  } catch (e: any) {
    return { error: e.message, networks: [] };
  }
}

// GET /api/saved — saved WiFi connections
function getSaved() {
  try {
    const raw = run("nmcli -t -f NAME,UUID,TYPE,AUTOCONNECT,ACTIVE connection show");
    if (!raw) return { connections: [] };

    const connections = raw
      .split("\n")
      .map((l) => parseTerse(l))
      .filter((f) => f[2] === "802-11-wireless")
      .map((f) => ({
        name: f[0],
        uuid: f[1],
        autoconnect: f[3] === "yes",
        active: f[4] === "yes",
      }))
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return { connections };
  } catch (e: any) {
    return { error: e.message, connections: [] };
  }
}

// POST /api/connect — connect to a network
function connectNetwork(ssid: string, password?: string) {
  try {
    const esc = ssid.replace(/"/g, '\\"');

    // Check for existing saved connection
    const saved = getSaved();
    const existing = saved.connections?.find((c: any) => c.name === ssid);

    if (existing) {
      const result = run(`nmcli connection up "${esc}" 2>&1`, 30000);
      if (result.includes("successfully")) return { success: true, message: "Connected!" };
      return { error: result || "Connection failed" };
    }

    // New connection
    let cmd = `nmcli device wifi connect "${esc}"`;
    if (password) cmd += ` password "${password.replace(/"/g, '\\"')}"`;

    const result = run(cmd + " 2>&1", 30000);
    if (result.includes("successfully")) return { success: true, message: "Connected!" };
    if (result.includes("Secrets were required")) return { error: "Password required" };
    return { error: result || "Connection failed" };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ==========================================
// Connection test — self-contained shell script
// Runs independently of the Bun server so network loss doesn't affect it
// ==========================================
const TEST_RESULT_FILE = "/tmp/wifi-test-result.json";
let testInProgress = false;

// Generate the failsafe test script
function generateTestScript(currentNet: string, testNet: string, duration: number): string {
  // Shell script that ALWAYS restores the original network
  return `#!/bin/bash
set -o pipefail

CURRENT_NET='${currentNet.replace(/'/g, "'\\''")}'
TEST_NET='${testNet.replace(/'/g, "'\\''")}'
DURATION=${duration}
RESULT='${TEST_RESULT_FILE}'
NMCLI=/run/current-system/sw/bin/nmcli
PING=/run/current-system/sw/bin/ping

# Restore original network — retries aggressively, MUST succeed
restore() {
  local restored=false
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if $NMCLI connection up "$CURRENT_NET" 2>/dev/null | grep -q "successfully"; then
      restored=true
      break
    fi
    sleep 2
  done
  if [ "$restored" = false ]; then
    # Nuclear option: restart NetworkManager and try again
    systemctl restart NetworkManager
    sleep 3
    for i in 1 2 3; do
      $NMCLI connection up "$CURRENT_NET" 2>/dev/null && break
      sleep 2
    done
  fi
}

# ALWAYS restore on exit (any exit — normal, error, signal)
trap restore EXIT

# Write initial status
echo '{"phase":"connecting","testNet":"'"$TEST_NET"'","duration":'$DURATION'}' > "$RESULT"

# Connect to test network
CONNECT_OUT=$($NMCLI connection up "$TEST_NET" 2>&1)
if ! echo "$CONNECT_OUT" | grep -q "successfully"; then
  echo '{"phase":"done","connected":false,"internet":false,"error":"Failed to connect: '"$(echo "$CONNECT_OUT" | tr '"' "'" | head -1)"'"}' > "$RESULT"
  exit 1
fi

echo '{"phase":"testing","testNet":"'"$TEST_NET"'","duration":'$DURATION'}' > "$RESULT"

# Wait briefly for DHCP
sleep 2

# Get assigned IP
TEST_IP=$($NMCLI -t -f IP4.ADDRESS device show wlan0 2>/dev/null | grep IP4.ADDRESS | head -1 | cut -d: -f2-)

# Ping test (ICMP)
PING_OUT=$($PING -c 3 -W 3 8.8.8.8 2>&1)
PING_OK=$?
LATENCY=$(echo "$PING_OUT" | grep "rtt" | awk -F'/' '{print $5}')

# DNS test
DNS_OK=false
if nslookup google.com 2>/dev/null | grep -q "Address"; then
  DNS_OK=true
fi

# Remaining wait
ELAPSED=4
REMAINING=$((DURATION - ELAPSED))
if [ $REMAINING -gt 0 ]; then
  echo '{"phase":"waiting","testNet":"'"$TEST_NET"'","remaining":'$REMAINING',"connected":true,"internet":'$( [ $PING_OK -eq 0 ] && echo true || echo false )',"ip":"'"$TEST_IP"'"}' > "$RESULT"
  sleep $REMAINING
fi

# Write final results (restore happens via trap after exit)
if [ $PING_OK -eq 0 ]; then
  echo '{"phase":"restoring","connected":true,"internet":true,"latency":"'"${LATENCY}ms"'","dns":'$DNS_OK',"ip":"'"$TEST_IP"'","testNet":"'"$TEST_NET"'"}' > "$RESULT"
else
  echo '{"phase":"restoring","connected":true,"internet":false,"dns":'$DNS_OK',"ip":"'"$TEST_IP"'","testNet":"'"$TEST_NET"'"}' > "$RESULT"
fi

# Exit triggers trap → restore()
exit 0
`;
}

function startConnectionTest(testNet: string, duration: number) {
  if (testInProgress) return { error: "Test already in progress" };

  // Get current active WiFi connection
  const status = getStatus();
  const currentNet = status.wireless?.connection;
  if (!currentNet) return { error: "No active WiFi connection to restore to" };
  if (currentNet === testNet) return { error: "Already connected to that network" };

  // Validate duration
  if (duration < 5) duration = 5;
  if (duration > 120) duration = 120;

  testInProgress = true;

  // Write script to temp file and execute detached
  const scriptPath = "/tmp/wifi-test-script.sh";
  const { writeFileSync } = require("fs");
  writeFileSync(scriptPath, generateTestScript(currentNet, testNet, duration), { mode: 0o755 });

  const { spawn } = require("child_process");
  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Watch for completion
  const checkDone = setInterval(() => {
    try {
      const { readFileSync } = require("fs");
      const result = JSON.parse(readFileSync(TEST_RESULT_FILE, "utf-8"));
      if (result.phase === "done" || (result.phase === "restoring" && result.connected !== undefined)) {
        // Give restore time to complete
        setTimeout(() => {
          testInProgress = false;
          try {
            const final = JSON.parse(readFileSync(TEST_RESULT_FILE, "utf-8"));
            final.phase = "done";
            writeFileSync(TEST_RESULT_FILE, JSON.stringify(final));
          } catch {}
        }, 15000); // Wait 15s for restore to finish
        clearInterval(checkDone);
      }
    } catch {}
  }, 2000);

  // Safety timeout — always clear testInProgress
  setTimeout(() => {
    testInProgress = false;
    clearInterval(checkDone);
  }, (duration + 30) * 1000);

  return { success: true, message: "Test started", duration, testNet, currentNet };
}

function getTestStatus() {
  try {
    const { readFileSync, existsSync } = require("fs");
    if (!existsSync(TEST_RESULT_FILE)) return { phase: "idle" };
    const result = JSON.parse(readFileSync(TEST_RESULT_FILE, "utf-8"));
    result.inProgress = testInProgress;
    return result;
  } catch {
    return { phase: "idle", inProgress: testInProgress };
  }
}

// POST /api/radio — toggle WiFi radio on/off
function setRadio(enabled: boolean) {
  try {
    const result = run(`nmcli radio wifi ${enabled ? "on" : "off"} 2>&1`);
    return { success: true, radioEnabled: enabled };
  } catch (e: any) {
    return { error: e.message };
  }
}

// POST /api/disconnect — disconnect WiFi
function disconnect() {
  try {
    run("nmcli device disconnect wlan0 2>&1");
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

// POST /api/forget — delete a saved connection
function forgetConnection(name: string) {
  try {
    const esc = name.replace(/"/g, '\\"');
    const result = run(`nmcli connection delete "${esc}" 2>&1`);
    if (result.includes("successfully deleted")) return { success: true };
    return { error: result || "Failed to forget network" };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ==========================================
// HTML UI
// ==========================================

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WiFi Manager</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📶</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
      color: #e0e0e0;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 20px; color: #58a6ff; font-size: 1.8rem; }
    .card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .card h2 {
      font-size: 1rem;
      color: #79c0ff;
      margin-bottom: 15px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .status-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .status-item {
      background: rgba(0,0,0,0.2);
      padding: 10px;
      border-radius: 8px;
    }
    .status-item label { font-size: 0.75rem; color: #888; display: block; margin-bottom: 4px; }
    .status-item span { font-weight: 600; }
    .controls { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 15px; }
    button {
      background: #1f6feb;
      color: white;
      border: none;
      padding: 12px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
      flex: 1;
      min-width: 120px;
    }
    button:hover { background: #388bfd; transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:disabled { background: #555; cursor: not-allowed; transform: none; }
    button.danger { background: #da3633; }
    button.danger:hover { background: #f85149; }
    button.success { background: #238636; }
    button.success:hover { background: #2ea043; }
    button.secondary { background: #30363d; }
    button.secondary:hover { background: #484f58; }
    .network-list { display: flex; flex-direction: column; gap: 8px; }
    .network {
      background: rgba(0,0,0,0.3);
      padding: 14px;
      border-radius: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .network:hover { background: rgba(255,255,255,0.08); }
    .network.active { border-left: 3px solid #238636; }
    .network-info { flex: 1; min-width: 0; }
    .network-name {
      font-weight: 600;
      font-size: 1rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .network-meta {
      font-size: 0.8rem;
      color: #888;
      margin-top: 4px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .badge {
      font-size: 0.65rem;
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
      display: inline-block;
    }
    .badge.band-24 { background: #1f6feb; }
    .badge.band-5 { background: #8b5cf6; }
    .badge.band-6 { background: #d926a9; }
    .badge.connected { background: #238636; }
    .badge.saved { background: #30363d; color: #999; }
    .badge.open { background: #238636; }
    .badge.secured { background: #da3633; }
    .signal-bars {
      font-family: monospace;
      font-size: 0.85rem;
      letter-spacing: 1px;
      min-width: 50px;
    }
    .signal-icon {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .network-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .network-actions button {
      padding: 8px 12px;
      font-size: 0.8rem;
      min-width: auto;
      flex: none;
    }
    .status-msg {
      padding: 10px;
      border-radius: 8px;
      text-align: center;
      margin-bottom: 15px;
    }
    .status-msg.scanning {
      background: rgba(31,111,235,0.2);
      color: #58a6ff;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    .status-msg.error { background: rgba(218,54,51,0.2); color: #f85149; }
    .empty { text-align: center; color: #666; padding: 30px; }
    .refresh-btn {
      background: transparent;
      border: 1px solid #555;
      padding: 8px 16px;
      font-size: 0.85rem;
      min-width: auto;
      flex: none;
    }
    .refresh-btn:hover { background: rgba(255,255,255,0.05); }

    /* Password modal */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85);
      z-index: 1000;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .modal-overlay.show { display: flex; }
    .modal {
      background: #161b22;
      border-radius: 16px;
      max-width: 420px;
      width: 100%;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .modal-header {
      padding: 20px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-header h3 { margin: 0; color: #58a6ff; }
    .modal-close {
      background: none;
      border: none;
      color: #888;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      min-width: auto;
      flex: none;
    }
    .modal-close:hover { color: #fff; background: none; }
    .modal-body { padding: 20px; }
    .form-group { margin-bottom: 16px; }
    .form-group label {
      display: block;
      font-size: 0.85rem;
      color: #999;
      margin-bottom: 6px;
    }
    .form-group input {
      width: 100%;
      background: rgba(255,255,255,0.08);
      border: 1px solid #444;
      border-radius: 8px;
      color: #e0e0e0;
      padding: 12px;
      font-size: 1rem;
      outline: none;
    }
    .form-group input:focus { border-color: #1f6feb; }
    .modal-actions { display: flex; gap: 10px; margin-top: 20px; }
    .modal-actions button { flex: 1; }
    .network-ssid-display {
      font-size: 1.1rem;
      font-weight: 600;
      color: #e0e0e0;
      margin-bottom: 4px;
    }
    .network-security-display {
      font-size: 0.8rem;
      color: #888;
    }
    .connecting-msg {
      text-align: center;
      padding: 20px;
      color: #58a6ff;
      animation: pulse 1s infinite;
      display: none;
    }

    /* Mobile responsive */
    @media (max-width: 480px) {
      body { padding: 10px; }
      h1 { font-size: 1.4rem; margin-bottom: 12px; }
      .card { padding: 14px; margin-bottom: 14px; }
      .status-grid { gap: 6px; }
      .status-item { padding: 8px; }
      .controls { gap: 6px; }
      button { padding: 10px 14px; font-size: 0.85rem; min-width: 0; }
      .network { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; }
      .network-actions { justify-content: stretch; }
      .network-actions button { flex: 1; min-width: 0; padding: 10px 8px; }
      .modal { border-radius: 12px; }
    }
    @media (max-width: 360px) {
      .status-grid { grid-template-columns: 1fr; }
      .controls { flex-direction: column; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📶 WiFi Manager</h1>

    <div class="card">
      <h2>Connection</h2>
      <div id="status"></div>
      <div class="controls">
        <button id="radioBtn" onclick="toggleRadio()">WiFi On</button>
        <button id="scanBtn" onclick="toggleScan()">Start Scan</button>
        <button id="disconnectBtn" class="danger" onclick="doDisconnect()" style="display:none">Disconnect</button>
      </div>
    </div>

    <div class="card" id="saved-section" style="display:none">
      <h2>💾 Saved Networks <button class="refresh-btn" onclick="loadSaved()">↻</button></h2>
      <div id="saved-list" class="network-list"></div>
    </div>

    <div class="card">
      <h2>📡 Available Networks <button class="refresh-btn" onclick="loadNetworks()">↻</button></h2>
      <div id="scan-status"></div>
      <div id="network-list" class="network-list"></div>
    </div>
  </div>

  <!-- Test Connection Modal -->
  <div class="modal-overlay" id="testModal" onclick="if(event.target===this)closeTestModal()">
    <div class="modal">
      <div class="modal-header">
        <h3>🧪 Test Connection</h3>
        <button class="modal-close" onclick="closeTestModal()">×</button>
      </div>
      <div class="modal-body">
        <div id="test-form">
          <div class="network-ssid-display" id="test-ssid"></div>
          <p style="color:#999;font-size:0.85rem;margin:10px 0">Temporarily connects to this network, tests internet, then switches back to your current network.</p>
          <div class="form-group">
            <label>Duration (seconds)</label>
            <input type="number" id="test-duration" value="10" min="5" max="120" style="width:100%;background:rgba(255,255,255,0.08);border:1px solid #444;border-radius:8px;color:#e0e0e0;padding:12px;font-size:1rem;outline:none">
          </div>
          <div class="modal-actions">
            <button class="secondary" onclick="closeTestModal()">Cancel</button>
            <button id="startTestBtn" onclick="startTest()">Start Test</button>
          </div>
        </div>
        <div id="test-progress" style="display:none">
          <div id="test-phase" class="status-msg scanning" style="margin-bottom:15px">Starting test...</div>
          <div id="test-results" style="display:none"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Password Modal -->
  <div class="modal-overlay" id="passwordModal" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <div class="modal-header">
        <h3>🔐 Connect to Network</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div id="modal-network-info">
          <div class="network-ssid-display" id="modal-ssid"></div>
          <div class="network-security-display" id="modal-security"></div>
        </div>
        <div id="modal-form">
          <div class="form-group" id="password-group">
            <label>Password</label>
            <input type="password" id="password-input" placeholder="Enter WiFi password"
              onkeydown="if(event.key==='Enter')doConnect()">
          </div>
          <div class="modal-actions">
            <button class="secondary" onclick="closeModal()">Cancel</button>
            <button class="success" id="connectBtn" onclick="doConnect()">Connect</button>
          </div>
        </div>
        <div class="connecting-msg" id="connecting-msg">Connecting...</div>
      </div>
    </div>
  </div>

  <script>
    let scanning = false;
    let scanInterval = null;
    let connectingTo = null; // { ssid, security }
    let savedNames = new Set();

    async function api(endpoint, method = 'GET', body = null) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch('/api' + endpoint, opts);
      return res.json();
    }

    async function loadStatus() {
      const data = await api('/status');
      const el = document.getElementById('status');
      if (data.error) {
        el.innerHTML = '<div class="status-msg error">' + data.error + '</div>';
        return;
      }

      const eth = data.ethernet;
      const wifi = data.wireless;
      const primary = data.activeInterface;
      const radioOn = data.radioEnabled;
      const wifiConnected = wifi && wifi.state === 'connected' && wifi.connection;
      const ethConnected = eth && eth.state === 'connected';

      // Radio button
      const radioBtn = document.getElementById('radioBtn');
      radioBtn.textContent = radioOn ? 'WiFi On' : 'WiFi Off';
      radioBtn.className = radioOn ? 'success' : 'secondary';

      // Disable scan + disconnect when radio is off
      document.getElementById('scanBtn').disabled = !radioOn;
      document.getElementById('disconnectBtn').style.display = wifiConnected ? '' : 'none';

      let html = '<div class="status-grid">';

      // Ethernet row
      if (eth) {
        const isPrimary = primary === 'ethernet';
        html += \`
          <div class="status-item" style="\${isPrimary ? 'border-left:3px solid #238636;' : ''}">
            <label>🔌 Ethernet \${isPrimary ? '(Primary)' : ''}</label>
            <span>\${ethConnected ? '✅ ' + (eth.ip || 'Connected') : '❌ Disconnected'}</span>
          </div>
        \`;
      }

      // WiFi row
      if (wifi) {
        const isPrimary = primary === 'wifi';
        html += \`
          <div class="status-item" style="\${isPrimary ? 'border-left:3px solid #238636;' : ''}">
            <label>📶 WiFi \${isPrimary ? '(Primary)' : ''}</label>
            <span>\${wifiConnected ? '✅ ' + wifi.connection : '❌ Disconnected'}</span>
          </div>
        \`;
      }

      // WiFi details when connected
      if (wifiConnected) {
        html += \`
          <div class="status-item"><label>IP Address</label><span>\${wifi.ip || 'N/A'}</span></div>
          <div class="status-item"><label>Band / Signal</label><span>\${wifi.freq || '?'} · \${wifi.signal}%</span></div>
        \`;
      }

      html += '</div>';
      el.innerHTML = html;
    }

    async function loadNetworks() {
      const data = await api('/networks');
      const el = document.getElementById('network-list');
      if (!data.networks || data.networks.length === 0) {
        el.innerHTML = '<div class="empty">No networks found. Start scanning to discover networks.</div>';
        return;
      }

      el.innerHTML = data.networks.map(n => {
        const isOpen = !n.security || n.security === '--';
        const isSaved = savedNames.has(n.ssid);
        const signalColor = n.signal >= 60 ? '#238636' : n.signal >= 30 ? '#d29922' : '#da3633';
        return \`
          <div class="network \${n.inUse ? 'active' : ''}" onclick="selectNetwork('\${esc(n.ssid)}', '\${esc(n.security)}', \${n.inUse})">
            <div class="network-info">
              <div class="network-name">
                \${isOpen ? '' : '🔒 '}\${esc(n.ssid)}
                \${n.inUse ? '<span class="badge connected">Connected</span>' : ''}
                \${isSaved && !n.inUse ? '<span class="badge saved">Saved</span>' : ''}
              </div>
              <div class="network-meta">
                <span style="color:\${signalColor}">\${n.signal}%</span>
                \${n.bands.map(b => \`<span class="badge band-\${b === '2.4' ? '24' : b}">\${b}G</span>\`).join('')}
                <span>\${isOpen ? 'Open' : n.security}</span>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    async function loadSaved() {
      const data = await api('/saved');
      const section = document.getElementById('saved-section');
      const el = document.getElementById('saved-list');

      savedNames = new Set((data.connections || []).map(c => c.name));

      if (!data.connections || data.connections.length === 0) {
        section.style.display = 'none';
        return;
      }

      section.style.display = 'block';
      el.innerHTML = data.connections.map(c => \`
        <div class="network \${c.active ? 'active' : ''}">
          <div class="network-info">
            <div class="network-name">
              \${esc(c.name)}
              \${c.active ? '<span class="badge connected">Active</span>' : ''}
              \${c.autoconnect ? '<span class="badge saved">Auto</span>' : ''}
            </div>
          </div>
          <div class="network-actions">
            \${!c.active ? \`<button class="success" onclick="event.stopPropagation();activateConnection('\${esc(c.name)}')">Connect</button>\` : ''}
            \${!c.active ? \`<button class="secondary" onclick="event.stopPropagation();showTestModal('\${esc(c.name)}')">Test</button>\` : ''}
            <button class="danger" onclick="event.stopPropagation();forgetNetwork('\${esc(c.name)}')">Forget</button>
          </div>
        </div>
      \`).join('');
    }

    function esc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function selectNetwork(ssid, security, inUse) {
      if (inUse) return; // Already connected
      const isOpen = !security || security === '--';

      connectingTo = { ssid, security };
      document.getElementById('modal-ssid').textContent = ssid;
      document.getElementById('modal-security').textContent = isOpen ? 'Open network' : security;

      if (isOpen || savedNames.has(ssid)) {
        // Open network or saved — connect directly, no password needed
        doConnect();
        return;
      }

      // Show password modal
      document.getElementById('password-group').style.display = '';
      document.getElementById('modal-form').style.display = '';
      document.getElementById('connecting-msg').style.display = 'none';
      document.getElementById('password-input').value = '';
      document.getElementById('passwordModal').classList.add('show');
      setTimeout(() => document.getElementById('password-input').focus(), 100);
    }

    async function doConnect() {
      if (!connectingTo) return;

      const modal = document.getElementById('passwordModal');
      const password = document.getElementById('password-input').value;
      const isOpen = !connectingTo.security || connectingTo.security === '--';
      const isSaved = savedNames.has(connectingTo.ssid);

      // Show connecting state
      if (modal.classList.contains('show')) {
        document.getElementById('modal-form').style.display = 'none';
        document.getElementById('connecting-msg').style.display = 'block';
      } else {
        // Show modal with just connecting message
        document.getElementById('modal-ssid').textContent = connectingTo.ssid;
        document.getElementById('modal-security').textContent = '';
        document.getElementById('modal-form').style.display = 'none';
        document.getElementById('connecting-msg').style.display = 'block';
        modal.classList.add('show');
      }

      const body = { ssid: connectingTo.ssid };
      if (!isOpen && !isSaved && password) body.password = password;

      const res = await api('/connect', 'POST', body);

      if (res.error) {
        if (res.error.includes('Password required') || res.error.includes('Secrets were required')) {
          // Need password — show form
          document.getElementById('modal-form').style.display = '';
          document.getElementById('connecting-msg').style.display = 'none';
          document.getElementById('password-group').style.display = '';
          if (!modal.classList.contains('show')) modal.classList.add('show');
          setTimeout(() => document.getElementById('password-input').focus(), 100);
          return;
        }
        alert('Connection failed: ' + res.error);
      }

      closeModal();
      connectingTo = null;
      await refresh();
    }

    function closeModal() {
      document.getElementById('passwordModal').classList.remove('show');
      connectingTo = null;
    }

    async function doDisconnect() {
      await api('/disconnect', 'POST');
      await refresh();
    }

    async function activateConnection(name) {
      const res = await api('/connect', 'POST', { ssid: name });
      if (res.error) alert('Connection failed: ' + res.error);
      await refresh();
    }

    async function forgetNetwork(name) {
      if (!confirm('Forget "' + name + '"? You\\'ll need to re-enter the password to connect again.')) return;

      const el = event?.target?.closest('.network');
      if (el) { el.style.opacity = '0.3'; el.style.pointerEvents = 'none'; }

      const res = await api('/forget', 'POST', { name });
      if (res.error) {
        alert('Failed: ' + res.error);
        if (el) { el.style.opacity = '1'; el.style.pointerEvents = ''; }
      } else {
        if (el) el.remove();
      }
      await refresh();
    }

    // === Connection Test ===
    let testSSID = '';
    let testPollInterval = null;

    function showTestModal(ssid) {
      testSSID = ssid;
      document.getElementById('test-ssid').textContent = ssid;
      document.getElementById('test-form').style.display = '';
      document.getElementById('test-progress').style.display = 'none';
      document.getElementById('test-results').style.display = 'none';
      document.getElementById('testModal').classList.add('show');
    }

    function closeTestModal() {
      document.getElementById('testModal').classList.remove('show');
      if (testPollInterval) { clearInterval(testPollInterval); testPollInterval = null; }
    }

    async function startTest() {
      const duration = parseInt(document.getElementById('test-duration').value) || 10;
      document.getElementById('test-form').style.display = 'none';
      document.getElementById('test-progress').style.display = '';
      document.getElementById('test-phase').textContent = '⏳ Starting test...';
      document.getElementById('test-phase').className = 'status-msg scanning';
      document.getElementById('test-results').style.display = 'none';

      const res = await api('/test', 'POST', { ssid: testSSID, duration });
      if (res.error) {
        document.getElementById('test-phase').textContent = '❌ ' + res.error;
        document.getElementById('test-phase').className = 'status-msg error';
        setTimeout(() => { document.getElementById('test-form').style.display = ''; document.getElementById('test-progress').style.display = 'none'; }, 3000);
        return;
      }

      // Poll for status
      testPollInterval = setInterval(async () => {
        try {
          const status = await api('/test/status');
          const phaseEl = document.getElementById('test-phase');
          const resultsEl = document.getElementById('test-results');

          if (status.phase === 'connecting') {
            phaseEl.textContent = '🔄 Connecting to ' + (status.testNet || testSSID) + '...';
          } else if (status.phase === 'testing') {
            phaseEl.textContent = '🧪 Connected! Testing internet...';
          } else if (status.phase === 'waiting') {
            const icon = status.internet ? '✅' : '❌';
            phaseEl.textContent = icon + ' Testing... ' + (status.remaining || '') + 's remaining';
          } else if (status.phase === 'restoring') {
            phaseEl.textContent = '🔄 Restoring original network...';
          } else if (status.phase === 'done' || !status.inProgress) {
            clearInterval(testPollInterval);
            testPollInterval = null;
            phaseEl.textContent = '✅ Test complete';
            phaseEl.className = 'status-msg';
            phaseEl.style.background = 'rgba(35,134,54,0.2)';
            phaseEl.style.color = '#2ea043';

            resultsEl.style.display = '';
            resultsEl.innerHTML = \`
              <div class="status-grid">
                <div class="status-item"><label>Network</label><span>\${status.testNet || testSSID}</span></div>
                <div class="status-item"><label>Connected</label><span>\${status.connected ? '✅ Yes' : '❌ No'}</span></div>
                <div class="status-item"><label>Internet</label><span>\${status.internet ? '✅ Yes' : '❌ No'}</span></div>
                \${status.latency ? \`<div class="status-item"><label>Latency</label><span>\${status.latency}</span></div>\` : ''}
                \${status.ip ? \`<div class="status-item"><label>IP Address</label><span>\${status.ip}</span></div>\` : ''}
                \${status.dns !== undefined ? \`<div class="status-item"><label>DNS</label><span>\${status.dns ? '✅ Working' : '❌ Failed'}</span></div>\` : ''}
                \${status.error ? \`<div class="status-item" style="grid-column:1/-1"><label>Error</label><span style="color:#f85149">\${status.error}</span></div>\` : ''}
              </div>
            \`;
            refresh();
          }
        } catch {}
      }, 2000);
    }

    async function toggleRadio() {
      const btn = document.getElementById('radioBtn');
      const isOn = btn.textContent === 'WiFi On';
      btn.disabled = true;
      btn.textContent = isOn ? 'Turning off...' : 'Turning on...';
      await api('/radio', 'POST', { enabled: !isOn });
      if (isOn && scanning) toggleScan(); // Stop scanning if turning off
      await refresh();
      btn.disabled = false;
    }

    function toggleScan() {
      scanning = !scanning;
      const btn = document.getElementById('scanBtn');
      const statusEl = document.getElementById('scan-status');

      if (scanning) {
        btn.textContent = 'Stop Scan';
        btn.className = 'danger';
        statusEl.innerHTML = '<div class="status-msg scanning">🔍 Scanning for networks...</div>';
        loadNetworks();
        scanInterval = setInterval(() => { loadNetworks(); loadStatus(); }, 3000);
      } else {
        btn.textContent = 'Start Scan';
        btn.className = '';
        statusEl.innerHTML = '';
        if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
      }
    }

    async function refresh() {
      await Promise.all([loadStatus(), loadSaved(), loadNetworks()]);
    }

    // Close modal on Escape
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    // Initial load
    refresh();

    // Background refresh every 10s (when not scanning)
    setInterval(() => { if (!scanning) { loadStatus(); loadSaved(); } }, 10000);
  </script>
</body>
</html>`;

// ==========================================
// Server
// ==========================================

const server = serve({
  port: PORT,
  hostname: "0.0.0.0",

  routes: {
    "/": new Response(indexHtml, { headers: { "Content-Type": "text/html" } }),

    "/api/status": {
      GET() { return Response.json(getStatus()); },
    },
    "/api/networks": {
      GET() { return Response.json(getNetworks()); },
    },
    "/api/saved": {
      GET() { return Response.json(getSaved()); },
    },
    "/api/connect": {
      async POST(req) {
        const { ssid, password } = await req.json();
        if (!ssid) return Response.json({ error: "SSID required" });
        return Response.json(connectNetwork(ssid, password));
      },
    },
    "/api/test": {
      async POST(req) {
        const { ssid, duration } = await req.json();
        if (!ssid) return Response.json({ error: "SSID required" });
        return Response.json(startConnectionTest(ssid, duration || 10));
      },
    },
    "/api/test/status": {
      GET() { return Response.json(getTestStatus()); },
    },
    "/api/radio": {
      async POST(req) {
        const { enabled } = await req.json();
        return Response.json(setRadio(!!enabled));
      },
    },
    "/api/disconnect": {
      async POST() { return Response.json(disconnect()); },
    },
    "/api/forget": {
      async POST(req) {
        const { name } = await req.json();
        if (!name) return Response.json({ error: "Network name required" });
        return Response.json(forgetConnection(name));
      },
    },
  },

  development: true,
});

console.log(`📶 WiFi Manager running at http://localhost:${server.port}`);
