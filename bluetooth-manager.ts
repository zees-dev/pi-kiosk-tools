/**
 * Bluetooth Manager - Single-file Bun fullstack server
 * 
 * A web-based Bluetooth device manager using BlueZ D-Bus API.
 * Supports scanning, pairing, trusting, and connecting devices.
 * 
 * Usage: bun run server.ts
 * Then open http://localhost:3456
 */

import { serve } from "bun";
import { readFileSync, writeFileSync, existsSync } from "fs";

// Device tags (user-assigned labels)
const TAGS_FILE = join(import.meta.dir, "tags.json");

function loadTags(): Record<string, string> {
  try {
    if (existsSync(TAGS_FILE)) return JSON.parse(readFileSync(TAGS_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveTags(tags: Record<string, string>) {
  writeFileSync(TAGS_FILE, JSON.stringify(tags, null, 2));
}

import { join } from "path";

// D-Bus connection (lazy initialized)
let dbus: any = null;
let bluez: any = null;

async function getDBus() {
  if (!dbus) {
    const DBus = await import("dbus-next");
    dbus = DBus.systemBus();
    bluez = await dbus.getProxyObject("org.bluez", "/");
  }
  return { dbus, bluez };
}

// Get the default Bluetooth adapter
async function getAdapter() {
  const { dbus } = await getDBus();
  const obj = await dbus.getProxyObject("org.bluez", "/org/bluez/hci0");
  return obj.getInterface("org.bluez.Adapter1");
}

// Get ObjectManager to list all devices
async function getObjectManager() {
  const { bluez } = await getDBus();
  return bluez.getInterface("org.freedesktop.DBus.ObjectManager");
}

// Track devices currently being paired from the UI (prevents concurrent + gates agent)
const pairingInProgress = new Set<string>();

// ==========================================
// D-Bus BlueZ Agent (handles pairing)
// Without a registered agent, Pairable reverts to false
// and all Pair()/Connect() calls silently fail.
// Agent ONLY accepts pairing for devices in pairingInProgress.
// ==========================================
const AGENT_PATH = "/org/bluez/agent/btmanager";
let agentRegistered = false;
let agentRegistering: Promise<void> | null = null;

async function registerAgent() {
  if (agentRegistered) return;
  if (agentRegistering) return agentRegistering;
  agentRegistering = doRegisterAgent();
  return agentRegistering;
}

async function doRegisterAgent() {
  try {
    const { dbus } = await getDBus();
    const DBus = await import("dbus-next");
    const DBusInterface = DBus.interface.Interface;

    // Agent that only accepts pairing for devices explicitly initiated from the UI.
    // Unsolicited pairing (e.g. after forget) is rejected.
    const DBusError = DBus.DBusError;
    const { execSync } = require("child_process");

    // Check if a device (by D-Bus path) is already trusted — sync for agent callbacks
    function isTrustedDevice(devicePath: string): boolean {
      try {
        // Extract MAC from path like /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF
        const mac = devicePath.split("/").pop()?.replace(/^dev_/, "").replace(/_/g, ":");
        if (!mac) return false;
        const info = execSync(`bluetoothctl info ${mac} 2>/dev/null`, { timeout: 2000, encoding: "utf-8" });
        return /Trusted: yes/i.test(info);
      } catch {
        return false;
      }
    }

    function assertPairingAllowed(device: string, method: string) {
      if (!pairingInProgress.has(device)) {
        console.log(`[agent] REJECTED ${method} from ${device} (not initiated from UI)`);
        throw new DBusError("org.bluez.Error.Rejected", "Pairing not initiated from UI");
      }
    }

    class BluezAgent extends DBusInterface {
      Release() { console.log("[agent] Released"); agentRegistered = false; }
      RequestPinCode(device: string) { assertPairingAllowed(device, "RequestPinCode"); return "0000"; }
      DisplayPinCode(_device: string, _pincode: string) {}
      RequestPasskey(device: string) { assertPairingAllowed(device, "RequestPasskey"); return 0; }
      DisplayPasskey(_device: string, _passkey: number, _entered: number) {}
      RequestConfirmation(device: string, passkey: number) {
        assertPairingAllowed(device, "RequestConfirmation");
        console.log(`[agent] Confirmed ${device} (${passkey})`);
      }
      RequestAuthorization(device: string) {
        assertPairingAllowed(device, "RequestAuthorization");
        console.log(`[agent] Authorized ${device}`);
      }
      AuthorizeService(device: string, uuid: string) {
        // Always allow already-trusted devices to reconnect their services
        // (e.g. DS4 pressing PS button). Only gate new/untrusted devices.
        const isTrusted = isTrustedDevice(device);
        if (isTrusted) {
          console.log(`[agent] Authorized service ${uuid} for TRUSTED ${device}`);
          return;
        }
        assertPairingAllowed(device, "AuthorizeService");
        console.log(`[agent] Authorized service ${uuid} for ${device}`);
      }
      Cancel() { console.log("[agent] Cancelled"); }
    }

    BluezAgent.configureMembers({
      methods: {
        Release: { inSignature: "", outSignature: "" },
        RequestPinCode: { inSignature: "o", outSignature: "s" },
        DisplayPinCode: { inSignature: "os", outSignature: "" },
        RequestPasskey: { inSignature: "o", outSignature: "u" },
        DisplayPasskey: { inSignature: "ouu", outSignature: "" },
        RequestConfirmation: { inSignature: "ou", outSignature: "" },
        RequestAuthorization: { inSignature: "o", outSignature: "" },
        AuthorizeService: { inSignature: "os", outSignature: "" },
        Cancel: { inSignature: "", outSignature: "" },
      },
    });

    const agent = new BluezAgent("org.bluez.Agent1");
    try { dbus.unexport(AGENT_PATH); } catch {}
    dbus.export(AGENT_PATH, agent);

    // Register with BlueZ AgentManager
    const bluezObj = await dbus.getProxyObject("org.bluez", "/org/bluez");
    const agentMgr = bluezObj.getInterface("org.bluez.AgentManager1");
    try { await agentMgr.UnregisterAgent(AGENT_PATH); } catch {}
    await agentMgr.RegisterAgent(AGENT_PATH, "NoInputNoOutput");
    await agentMgr.RequestDefaultAgent(AGENT_PATH);

    // Keep pairable OFF by default — only enable during explicit UI pairing
    // This prevents forgotten devices from auto-repairing
    const adapterObj = await dbus.getProxyObject("org.bluez", "/org/bluez/hci0");
    const adapterProps = adapterObj.getInterface("org.freedesktop.DBus.Properties");
    await adapterProps.Set("org.bluez.Adapter1", "Pairable", new DBus.Variant("b", false));

    agentRegistered = true;
    console.log("[agent] Registered (NoInputNoOutput) — pairable OFF by default");
  } catch (error: any) {
    console.error("[agent] Registration failed:", error.message);
  } finally {
    agentRegistering = null;
  }
}

// API: Get adapter info
async function getAdapterInfo() {
  try {
    const { dbus } = await getDBus();
    const obj = await dbus.getProxyObject("org.bluez", "/org/bluez/hci0");
    const props = obj.getInterface("org.freedesktop.DBus.Properties");
    
    const powered = await props.Get("org.bluez.Adapter1", "Powered");
    const discovering = await props.Get("org.bluez.Adapter1", "Discovering");
    const address = await props.Get("org.bluez.Adapter1", "Address");
    const name = await props.Get("org.bluez.Adapter1", "Name");
    
    return {
      address: address.value,
      name: name.value,
      powered: powered.value,
      discovering: discovering.value,
    };
  } catch (error: any) {
    return { error: error.message };
  }
}

// API: Power on/off adapter
async function setPower(on: boolean) {
  try {
    const { dbus } = await getDBus();
    const DBus = await import("dbus-next");
    const obj = await dbus.getProxyObject("org.bluez", "/org/bluez/hci0");
    const props = obj.getInterface("org.freedesktop.DBus.Properties");
    await props.Set("org.bluez.Adapter1", "Powered", new DBus.Variant("b", on));
    return { success: true, powered: on };
  } catch (error: any) {
    return { error: error.message };
  }
}

// API: Start/stop discovery
async function setDiscovery(start: boolean) {
  try {
    // Ensure agent is registered (required for pairing to work)
    await registerAgent();

    const { dbus } = await getDBus();
    const DBus = await import("dbus-next");
    const adapter = await getAdapter();
    const adapterObj = await dbus.getProxyObject("org.bluez", "/org/bluez/hci0");
    const props = adapterObj.getInterface("org.freedesktop.DBus.Properties");

    if (start) {
      // Discoverable so controllers can see us, but NOT pairable (only during explicit pair)
      await props.Set("org.bluez.Adapter1", "Discoverable", new DBus.Variant("b", true));
      await adapter.StartDiscovery();
    } else {
      await adapter.StopDiscovery();
      await props.Set("org.bluez.Adapter1", "Discoverable", new DBus.Variant("b", false));
    }
    return { success: true, discovering: start };
  } catch (error: any) {
    return { error: error.message };
  }
}

// Helper to get device type from class
function getDeviceType(deviceClass: number | undefined, icon: string | undefined): string {
  if (icon) {
    const iconTypes: Record<string, string> = {
      'input-gaming': '🎮 Controller',
      'input-keyboard': '⌨️ Keyboard', 
      'input-mouse': '🖱️ Mouse',
      'audio-card': '🔊 Audio',
      'audio-headphones': '🎧 Headphones',
      'audio-headset': '🎧 Headset',
      'phone': '📱 Phone',
      'computer': '💻 Computer',
    };
    if (iconTypes[icon]) return iconTypes[icon];
  }
  
  if (deviceClass) {
    // Major device class is bits 8-12
    const majorClass = (deviceClass >> 8) & 0x1f;
    const deviceTypes: Record<number, string> = {
      1: '💻 Computer',
      2: '📱 Phone',
      3: '🌐 Network',
      4: '🔊 Audio/Video',
      5: '🎮 Peripheral',
      6: '📷 Imaging',
      7: '⌚ Wearable',
    };
    if (deviceTypes[majorClass]) return deviceTypes[majorClass];
  }
  
  return '📶 Device';
}

// API: List discovered devices
async function listDevices() {
  try {
    const objectManager = await getObjectManager();
    const objects = await objectManager.GetManagedObjects();
    const devices: any[] = [];
    
    for (const [path, interfaces] of Object.entries(objects) as any) {
      if (path.startsWith("/org/bluez/hci0/dev_") && interfaces["org.bluez.Device1"]) {
        const device = interfaces["org.bluez.Device1"];
        const address = device.Address?.value || "unknown";
        const icon = device.Icon?.value;
        const deviceClass = device.Class?.value;
        const deviceType = getDeviceType(deviceClass, icon);
        
        // Prefer Name, then Alias, then type + short MAC
        let name = device.Name?.value;
        if (!name) {
          const alias = device.Alias?.value;
          // If alias looks like a MAC address (contains dashes/colons), use device type + short MAC
          if (alias && (alias.includes('-') || alias.includes(':'))) {
            const shortMac = address.split(':').slice(-2).join(':');
            name = `${deviceType} (${shortMac})`;
          } else {
            name = alias || `${deviceType} (${address.split(':').slice(-2).join(':')})`;
          }
        }
        
        // Check if controller has an active input device
        const isGamepad = icon === "input-gaming";
        const isConnected = device.Connected?.value || false;
        const inputActive = isGamepad && isConnected ? await hasInputDevice(address) : false;
        
        const tags = loadTags();
        devices.push({
          path,
          address,
          name,
          tag: tags[address] || null,
          paired: device.Paired?.value || false,
          trusted: device.Trusted?.value || false,
          connected: isConnected,
          inputActive,
          icon: icon || "device",
          deviceType,
          rssi: isConnected ? await getLiveRssi(address) : (device.RSSI?.value ?? null),
          battery: isConnected ? await getBatteryLevel(address) : null,
          manufacturer: device.Manufacturer?.value,
        });
      }
    }
    
    return { devices };
  } catch (error: any) {
    return { error: error.message, devices: [] };
  }
}

// Helper: check if a Bluetooth device has a /dev/input entry
async function hasInputDevice(address: string): Promise<boolean> {
  const { readFileSync } = await import("fs");
  try {
    const devices = readFileSync("/proc/bus/input/devices", "utf-8");
    return devices.toLowerCase().includes(address.toLowerCase().replace(/:/g, ":"));
  } catch { return false; }
}

// Get live RSSI for a connected device via hcitool
async function getLiveRssi(address: string): Promise<number | null> {
  const { execSync } = await import("child_process");
  try {
    const out = execSync(`/run/current-system/sw/bin/hcitool rssi ${address} 2>/dev/null`, { timeout: 1000, encoding: "utf-8" }).trim();
    const match = out.match(/RSSI return value:\s*(-?\d+)/);
    return match ? parseInt(match[1]) : null;
  } catch { return null; }
}

// Get battery level from /sys/class/power_supply (hid-sony, xpadneo, etc.)
async function getBatteryLevel(address: string): Promise<{ capacity: number; status: string } | null> {
  const { readdirSync, readFileSync } = await import("fs");
  try {
    const addrLower = address.toLowerCase();
    const entries = readdirSync("/sys/class/power_supply");
    const match = entries.find(e => e.toLowerCase().includes(addrLower));
    if (!match) return null;
    const capacity = parseInt(readFileSync(`/sys/class/power_supply/${match}/capacity`, "utf-8").trim());
    const status = readFileSync(`/sys/class/power_supply/${match}/status`, "utf-8").trim();
    return { capacity, status };
  } catch { return null; }
}

// Helper: run bluetoothctl command
async function btctl(cmd: string): Promise<string> {
  const { execSync } = await import("child_process");
  try {
    return execSync(`bluetoothctl ${cmd}`, { timeout: 10000 }).toString();
  } catch (e: any) {
    return e.stdout?.toString() || e.message;
  }
}

// API: Pair with device
// Flow: ensure agent → trust → pair → connect → wait for input → disable SNIFF
// NO disconnects during pairing — DS4 drops connection if disturbed
async function pairDevice(devicePath: string) {
  // Prevent concurrent pairing for same device
  if (pairingInProgress.has(devicePath)) {
    return { status: "pairing", message: "Pairing in progress..." };
  }
  pairingInProgress.add(devicePath);

  try {
    // Ensure agent is registered (required for pairing)
    await registerAgent();

    const { dbus } = await getDBus();
    const DBus = await import("dbus-next");
    const obj = await dbus.getProxyObject("org.bluez", devicePath);
    const device = obj.getInterface("org.bluez.Device1");
    const props = obj.getInterface("org.freedesktop.DBus.Properties");
    const address = (await props.Get("org.bluez.Device1", "Address")).value;

    console.log(`Pairing ${address}...`);

    // Enable pairable for this explicit pairing operation
    const adapterObj = await dbus.getProxyObject("org.bluez", "/org/bluez/hci0");
    const adapterProps = adapterObj.getInterface("org.freedesktop.DBus.Properties");
    await adapterProps.Set("org.bluez.Adapter1", "Pairable", new DBus.Variant("b", true));

    // Check if already paired and connected with input
    let paired = (await props.Get("org.bluez.Device1", "Paired")).value;
    let connected = (await props.Get("org.bluez.Device1", "Connected")).value;
    if (paired && connected && await hasInputDevice(address)) {
      return { success: true, message: "Already paired & working" };
    }

    // Step 1: Trust first (enables auto-reconnect)
    try {
      await props.Set("org.bluez.Device1", "Trusted", new DBus.Variant("b", true));
      console.log(`  Trusted`);
    } catch {}

    // Step 2: Pair if not already paired
    if (!paired) {
      // Try Pair() first
      try {
        await device.Pair();
        await new Promise(r => setTimeout(r, 1500));
        paired = (await props.Get("org.bluez.Device1", "Paired")).value;
        console.log(`  Pair() result: paired=${paired}`);
      } catch (e: any) {
        console.log(`  Pair() failed: ${e.message}`);
        paired = (await props.Get("org.bluez.Device1", "Paired")).value;
      }

      // Fallback: Connect() auto-pairs DS4 controllers
      if (!paired) {
        try {
          await device.Connect();
          await new Promise(r => setTimeout(r, 2000));
          paired = (await props.Get("org.bluez.Device1", "Paired")).value;
          console.log(`  Connect() fallback: paired=${paired}`);
        } catch (e: any) {
          paired = (await props.Get("org.bluez.Device1", "Paired")).value;
          if (!paired) return { error: `Pairing failed: ${e.message}` };
        }
      }

      if (!paired) return { error: "Pairing did not complete" };
    }

    // Step 3: Connect if not already connected (don't disconnect first!)
    connected = (await props.Get("org.bluez.Device1", "Connected")).value;
    if (!connected) {
      try {
        await device.Connect();
        await new Promise(r => setTimeout(r, 2000));
        connected = (await props.Get("org.bluez.Device1", "Connected")).value;
        console.log(`  Connect: connected=${connected}`);
      } catch (e: any) {
        console.log(`  Connect failed: ${e.message}`);
      }
    }

    // Step 4: Wait for input device (up to 5 seconds)
    let hasInput = false;
    for (let i = 0; i < 5; i++) {
      hasInput = await hasInputDevice(address);
      if (hasInput) break;
      console.log(`  Waiting for input device... (${i + 1}/5)`);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Step 5: Disable SNIFF for game controllers
    let icon = "device";
    try { icon = (await props.Get("org.bluez.Device1", "Icon")).value; } catch {}
    if (icon === "input-gaming") {
      const { exec } = await import("child_process");
      exec(`hcitool lp ${address} RSWITCH`, (err) => {
        if (!err) console.log(`  SNIFF disabled (low latency)`);
      });
    }

    if (hasInput) {
      console.log(`  ✓ Paired, connected, input active`);
      return { success: true, message: "Paired & connected!" };
    } else if (connected) {
      console.log(`  ✓ Paired & connected (input still loading)`);
      return { success: true, message: "Paired & connected" };
    } else {
      console.log(`  ⚠ Paired but not connected`);
      return { success: true, message: "Paired (tap Connect)" };
    }
  } catch (error: any) {
    return { error: error.message };
  } finally {
    pairingInProgress.delete(devicePath);
    // Disable pairable after pairing completes (prevents unsolicited re-pairing)
    try {
      const { dbus: bus } = await getDBus();
      const DBusM = await import("dbus-next");
      const aObj = await bus.getProxyObject("org.bluez", "/org/bluez/hci0");
      const aProps = aObj.getInterface("org.freedesktop.DBus.Properties");
      await aProps.Set("org.bluez.Adapter1", "Pairable", new DBusM.Variant("b", false));
    } catch {}
  }
}

// API: Trust device (for auto-reconnect)
async function trustDevice(devicePath: string, trust: boolean) {
  try {
    const { dbus } = await getDBus();
    const DBus = await import("dbus-next");
    const obj = await dbus.getProxyObject("org.bluez", devicePath);
    const props = obj.getInterface("org.freedesktop.DBus.Properties");
    await props.Set("org.bluez.Device1", "Trusted", new DBus.Variant("b", trust));
    return { success: true, trusted: trust };
  } catch (error: any) {
    return { error: error.message };
  }
}

// API: Connect to device
async function connectDevice(devicePath: string) {
  try {
    const { dbus } = await getDBus();
    const obj = await dbus.getProxyObject("org.bluez", devicePath);
    const device = obj.getInterface("org.bluez.Device1");
    const props = obj.getInterface("org.freedesktop.DBus.Properties");
    const address = (await props.Get("org.bluez.Device1", "Address")).value;
    const icon = (await props.Get("org.bluez.Device1", "Icon")).value;
    
    await device.Connect();
    await new Promise(r => setTimeout(r, 1000));
    
    // For game controllers: verify input device + disable SNIFF
    if (icon === "input-gaming") {
      // Wait for input device
      for (let i = 0; i < 3; i++) {
        if (await hasInputDevice(address)) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      
      // Disable SNIFF mode for lower latency
      const { exec } = await import("child_process");
      exec(`hcitool lp ${address} RSWITCH`, (err) => {
        if (err) console.log(`Could not disable SNIFF for ${address}: ${err.message}`);
        else console.log(`Disabled SNIFF mode for ${address} (low latency)`);
      });
    }
    
    return { success: true };
  } catch (error: any) {
    return { error: error.message };
  }
}

// API: Disconnect from device
async function disconnectDevice(devicePath: string) {
  try {
    const { dbus } = await getDBus();
    const obj = await dbus.getProxyObject("org.bluez", devicePath);
    const device = obj.getInterface("org.bluez.Device1");
    await device.Disconnect();
    return { success: true };
  } catch (error: any) {
    return { error: error.message };
  }
}

// API: Remove device (unpair)
async function removeDevice(devicePath: string) {
  try {
    const adapter = await getAdapter();
    await adapter.RemoveDevice(devicePath);
    return { success: true };
  } catch (error: any) {
    return { error: error.message };
  }
}

// API: Forget device completely (disconnect, untrust, remove)
async function forgetDevice(devicePath: string) {
  try {
    const { dbus } = await getDBus();
    const DBus = await import("dbus-next");
    const obj = await dbus.getProxyObject("org.bluez", devicePath);
    const device = obj.getInterface("org.bluez.Device1");
    const props = obj.getInterface("org.freedesktop.DBus.Properties");
    
    // 1. Disconnect if connected
    try {
      const isConnected = (await props.Get("org.bluez.Device1", "Connected")).value;
      if (isConnected) {
        await device.Disconnect();
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) {
      // Ignore disconnect errors
    }
    
    // 2. Untrust
    try {
      await props.Set("org.bluez.Device1", "Trusted", new DBus.Variant("b", false));
    } catch (e) {
      // Ignore
    }
    
    // 3. Remove from adapter (clears pairing)
    const adapter = await getAdapter();
    await adapter.RemoveDevice(devicePath);
    
    return { success: true };
  } catch (error: any) {
    return { error: error.message };
  }
}

// HTML page with embedded UI
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bluetooth Manager</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔵</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e0e0e0;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { 
      text-align: center; 
      margin-bottom: 20px; 
      color: #4fc3f7;
      font-size: 1.8rem;
    }
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
      color: #90caf9;
      margin-bottom: 15px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .adapter-info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .info-item {
      background: rgba(0,0,0,0.2);
      padding: 10px;
      border-radius: 8px;
    }
    .info-item label { 
      font-size: 0.75rem; 
      color: #888; 
      display: block;
      margin-bottom: 4px;
    }
    .info-item span { font-weight: 600; }
    .controls {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button {
      background: #2196f3;
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
    button:hover { background: #1976d2; transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:disabled { background: #555; cursor: not-allowed; }
    button.danger { background: #f44336; }
    button.danger:hover { background: #d32f2f; }
    button.success { background: #4caf50; }
    button.success:hover { background: #388e3c; }
    button.secondary { background: #455a64; }
    button.secondary:hover { background: #37474f; }
    .device-list { display: flex; flex-direction: column; gap: 10px; }
    .device {
      background: rgba(0,0,0,0.3);
      padding: 15px;
      border-radius: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 15px;
      border: 1px solid transparent;
      transition: border-color 0.3s;
    }
    .device-charging .device-name { animation: chargePulse 3s ease-in-out infinite; }
    .device-charging .batt-pill { animation: chargePulse 3s ease-in-out infinite; }
    @keyframes chargePulse {
      0%,100% { opacity: 1; color: inherit; }
      50% { opacity: 0.85; color: #FFE082; }
    }
    .device-info { flex: 1; min-width: 0; }
    .device-name {
      font-weight: 600;
      font-size: 1rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .device-address {
      font-size: 0.8rem;
      color: #888;
      font-family: monospace;
    }
    .device-tag {
      font-size: 0.7rem;
      color: #777;
      font-style: italic;
      margin-top: 2px;
    }
    .tag-btn {
      background: transparent;
      border: 1px solid #444;
      border-radius: 4px;
      color: #555;
      padding: 1px 5px;
      font-size: 0.65rem;
      min-width: auto;
      flex: none;
      vertical-align: middle;
      display: inline;
      cursor: pointer;
    }
    .tag-btn:hover { color: #aaa; border-color: #666; background: transparent; transform: none; }
    .tag-input {
      background: rgba(255,255,255,0.08);
      border: 1px solid #555;
      border-radius: 4px;
      color: #ccc;
      font-size: 0.75rem;
      padding: 4px 8px;
      width: 140px;
      outline: none;
    }
    .tag-input:focus { border-color: #4fc3f7; }
    .device-status {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .badge {
      font-size: 0.65rem;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .badge.paired { background: #7c4dff; }
    .badge.trusted { background: #00bcd4; }
    .badge.connected { background: #4caf50; }
    .badge.rssi-pill { background: rgba(255,255,255,0.12); color: #aaa; font-weight: 500; letter-spacing: 0.3px; display: inline-flex; align-items: center; gap: 4px; }
    .signal-bars { display: inline-flex; align-items: flex-end; gap: 1px; height: 10px; }
    .sbar { width: 3px; border-radius: 1px; background: rgba(255,255,255,0.2); }
    .sbar.on { background: #4caf50; }
    .sbar:nth-child(1) { height: 25%; }
    .sbar:nth-child(2) { height: 50%; }
    .sbar:nth-child(3) { height: 75%; }
    .sbar:nth-child(4) { height: 100%; }
    .batt-pill { display: inline-flex; align-items: center; gap: 3px; font-size: 0.6rem; }
    .batt-pill.batt-charging { }
    .badge.pairing { 
      background: #ff9800; 
      animation: pulse 1s infinite;
    }
    .device-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0; }
    .device-signal { display: flex; align-items: center; gap: 6px; }
    .device-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .device-actions button {
      padding: 8px 12px;
      font-size: 0.8rem;
      min-width: auto;
      flex: none;
    }
    .status {
      padding: 10px;
      border-radius: 8px;
      text-align: center;
      margin-bottom: 15px;
    }
    .status.scanning {
      background: rgba(33, 150, 243, 0.2);
      color: #64b5f6;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .status.error {
      background: rgba(244, 67, 54, 0.2);
      color: #ef5350;
    }
    .empty {
      text-align: center;
      color: #666;
      padding: 30px;
    }
    .refresh-btn {
      background: transparent;
      border: 1px solid #555;
      padding: 8px 16px;
      font-size: 0.85rem;
    }
    .refresh-btn:hover { background: rgba(255,255,255,0.05); }
    
    /* Modal styles */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.8);
      z-index: 1000;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .modal-overlay.show { display: flex; }
    .modal {
      background: #1a1a2e;
      border-radius: 16px;
      max-width: 500px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .modal-header {
      padding: 20px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-header h3 { margin: 0; color: #4fc3f7; }
    .modal-close {
      background: none;
      border: none;
      color: #888;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      min-width: auto;
    }
    .modal-close:hover { color: #fff; background: none; }
    .modal-body { padding: 20px; }
    .controller-section {
      margin-bottom: 24px;
    }
    .controller-section:last-child { margin-bottom: 0; }
    .controller-section h4 {
      color: #90caf9;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .controller-section ol {
      margin: 0;
      padding-left: 20px;
      color: #ccc;
    }
    .controller-section li {
      margin-bottom: 8px;
      line-height: 1.5;
    }
    .controller-section .note {
      background: rgba(255,193,7,0.1);
      border-left: 3px solid #ffc107;
      padding: 10px;
      margin-top: 10px;
      font-size: 0.85rem;
      color: #ffc107;
    }
    .help-btn {
      background: #455a64;
      min-width: auto;
      padding: 8px 16px;
    }
    .help-btn:hover { background: #546e7a; }

    /* Mobile responsive */
    @media (max-width: 480px) {
      body { padding: 10px; }
      h1 { font-size: 1.4rem; margin-bottom: 12px; }
      .card { padding: 14px; margin-bottom: 14px; }
      .adapter-info { grid-template-columns: 1fr 1fr; gap: 6px; }
      .info-item { padding: 8px; }
      .info-item label { font-size: 0.7rem; }
      .info-item span { font-size: 0.85rem; }
      .controls { gap: 6px; }
      button { padding: 10px 14px; font-size: 0.85rem; min-width: 0; }
      .device { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; }
      .device-info { min-width: 0; }
      .device-name { font-size: 0.95rem; }
      .device-address { font-size: 0.75rem; }
      .device-status { flex-wrap: wrap; gap: 4px; }
      .device-right { align-items: stretch; }
      .device-signal { justify-content: flex-end; }
      .device-actions { justify-content: stretch; }
      .device-actions button { flex: 1; min-width: 0; padding: 10px 8px; font-size: 0.8rem; }
      .modal { border-radius: 12px; }
      .modal-header { padding: 14px; }
      .modal-body { padding: 14px; }
      .controller-section ol { padding-left: 16px; }
      .controller-section li { font-size: 0.85rem; }
      .refresh-btn { padding: 6px 10px; font-size: 0.75rem; }
    }

    @media (max-width: 360px) {
      .adapter-info { grid-template-columns: 1fr; }
      .controls { flex-direction: column; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎮 Bluetooth Manager</h1>
    
    <div class="card">
      <h2>Adapter</h2>
      <div id="adapter-status"></div>
      <div class="controls" style="margin-top: 15px;">
        <button id="powerBtn" onclick="togglePower()">Power On</button>
        <button id="scanBtn" onclick="toggleScan()">Start Scan</button>
        <button class="help-btn" onclick="showHelp()">❓ Pairing Help</button>
      </div>
    </div>
    
    <div class="card" id="paired-section">
      <h2>🔗 Paired Devices</h2>
      <div id="paired-list" class="device-list"></div>
    </div>
    
    <div class="card">
      <h2>📡 Available Devices <button class="refresh-btn" onclick="refreshDevices()">↻</button></h2>
      <div id="scan-status"></div>
      <div id="available-list" class="device-list"></div>
    </div>
  </div>
  
  <!-- Pairing Help Modal -->
  <div class="modal-overlay" id="helpModal" onclick="if(event.target===this)hideHelp()">
    <div class="modal">
      <div class="modal-header">
        <h3>🎮 Controller Pairing Guide</h3>
        <button class="modal-close" onclick="hideHelp()">×</button>
      </div>
      <div class="modal-body">
        <div class="controller-section">
          <h4>🎮 PlayStation 4 / DualShock 4</h4>
          <ol>
            <li>Turn off the controller (hold PS button for 10 seconds)</li>
            <li>Hold <strong>Share + PS button</strong> together for 3 seconds</li>
            <li>The light bar will <strong>flash rapidly</strong> (double blink)</li>
            <li>Controller appears as <strong>"Wireless Controller"</strong></li>
            <li>Click <strong>Pair</strong> (auto-connects)</li>
          </ol>
          <div class="note">
            💡 If it doesn't appear, try resetting: use a pin in the small hole on the back near L2
          </div>
        </div>
        
        <div class="controller-section">
          <h4>🟢 Xbox Wireless Controller</h4>
          <ol>
            <li>Turn on controller (press Xbox button)</li>
            <li>Hold the <strong>Pair button</strong> (top, near USB port) for 3 seconds</li>
            <li>The Xbox button will <strong>flash rapidly</strong></li>
            <li>Controller appears as <strong>"Xbox Wireless Controller"</strong></li>
            <li>Click <strong>Pair</strong> (auto-connects)</li>
          </ol>
          <div class="note">
            💡 Xbox controllers use xpadneo driver for better support (rumble, battery level)
          </div>
        </div>
        
        <div class="controller-section">
          <h4>🔵 PlayStation 5 / DualSense</h4>
          <ol>
            <li>Turn off the controller (hold PS button for 10 seconds)</li>
            <li>Hold <strong>Create + PS button</strong> together for 3 seconds</li>
            <li>The light bar will <strong>flash blue</strong></li>
            <li>Controller appears as <strong>"DualSense Wireless Controller"</strong></li>
            <li>Click <strong>Pair</strong> (auto-connects)</li>
          </ol>
        </div>
        
        <div class="controller-section">
          <h4>🔴 Nintendo Switch Pro Controller</h4>
          <ol>
            <li>Hold the <strong>Sync button</strong> (top of controller) for 3 seconds</li>
            <li>The player LEDs will <strong>cycle back and forth</strong></li>
            <li>Controller appears as <strong>"Pro Controller"</strong></li>
            <li>Click <strong>Pair</strong> (auto-connects)</li>
          </ol>
        </div>
      </div>
    </div>
  </div>

  <script>
    let adapterState = { powered: false, discovering: false };
    const pairingDevices = new Set(); // Track devices being paired (skip refresh)

    function renderBattery(batt) {
      if (!batt) return '';
      const pct = batt.capacity;
      const bars = pct >= 60 ? 3 : pct >= 25 ? 2 : pct >= 10 ? 1 : 0;
      const charging = batt.status === 'Charging' || batt.status === 'Full';
      const outline = charging ? '#FFD54F' : (pct < 10 ? '#f44336' : '#4caf50');
      const fill = pct < 10 ? '#f44336' : '#4caf50';
      return '<span class="batt-pill' + (charging ? ' batt-charging' : '') + '" style="' + (pct < 10 ? 'color:#f44336;' : '') + '">'
        + '<svg viewBox="0 0 20 10" width="16" height="8" style="vertical-align:middle;">'
        + '<rect x="0.5" y="0.5" width="16" height="9" rx="1.5" fill="none" stroke="' + outline + '" stroke-width="1"/>'
        + '<rect x="16.5" y="3" width="2" height="4" rx="0.5" fill="' + outline + '"/>'
        + (bars >= 1 ? '<rect x="2" y="2" width="4" height="6" rx="0.5" fill="' + fill + '"/>' : '')
        + (bars >= 2 ? '<rect x="7" y="2" width="4" height="6" rx="0.5" fill="' + fill + '"/>' : '')
        + (bars >= 3 ? '<rect x="12" y="2" width="3" height="6" rx="0.5" fill="' + fill + '"/>' : '')
        + (charging ? '<path d="M9.5 1l-3 4h2.2L7 9l4.5-4.5h-2z" fill="#FFD54F"><animate attributeName="opacity" values="1;0.5;1" dur="0.8s" repeatCount="indefinite"/></path>' : '')
        + '</svg>' + (charging ? ' ⚡' : '') + ' ' + pct + '%</span>';
    }

    function renderSignalBars(rssi) {
      let bars = 0;
      if (rssi >= -25) bars = 4;
      else if (rssi >= -50) bars = 3;
      else if (rssi >= -60) bars = 2;
      else if (rssi >= -75) bars = 1;
      return '<span class="signal-bars">' + [1,2,3,4].map(i =>
        '<span class="sbar' + (i <= bars ? ' on' : '') + '"></span>'
      ).join('') + '</span>';
    }
    
    async function api(endpoint, method = 'GET', body = null) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch('/api' + endpoint, opts);
      return res.json();
    }
    
    async function loadAdapter() {
      const data = await api('/adapter');
      adapterState = data;
      
      const el = document.getElementById('adapter-status');
      if (data.error) {
        el.innerHTML = '<div class="status error">Error: ' + data.error + '</div>';
        return;
      }
      
      el.innerHTML = \`
        <div class="adapter-info">
          <div class="info-item"><label>Name</label><span>\${data.name || 'N/A'}</span></div>
          <div class="info-item"><label>Address</label><span>\${data.address || 'N/A'}</span></div>
          <div class="info-item"><label>Power</label><span>\${data.powered ? '✅ On' : '❌ Off'}</span></div>
          <div class="info-item"><label>Scanning</label><span>\${data.discovering ? '🔍 Yes' : '⏸ No'}</span></div>
        </div>
      \`;
      
      document.getElementById('powerBtn').textContent = data.powered ? 'Power Off' : 'Power On';
      document.getElementById('powerBtn').className = data.powered ? 'danger' : 'success';
      document.getElementById('scanBtn').textContent = data.discovering ? 'Stop Scan' : 'Start Scan';
      document.getElementById('scanBtn').disabled = !data.powered;
      
      const scanStatus = document.getElementById('scan-status');
      scanStatus.innerHTML = data.discovering 
        ? '<div class="status scanning">🔍 Scanning for devices...</div>' 
        : '';
    }
    
    async function refreshDevices() {
      // Don't refresh while a device is being paired (would clobber UI state)
      if (pairingDevices.size > 0) return;
      const data = await api('/devices');
      const pairedEl = document.getElementById('paired-list');
      const availableEl = document.getElementById('available-list');
      const pairedSection = document.getElementById('paired-section');
      
      if (!data.devices) {
        pairedEl.innerHTML = '<div class="empty">No paired devices</div>';
        availableEl.innerHTML = '<div class="empty">Start scanning to discover devices.</div>';
        return;
      }
      
      // Split into paired and available
      const paired = data.devices.filter(d => d.paired);
      const available = data.devices.filter(d => !d.paired);
      
      // Sort paired: connected first, then by name
      paired.sort((a, b) => {
        if (a.connected !== b.connected) return b.connected - a.connected;
        return (a.name || '').localeCompare(b.name || '');
      });
      
      // Sort available: by signal strength, then name
      available.sort((a, b) => {
        if (a.rssi && b.rssi) return b.rssi - a.rssi;
        if (a.rssi) return -1;
        if (b.rssi) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
      
      // Show/hide paired section
      pairedSection.style.display = paired.length > 0 ? 'block' : 'none';
      
      // Render paired devices
      pairedEl.innerHTML = paired.length === 0 
        ? '<div class="empty">No paired devices</div>'
        : paired.map(d => {
          const isCharging = d.battery && (d.battery.status === 'Charging' || d.battery.status === 'Full');
          return \`
          <div class="device\${isCharging ? ' device-charging' : ''}" data-path="\${d.path}">
            <div class="device-info">
              <div class="device-name">\${d.name} <button class="tag-btn" onclick="event.stopPropagation();editTag('\${d.address}', this)">\${d.tag ? '✏️' : '🏷️'}</button></div>
              <div class="device-address">\${d.address}</div>
              \${d.tag ? \`<div class="device-tag">\${d.tag}</div>\` : ''}
              <div class="device-status">
                \${d.connected ? '<span class="badge connected">Connected</span>' : '<span class="badge" style="background:#666">Disconnected</span>'}
                \${d.connected && d.inputActive ? '<span class="badge" style="background:#2e7d32">🎮 Input Active</span>' : ''}
                \${d.connected && !d.inputActive && d.icon === 'input-gaming' ? '<span class="badge" style="background:#c62828">⚠ No Input</span>' : ''}
                <span class="badge \${d.trusted ? 'trusted' : ''}" style="\${d.trusted ? '' : 'background:#555;'} cursor:pointer;" onclick="event.stopPropagation();toggleTrust('\${d.path}', \${!d.trusted})">\${d.trusted ? 'Auto-connect' : 'No auto-connect'}</span>
              </div>
            </div>
            <div class="device-right">
              \${d.connected && (d.rssi != null || d.battery) ? \`<div class="device-signal">\${d.rssi != null ? \`<span class="badge rssi-pill">\${renderSignalBars(d.rssi)} \${d.rssi} dBm</span>\` : ''}\${d.battery ? \`<span class="badge rssi-pill">\${renderBattery(d.battery)}</span>\` : ''}</div>\` : ''}
              <div class="device-actions">
                \${!d.connected ? \`<button class="success" onclick="connectDevice('\${d.path}')">Connect</button>\` : ''}
                \${d.connected ? \`<button class="secondary" onclick="disconnectDevice('\${d.path}')">Disconnect</button>\` : ''}
                <button class="danger" onclick="forgetDevice('\${d.path}')">Forget</button>
              </div>
            </div>
          </div>
        \`}).join('');
      
      // Render available devices
      availableEl.innerHTML = available.length === 0 
        ? '<div class="empty">No devices found. Start scanning to discover devices.</div>'
        : available.map(d => \`
          <div class="device" data-path="\${d.path}">
            <div class="device-info">
              <div class="device-name">\${d.name}</div>
              <div class="device-address">\${d.address}\${d.rssi ? \` · Signal: \${d.rssi > -50 ? '🟢' : d.rssi > -70 ? '🟡' : '🔴'} \${d.rssi}dBm\` : ''}</div>
              <div class="device-status"></div>
            </div>
            <div class="device-actions">
              <button onclick="pairDevice('\${d.path}')">Pair</button>
            </div>
          </div>
        \`).join('');
    }
    
    async function togglePower() {
      const btn = document.getElementById('powerBtn');
      btn.disabled = true;
      await api('/adapter/power', 'POST', { on: !adapterState.powered });
      await loadAdapter();
      await refreshDevices();
      btn.disabled = false;
    }
    
    async function toggleScan() {
      const btn = document.getElementById('scanBtn');
      btn.disabled = true;
      await api('/adapter/discovery', 'POST', { start: !adapterState.discovering });
      await loadAdapter();
      btn.disabled = false;
      
      // Auto-refresh devices while scanning
      if (!adapterState.discovering) {
        const interval = setInterval(async () => {
          await refreshDevices();
          await loadAdapter();
          if (!adapterState.discovering) clearInterval(interval);
        }, 2000);
      }
    }
    
    async function pairDevice(path) {
      if (pairingDevices.has(path)) return; // Already pairing
      pairingDevices.add(path);
      
      // Update UI immediately
      const deviceEl = document.querySelector('[data-path="' + path + '"]');
      if (deviceEl) {
        const btn = deviceEl.querySelector('.device-actions button');
        if (btn) { btn.disabled = true; btn.textContent = 'Pairing...'; btn.style.opacity = '0.7'; }
        const statusDiv = deviceEl.querySelector('.device-status');
        if (statusDiv) statusDiv.innerHTML = '<span class="badge pairing">Pairing...</span>';
      }
      
      try {
        const res = await api('/device/pair', 'POST', { path });
        
        if (res.error) {
          alert('Pairing failed: ' + res.error);
        }
      } finally {
        pairingDevices.delete(path);
        await refreshDevices();
      }
    }
    
    async function trustDevice(path, trust) {
      const res = await api('/device/trust', 'POST', { path, trust });
      if (res.error) alert('Failed: ' + res.error);
      await refreshDevices();
    }
    
    async function connectDevice(path) {
      const res = await api('/device/connect', 'POST', { path });
      if (res.error) alert('Connection failed: ' + res.error);
      await refreshDevices();
    }
    
    async function disconnectDevice(path) {
      const res = await api('/device/disconnect', 'POST', { path });
      if (res.error) alert('Disconnect failed: ' + res.error);
      await refreshDevices();
    }
    
    async function removeDevice(path) {
      if (!confirm('Remove this device? It will need to be paired again.')) return;
      const res = await api('/device/remove', 'POST', { path });
      if (res.error) alert('Remove failed: ' + res.error);
      await refreshDevices();
    }
    
    async function forgetDevice(path) {
      // Remove from DOM immediately for responsive feel
      const deviceEl = document.querySelector('[data-path="' + path + '"]');
      if (deviceEl) {
        deviceEl.style.opacity = '0.3';
        deviceEl.style.pointerEvents = 'none';
      }
      
      const res = await api('/device/forget', 'POST', { path });
      if (res.error) {
        alert('Forget failed: ' + res.error);
        if (deviceEl) { deviceEl.style.opacity = '1'; deviceEl.style.pointerEvents = ''; }
      } else {
        if (deviceEl) deviceEl.remove();
      }
      await refreshDevices();
    }
    
    async function toggleTrust(path, trust) {
      const res = await api('/device/trust', 'POST', { path, trust });
      if (res.error) alert('Trust toggle failed: ' + res.error);
      await refreshDevices();
    }

    // Tag editing
    function editTag(address, btn) {
      const device = btn.closest('.device');
      const existing = device.querySelector('.device-tag');
      const current = existing ? existing.textContent : '';
      btn.outerHTML = \`<input class="tag-input" type="text" value="\${current}" placeholder="e.g. P1 Controller" 
        onblur="saveTag('\${address}', this)" 
        onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.dataset.cancel='1';this.blur()}">\`;
      device.querySelector('.tag-input').focus();
    }
    
    async function saveTag(address, input) {
      if (input.dataset.cancel) { await refreshDevices(); return; }
      const tag = input.value.trim();
      await api('/device/tag', 'POST', { address, tag });
      await refreshDevices();
    }
    
    // Modal functions
    function showHelp() {
      document.getElementById('helpModal').classList.add('show');
    }
    
    function hideHelp() {
      document.getElementById('helpModal').classList.remove('show');
    }
    
    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideHelp();
    });
    
    // Initial load
    loadAdapter();
    refreshDevices();
    
    // Auto-refresh every 5 seconds
    setInterval(() => {
      loadAdapter();
      refreshDevices();
    }, 5000);
  </script>
</body>
</html>`;

// Start the server
const CORS = { "Access-Control-Allow-Origin": "*" };

const server = serve({
  port: 3456,
  
  routes: {
    // Serve the HTML UI
    "/": new Response(indexHtml, {
      headers: { "Content-Type": "text/html" },
    }),
    
    // API: Diagnostics (lightweight status for dashboard)
    "/api/diagnostics": {
      async GET() {
        const adapter = await getAdapterInfo();
        const { devices } = await listDevices();
        const connected = (devices || []).filter((d: any) => d.connected);
        return Response.json({
          powered: adapter.powered ?? false,
          connectedDevices: connected.map((d: any) => ({ name: d.name, type: d.deviceType, battery: d.battery })),
        }, { headers: CORS });
      },
    },

    // API: Get adapter info
    "/api/adapter": {
      async GET() {
        return Response.json(await getAdapterInfo());
      },
    },
    
    // API: Set adapter power
    "/api/adapter/power": {
      async POST(req) {
        const { on } = await req.json();
        return Response.json(await setPower(on));
      },
    },
    
    // API: Set discovery mode
    "/api/adapter/discovery": {
      async POST(req) {
        const { start } = await req.json();
        return Response.json(await setDiscovery(start));
      },
    },
    
    // API: List devices
    "/api/devices": {
      async GET() {
        return Response.json(await listDevices());
      },
    },
    
    // API: Pair device
    "/api/device/pair": {
      async POST(req) {
        const { path } = await req.json();
        return Response.json(await pairDevice(path));
      },
    },
    
    // API: Trust device
    "/api/device/trust": {
      async POST(req) {
        const { path, trust } = await req.json();
        return Response.json(await trustDevice(path, trust));
      },
    },
    
    // API: Connect device
    "/api/device/connect": {
      async POST(req) {
        const { path } = await req.json();
        return Response.json(await connectDevice(path));
      },
    },
    
    // API: Disconnect device
    "/api/device/disconnect": {
      async POST(req) {
        const { path } = await req.json();
        return Response.json(await disconnectDevice(path));
      },
    },
    
    // API: Remove device
    "/api/device/remove": {
      async POST(req) {
        const { path } = await req.json();
        return Response.json(await removeDevice(path));
      },
    },
    
    // API: Tag device
    "/api/device/tag": {
      async POST(req) {
        const { address, tag } = await req.json();
        if (!address) return Response.json({ error: "Address required" });
        const tags = loadTags();
        if (tag) {
          tags[address] = tag;
        } else {
          delete tags[address];
        }
        saveTags(tags);
        return Response.json({ success: true, tag: tag || null });
      },
    },
    
    // API: Forget device (complete cleanup)
    "/api/device/forget": {
      async POST(req) {
        const { path } = await req.json();
        return Response.json(await forgetDevice(path));
      },
    },
    "/api/device/trust": {
      async POST(req) {
        const { path, trust } = await req.json();
        try {
          const { dbus } = await getDBus();
          const obj = await dbus.getProxyObject("org.bluez", path);
          const props = obj.getInterface("org.freedesktop.DBus.Properties");
          const { Variant } = await import("dbus-next");
          await props.Set("org.bluez.Device1", "Trusted", new Variant("b", !!trust));
          return Response.json({ success: true });
        } catch (e: any) {
          return Response.json({ error: e.message });
        }
      },
    },
  },
  
  development: true,
});

// Register BlueZ agent on startup so pairing works immediately
registerAgent().catch(err => console.error("[agent] Startup registration failed:", err.message));

// ==========================================
// BT Latency Optimizer (replaces bt-optimize.sh)
// Monitors D-Bus for controller connections and disables SNIFF mode
// ==========================================
async function startBtOptimizer() {
  const { execSync, exec: execCb } = await import("child_process");
  
  function disableSniffForGamepads() {
    try {
      const conns = execSync("hcitool con 2>/dev/null", { timeout: 2000, encoding: "utf-8" });
      for (const line of conns.split("\n")) {
        const addrMatch = line.match(/([0-9A-F]{2}:){5}[0-9A-F]{2}/i);
        if (!addrMatch) continue;
        const addr = addrMatch[0];
        try {
          const info = execSync(`bluetoothctl info ${addr} 2>/dev/null`, { timeout: 1500, encoding: "utf-8" });
          if (!/Icon:\s*input-gaming/i.test(info)) continue;
          const policy = execSync(`hcitool lp ${addr} 2>/dev/null`, { timeout: 1000, encoding: "utf-8" });
          if (/SNIFF/.test(policy)) {
            execCb(`hcitool lp ${addr} RSWITCH`, (err) => {
              if (!err) console.log(`[bt-opt] SNIFF disabled for ${addr}`);
            });
          }
        } catch {}
      }
    } catch {}
  }

  // Monitor D-Bus for Bluetooth property changes (new connections)
  try {
    const { spawn } = await import("child_process");
    const monitor = spawn("dbus-monitor", [
      "--system",
      "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path_namespace='/org/bluez'"
    ], { stdio: ["ignore", "pipe", "ignore"] });

    let buffer = "";
    monitor.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      if (buffer.includes("Connected") && buffer.includes("true")) {
        buffer = "";
        // Brief delay for connection to stabilize, then disable SNIFF
        setTimeout(disableSniffForGamepads, 500);
      }
      // Prevent buffer from growing unbounded
      if (buffer.length > 4096) buffer = buffer.slice(-1024);
    });

    monitor.on("exit", (code: number) => {
      console.log(`[bt-opt] dbus-monitor exited (code ${code}), restarting in 5s...`);
      setTimeout(startBtOptimizer, 5000);
    });

    console.log("[bt-opt] Monitoring for controller connections");
  } catch (err: any) {
    console.error("[bt-opt] Failed to start monitor:", err.message);
    // Fallback: poll every 10s
    setInterval(disableSniffForGamepads, 10000);
  }

  // Initial check
  disableSniffForGamepads();
}

startBtOptimizer().catch(err => console.error("[bt-opt] Startup failed:", err.message));

console.log(`
🎮 Bluetooth Manager running at http://localhost:${server.port}

Prerequisites:
1. Bluetooth must be enabled in NixOS:
   hardware.bluetooth.enable = true;
   hardware.bluetooth.powerOnBoot = true;

2. D-Bus permissions (run once):
   echo '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
    "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
   <busconfig>
     <policy user="pi">
       <allow own="org.bluez"/>
       <allow send_destination="org.bluez"/>
       <allow send_interface="org.bluez.Adapter1"/>
       <allow send_interface="org.bluez.Device1"/>
       <allow send_interface="org.bluez.AgentManager1"/>
       <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
       <allow send_interface="org.freedesktop.DBus.Properties"/>
     </policy>
   </busconfig>' | sudo tee /etc/dbus-1/system.d/bluetooth-manager.conf

3. Install dbus-next:
   bun add dbus-next
`);
