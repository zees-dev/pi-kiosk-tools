#!/usr/bin/env bun
/**
 * RemotePad Bridge — Forward local controllers to PS4 via RemotePad WebSocket
 *
 * Serves a web UI for managing controller → PS4 pad assignments.
 * Reads evdev input from connected game controllers and forwards to PS4.
 *
 * Usage:
 *   sudo bun run bridge.ts [options]
 *
 * Options:
 *   --ui-port <n>   Web UI port (default: 3458)
 *   --list          List detected controllers and exit
 */

import { createReadStream, type ReadStream } from "node:fs";
import { readFileSync, openSync, closeSync } from "node:fs";
import { hostname } from "node:os";

// ═══════════════════════════════════════════════════════════════════════════
// EVDEV CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const EVENT_SIZE = 24; // aarch64: timeval(16) + type(2) + code(2) + value(4)

const EV_SYN = 0x00, EV_KEY = 0x01, EV_ABS = 0x03;

const BTN_SOUTH = 0x130, BTN_EAST = 0x131, BTN_C = 0x132, BTN_NORTH = 0x133, BTN_WEST = 0x134;
const BTN_TL = 0x136, BTN_TR = 0x137, BTN_TL2 = 0x138, BTN_TR2 = 0x139;
const BTN_SELECT = 0x13a, BTN_START = 0x13b, BTN_MODE = 0x13c;
const BTN_THUMBL = 0x13d, BTN_THUMBR = 0x13e;
const BTN_DPAD_UP = 0x220, BTN_DPAD_DOWN = 0x221, BTN_DPAD_LEFT = 0x222, BTN_DPAD_RIGHT = 0x223;

const ABS_X = 0x00, ABS_Y = 0x01, ABS_Z = 0x02;
const ABS_RX = 0x03, ABS_RY = 0x04, ABS_RZ = 0x05;
const ABS_GAS = 0x09, ABS_BRAKE = 0x0a;
const ABS_HAT0X = 0x10, ABS_HAT0Y = 0x11;

// ═══════════════════════════════════════════════════════════════════════════
// ORBIS (PS4) BUTTON BITMASK
// ═══════════════════════════════════════════════════════════════════════════

const ORBIS = {
  SHARE: 0x0001, L3: 0x0002, R3: 0x0004, OPTIONS: 0x0008,
  UP: 0x0010, RIGHT: 0x0020, DOWN: 0x0040, LEFT: 0x0080,
  L2: 0x0100, R2: 0x0200, L1: 0x0400, R1: 0x0800,
  TRIANGLE: 0x1000, CIRCLE: 0x2000, CROSS: 0x4000, SQUARE: 0x8000,
  TOUCHPAD: 0x100000,
} as const;

const BUTTON_MAP: Record<number, number> = {
  [BTN_SOUTH]: ORBIS.CROSS, [BTN_EAST]: ORBIS.CIRCLE,
  [BTN_WEST]: ORBIS.TRIANGLE, [BTN_NORTH]: ORBIS.SQUARE,
  [BTN_TL]: ORBIS.L1, [BTN_TR]: ORBIS.R1,
  [BTN_TL2]: ORBIS.L2, [BTN_TR2]: ORBIS.R2,
  [BTN_SELECT]: ORBIS.SHARE, [BTN_START]: ORBIS.OPTIONS,
  [BTN_MODE]: ORBIS.TOUCHPAD,
  [BTN_THUMBL]: ORBIS.L3, [BTN_THUMBR]: ORBIS.R3,
  [BTN_DPAD_UP]: ORBIS.UP, [BTN_DPAD_DOWN]: ORBIS.DOWN,
  [BTN_DPAD_LEFT]: ORBIS.LEFT, [BTN_DPAD_RIGHT]: ORBIS.RIGHT,
};

const BUTTON_NAMES: Record<number, string> = {
  [ORBIS.CROSS]: "✕", [ORBIS.CIRCLE]: "○", [ORBIS.SQUARE]: "□", [ORBIS.TRIANGLE]: "△",
  [ORBIS.L1]: "L1", [ORBIS.R1]: "R1", [ORBIS.L2]: "L2", [ORBIS.R2]: "R2",
  [ORBIS.L3]: "L3", [ORBIS.R3]: "R3",
  [ORBIS.UP]: "↑", [ORBIS.DOWN]: "↓", [ORBIS.LEFT]: "←", [ORBIS.RIGHT]: "→",
  [ORBIS.OPTIONS]: "OPT", [ORBIS.SHARE]: "SHR", [ORBIS.TOUCHPAD]: "TP",
};

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface DetectedDevice {
  name: string;
  eventPath: string;
  vendor: string;
  product: string;
  uniq: string;
  bus: string;
  absCaps: bigint; // ABS capability bitmask from /proc/bus/input/devices
}

interface AxisRange { min: number; max: number; }

interface PadState {
  buttons: number;
  lx: number; ly: number;
  rx: number; ry: number;
  l2: number; r2: number;
}

interface PadSlot {
  device: DetectedDevice | null;
  state: PadState;
  stream: ReadStream | null;
  axisRanges: Map<number, AxisRange>;
  active: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

const state = {
  ps4Host: "z-ps4",
  ps4Port: 4263,
  ps4Connected: false,
  ps4Version: "",
  controllers: [] as DetectedDevice[],
  pads: [
    { device: null, state: freshPadState(), stream: null, axisRanges: new Map(), active: false },
    { device: null, state: freshPadState(), stream: null, axisRanges: new Map(), active: false },
    { device: null, state: freshPadState(), stream: null, axisRanges: new Map(), active: false },
    { device: null, state: freshPadState(), stream: null, axisRanges: new Map(), active: false },
  ] as PadSlot[],
  msgCount: 0,
};

let ps4Connection: ReturnType<typeof createPS4Connection> | null = null;
const uiClients = new Set<{ ws: any; send: (data: string) => void }>();

function freshPadState(): PadState {
  return { buttons: 0, lx: 128, ly: 128, rx: 128, ry: 128, l2: 0, r2: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTROLLER DETECTION
// ═══════════════════════════════════════════════════════════════════════════

function detectControllers(): DetectedDevice[] {
  const devices: DetectedDevice[] = [];
  try {
    const raw = readFileSync("/proc/bus/input/devices", "utf-8");
    const blocks = raw.split("\n\n").filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n");
      const get = (p: string) => lines.find((l) => l.startsWith(p))?.slice(p.length).trim() || "";
      const name = get("N: Name=").replace(/^"|"$/g, "");
      const handlers = get("H: Handlers=");
      const uniq = get("U: Uniq=");
      if (!handlers.match(/\bjs\d+\b/) || !handlers.match(/\bevent(\d+)\b/)) continue;
      const eventN = handlers.match(/\bevent(\d+)\b/)![1];
      const iLine = get("I: ");
      // Parse ABS capability bitmask (e.g. "B: ABS=30627")
      const absLine = lines.find((l) => l.startsWith("B: ABS="));
      const absHex = absLine?.split("=")[1]?.trim() || "0";
      const absCaps = BigInt("0x" + absHex);
      devices.push({
        name,
        eventPath: `/dev/input/event${eventN}`,
        vendor: iLine.match(/Vendor=(\w+)/)?.[1] || "0000",
        product: iLine.match(/Product=(\w+)/)?.[1] || "0000",
        uniq,
        bus: iLine.match(/Bus=(\w+)/)?.[1] || "0000",
        absCaps,
      });
    }
  } catch (e: any) {
    console.error("Failed to scan input devices:", e.message);
  }
  return devices;
}

function getControllerLabel(dev: DetectedDevice): string {
  const v = dev.vendor.toLowerCase();
  const n = dev.name.toLowerCase();
  if (v === "054c") return "PlayStation";
  if (v === "045e") return "Xbox";
  if (v === "2dc8") return "8BitDo";
  if (n.includes("gamesir")) return "GameSir";
  if (n.includes("xbox")) return "Xbox";
  if (n.includes("wireless controller") || n.includes("playstation")) return "PlayStation";
  if (n.includes("pro controller")) return "Switch Pro";
  return "Gamepad";
}

function getConnectionType(dev: DetectedDevice): string {
  if (dev.bus === "0005") return "bluetooth";
  if (dev.bus === "0003") return "usb";
  return "other";
}

function getControllerIcon(dev: DetectedDevice): string {
  const label = getControllerLabel(dev);
  if (label === "PlayStation") return "🎮";
  if (label === "Xbox") return "🟢";
  if (label === "GameSir") return "🕹️";
  if (label === "8BitDo") return "🔴";
  if (label === "Switch Pro") return "🔵";
  return "🎮";
}

// ═══════════════════════════════════════════════════════════════════════════
// AXIS RANGES
// ═══════════════════════════════════════════════════════════════════════════

function EVIOCGABS(axis: number): number {
  return ((2 << 30) | (24 << 16) | (0x45 << 8) | (0x40 + axis)) >>> 0;
}

// Axis layout: some controllers use ABS_RX/RY for right stick + ABS_Z/RZ for triggers (Xbox/DS4),
// others use ABS_Z/RZ for right stick + ABS_GAS/BRAKE for triggers (GameSir BLE HID, generic HID)
type AxisLayout = "standard" | "gas_brake";

function detectAxisLayout(dev: DetectedDevice): AxisLayout {
  const hasRX = (dev.absCaps & (1n << BigInt(ABS_RX))) !== 0n;
  const hasGas = (dev.absCaps & (1n << BigInt(ABS_GAS))) !== 0n;
  if (!hasRX && hasGas) return "gas_brake";
  return "standard";
}

function detectAxisRanges(devicePath: string): Map<number, AxisRange> {
  const ranges = new Map<number, AxisRange>();
  const axes = [ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ, ABS_GAS, ABS_BRAKE, ABS_HAT0X, ABS_HAT0Y];
  let fd: number;
  try { fd = openSync(devicePath, "r"); } catch { return ranges; }
  try {
    const buf = new Int32Array(6);
    const { dlopen, FFIType, ptr } = require("bun:ffi");
    const libc = dlopen("libc.so.6", {
      ioctl: { args: [FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    });
    for (const axis of axes) {
      buf.fill(0);
      if (libc.symbols.ioctl(fd, EVIOCGABS(axis), ptr(buf)) >= 0) {
        ranges.set(axis, { min: buf[1], max: buf[2] });
      }
    }
  } catch {}
  closeSync(fd);
  return ranges;
}

function getFallbackRanges(vendor: string): Map<number, AxisRange> {
  const ranges = new Map<number, AxisRange>();
  const isSony = vendor.toLowerCase() === "054c";
  for (const a of [ABS_X, ABS_Y, ABS_RX, ABS_RY])
    ranges.set(a, isSony ? { min: 0, max: 255 } : { min: -32768, max: 32767 });
  for (const a of [ABS_Z, ABS_RZ])
    ranges.set(a, isSony ? { min: 0, max: 255 } : { min: 0, max: 1023 });
  ranges.set(ABS_HAT0X, { min: -1, max: 1 });
  ranges.set(ABS_HAT0Y, { min: -1, max: 1 });
  return ranges;
}

function normalize(value: number, range: AxisRange): number {
  if (range.max === range.min) return 128;
  return Math.max(0, Math.min(255, Math.round(((value - range.min) / (range.max - range.min)) * 255)));
}

// ═══════════════════════════════════════════════════════════════════════════
// EVDEV READER
// ═══════════════════════════════════════════════════════════════════════════

function startEvdevReader(padIndex: number): void {
  const slot = state.pads[padIndex];
  if (!slot.device || slot.stream) return;

  const devicePath = slot.device.eventPath;
  let ranges = detectAxisRanges(devicePath);
  if (ranges.size === 0) ranges = getFallbackRanges(slot.device.vendor);
  slot.axisRanges = ranges;
  slot.state = freshPadState();
  slot.active = true;

  // Detect axis layout: standard (RX/RY=right stick, Z/RZ=triggers) or gas_brake (Z/RZ=right stick, GAS/BRAKE=triggers)
  const layout = detectAxisLayout(slot.device);
  console.log(`    Axis layout: ${layout}${layout === "gas_brake" ? " (Z/RZ=right stick, GAS/BRAKE=triggers)" : ""}`);

  let dpadX = 0, dpadY = 0;

  const stream = createReadStream(devicePath, { highWaterMark: EVENT_SIZE * 64 });
  slot.stream = stream;

  stream.on("data", (buf: Buffer) => {
    const s = slot.state;
    for (let i = 0; i + EVENT_SIZE <= buf.length; i += EVENT_SIZE) {
      const type = buf.readUInt16LE(i + 16);
      const code = buf.readUInt16LE(i + 18);
      const value = buf.readInt32LE(i + 20);

      if (type === EV_KEY) {
        const btn = BUTTON_MAP[code];
        if (btn !== undefined) {
          if (value) s.buttons |= btn; else s.buttons &= ~btn;
        }
      } else if (type === EV_ABS) {
        const r = ranges.get(code);
        switch (code) {
          case ABS_X: s.lx = r ? normalize(value, r) : value; break;
          case ABS_Y: s.ly = r ? normalize(value, r) : value; break;
          case ABS_RX:
            // Standard layout: RX = right stick X
            s.rx = r ? normalize(value, r) : value; break;
          case ABS_RY:
            // Standard layout: RY = right stick Y
            s.ry = r ? normalize(value, r) : value; break;
          case ABS_Z:
            if (layout === "gas_brake") {
              // Gas/brake layout: Z = right stick X
              s.rx = r ? normalize(value, r) : value;
            } else {
              // Standard layout: Z = L2 trigger
              s.l2 = r ? normalize(value, r) : value;
              if (s.l2 > 10) s.buttons |= ORBIS.L2; else s.buttons &= ~ORBIS.L2;
            }
            break;
          case ABS_RZ:
            if (layout === "gas_brake") {
              // Gas/brake layout: RZ = right stick Y
              s.ry = r ? normalize(value, r) : value;
            } else {
              // Standard layout: RZ = R2 trigger
              s.r2 = r ? normalize(value, r) : value;
              if (s.r2 > 10) s.buttons |= ORBIS.R2; else s.buttons &= ~ORBIS.R2;
            }
            break;
          case ABS_BRAKE:
            // Gas/brake layout: BRAKE = L2 trigger
            s.l2 = r ? normalize(value, r) : value;
            if (s.l2 > 10) s.buttons |= ORBIS.L2; else s.buttons &= ~ORBIS.L2;
            break;
          case ABS_GAS:
            // Gas/brake layout: GAS = R2 trigger
            s.r2 = r ? normalize(value, r) : value;
            if (s.r2 > 10) s.buttons |= ORBIS.R2; else s.buttons &= ~ORBIS.R2;
            break;
          case ABS_HAT0X:
            dpadX = value;
            s.buttons &= ~(ORBIS.LEFT | ORBIS.RIGHT);
            if (dpadX < 0) s.buttons |= ORBIS.LEFT;
            else if (dpadX > 0) s.buttons |= ORBIS.RIGHT;
            break;
          case ABS_HAT0Y:
            dpadY = value;
            s.buttons &= ~(ORBIS.UP | ORBIS.DOWN);
            if (dpadY < 0) s.buttons |= ORBIS.UP;
            else if (dpadY > 0) s.buttons |= ORBIS.DOWN;
            break;
        }
      } else if (type === EV_SYN) {
        // Send to PS4
        ps4Connection?.send(s, padIndex);
        state.msgCount++;
      }
    }
  });

  stream.on("error", () => stopEvdevReader(padIndex));
  stream.on("close", () => { slot.stream = null; slot.active = false; });

  console.log(`  ▶ Pad ${padIndex}: reading ${devicePath}`);
}

function stopEvdevReader(padIndex: number): void {
  const slot = state.pads[padIndex];
  if (slot.stream) {
    slot.stream.destroy();
    slot.stream = null;
  }
  slot.active = false;
  slot.state = freshPadState();
  console.log(`  ■ Pad ${padIndex}: stopped`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PS4 WEBSOCKET CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

function createPS4Connection(host: string, port: number) {
  const url = `ws://${host}:${port}`;
  let ws: WebSocket | null = null;
  let open = false;
  let rpcId = 0;
  const pending = new Map<number, (data: any) => void>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionallyClosed = false;

  function connect() {
    try {
      ws = new WebSocket(url);
    } catch (e: any) {
      console.error(`  ✗ WebSocket error: ${e.message}`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      open = true;
      state.ps4Connected = true;
      console.log(`  ✓ Connected to PS4 at ${url}`);
      broadcastUI({ type: "ps4Status", connected: true, host, port });
      // Query version
      getInfo().then((info) => {
        state.ps4Version = info?.version || "";
        if (state.ps4Version) {
          console.log(`    RemotePad v${state.ps4Version}`);
          broadcastUI({ type: "ps4Version", version: state.ps4Version });
        }
      });
    });

    ws.addEventListener("close", () => {
      open = false;
      state.ps4Connected = false;
      broadcastUI({ type: "ps4Status", connected: false });
      if (!intentionallyClosed) {
        console.log("  ✗ PS4 disconnected, reconnecting in 3s...");
        scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {});

    ws.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.id !== undefined && pending.has(frame.id)) {
          pending.get(frame.id)!(frame.result);
          pending.delete(frame.id);
        }
      } catch {}
    });
  }

  function scheduleReconnect() {
    if (intentionallyClosed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!intentionallyClosed) connect();
    }, 3000);
  }

  async function getInfo(): Promise<{ version: string } | null> {
    if (!open || !ws) return null;
    const id = rpcId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(id); resolve(null); }, 2000);
      pending.set(id, (result) => { clearTimeout(t); resolve(result); });
      ws!.send(JSON.stringify({ id, method: "info", params: [] }));
    });
  }

  connect();

  return {
    send(s: PadState, padIndex: number) {
      if (!open || !ws) return;
      ws.send(JSON.stringify({
        method: "u",
        params: [padIndex, s.buttons, s.lx, s.ly, s.rx, s.ry, s.l2, s.r2, 0],
      }));
    },
    close() {
      intentionallyClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      open = false;
      state.ps4Connected = false;
      state.ps4Version = "";
    },
    isOpen: () => open,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// UI BROADCAST
// ═══════════════════════════════════════════════════════════════════════════

/** Get battery info for a controller (BT only) */
function getBatteryInfo(dev: DetectedDevice): { level: number; status: string } | null {
  if (dev.bus !== "0005" || !dev.uniq) return null;

  // Try /sys/class/power_supply/ (DS4, some HID devices)
  try {
    const psDir = "/sys/class/power_supply/";
    const entries = readFileSync("/proc/mounts", "utf-8"); // just check if dir exists
    const { readdirSync } = require("node:fs");
    for (const name of readdirSync(psDir)) {
      try {
        const uevent = readFileSync(`${psDir}${name}/uevent`, "utf-8");
        // Match by MAC or device name
        const uniqNorm = dev.uniq.replace(/:/g, "").toLowerCase();
        if (uevent.toLowerCase().includes(uniqNorm) || name.toLowerCase().includes(uniqNorm)) {
          const cap = readFileSync(`${psDir}${name}/capacity`, "utf-8").trim();
          const status = readFileSync(`${psDir}${name}/status`, "utf-8").trim();
          return { level: parseInt(cap) || -1, status };
        }
      } catch {}
    }
  } catch {}

  // Try D-Bus Battery1 interface
  try {
    const mac = dev.uniq.replace(/:/g, "_").toUpperCase();
    const { execSync } = require("node:child_process");
    const pct = execSync(
      `busctl get-property org.bluez /org/bluez/hci0/dev_${mac} org.bluez.Battery1 Percentage 2>/dev/null`,
      { encoding: "utf-8", timeout: 1000 }
    ).trim();
    const match = pct.match(/(\d+)$/);
    if (match) return { level: parseInt(match[1]), status: "Unknown" };
  } catch {}

  return null;
}

/** Get device input type label */
function getInputType(dev: DetectedDevice): string {
  if (dev.bus === "0005") return "Bluetooth";
  // Check if USB device is a wireless dongle (2.4GHz receiver)
  const n = dev.name.toLowerCase();
  if (n.includes("2.4g") || n.includes("dongle") || n.includes("receiver")) return "2.4G Dongle";
  if (dev.bus === "0003") return "USB";
  return "Other";
}

/** Strip BigInt fields for JSON serialization */
function serializeDev(c: DetectedDevice) {
  const { absCaps, ...rest } = c;
  const battery = getBatteryInfo(c);
  return {
    ...rest,
    label: getControllerLabel(c),
    connectionType: getConnectionType(c),
    inputType: getInputType(c),
    icon: getControllerIcon(c),
    battery,
  };
}

function broadcastUI(msg: any) {
  const data = JSON.stringify(msg);
  for (const client of uiClients) {
    try { client.send(data); } catch { uiClients.delete(client); }
  }
}

function getFullState() {
  return {
    type: "fullState",
    ps4: {
      host: state.ps4Host,
      port: state.ps4Port,
      connected: state.ps4Connected,
      version: state.ps4Version,
    },
    controllers: state.controllers.map(serializeDev),
    pads: state.pads.map((p, i) => ({
      index: i,
      device: p.device ? serializeDev(p.device) : null,
      active: p.active,
      state: p.state,
    })),
    msgCount: state.msgCount,
  };
}

// Periodic state broadcast (pad states for live visualization)
setInterval(() => {
  const padStates = state.pads.map((p, i) => ({
    index: i,
    active: p.active,
    state: p.active ? p.state : null,
  }));
  broadcastUI({ type: "padStates", pads: padStates, msgCount: state.msgCount });
}, 100);

// Periodic controller scan
setInterval(() => {
  const prev = state.controllers;
  state.controllers = detectControllers();

  // Check if controller list changed
  const prevPaths = new Set(prev.map((c) => c.eventPath));
  const currPaths = new Set(state.controllers.map((c) => c.eventPath));
  const changed = prev.length !== state.controllers.length ||
    [...prevPaths].some((p) => !currPaths.has(p)) ||
    [...currPaths].some((p) => !prevPaths.has(p));

  if (changed) {
    console.log(`  🔍 Controllers: ${state.controllers.length} detected`);
    broadcastUI({
      type: "controllers",
      controllers: state.controllers.map(serializeDev),
    });

    // Stop readers for disconnected controllers
    for (let i = 0; i < 4; i++) {
      const slot = state.pads[i];
      if (slot.device && !currPaths.has(slot.device.eventPath)) {
        console.log(`  ⚠ Pad ${i} controller disconnected`);
        stopEvdevReader(i);
        slot.device = null;
        broadcastUI({ type: "padAssignment", pad: i, device: null });
      }
    }
  }
}, 2000);

// ═══════════════════════════════════════════════════════════════════════════
// HTTP SERVER + WEB UI
// ═══════════════════════════════════════════════════════════════════════════

function serveUI(): string {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>RemotePad Bridge</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎮</text></svg>">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; padding: 16px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: rgba(255,255,255,0.4); font-size: 12px; margin-bottom: 20px; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }

  /* PS4 Connection */
  .ps4-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .ps4-bar input {
    flex: 1; min-width: 140px; height: 40px; padding: 0 12px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px; color: #fff; font-size: 14px; outline: none;
  }
  .ps4-bar input:focus { border-color: rgba(0,123,255,0.5); }
  .ps4-bar input::placeholder { color: rgba(255,255,255,0.25); }
  .port-row { display: flex; gap: 8px; }
  .ps4-bar button {
    height: 40px; padding: 0 20px; border: none; border-radius: 8px;
    font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;
    transition: all 0.2s;
  }
  .btn-connect { background: #007bff; color: #fff; }
  .btn-connect:hover { background: #0069d9; }
  .btn-connect:disabled { opacity: 0.4; cursor: default; }
  .btn-disconnect { background: #dc3545; color: #fff; }
  .btn-disconnect:hover { background: #c82333; }
  .ps4-status {
    display: flex; align-items: center; gap: 6px; font-size: 13px;
    color: rgba(255,255,255,0.5); margin-top: 8px;
  }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-dot.on { background: #28a745; box-shadow: 0 0 6px rgba(40,167,69,0.5); }
  .status-dot.off { background: #555; }

  /* Controllers list */
  .controller-card {
    display: flex; align-items: center; gap: 12px; padding: 12px 14px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px; margin-bottom: 8px; transition: all 0.2s;
  }
  .controller-card:hover { border-color: rgba(255,255,255,0.15); }
  .controller-icon { font-size: 24px; flex-shrink: 0; }
  .controller-info { flex: 1; min-width: 0; }
  .controller-name { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .controller-meta { font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 2px; }
  .conn-badge {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
    padding: 2px 6px; border-radius: 4px;
  }
  .conn-bt { background: rgba(0,114,255,0.15); color: #4da3ff; }
  .conn-usb { background: rgba(40,167,69,0.15); color: #5cb85c; }
  .conn-dongle { background: rgba(255,165,0,0.15); color: #ffa500; }
  .battery-badge {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
    background: rgba(255,255,255,0.06);
  }
  .battery-badge.charging { color: #ffd54f; }
  .battery-badge.low { color: #e87c86; }
  .battery-badge.ok { color: #72c585; }
  .assign-select {
    height: 32px; padding: 0 8px; background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;
    color: #fff; font-size: 12px; cursor: pointer; outline: none;
  }

  /* Mobile: PS4 bar stacks */
  @media (max-width: 480px) {
    .ps4-bar { flex-direction: column; }
    .ps4-bar input { width: 100%; flex: none; }
    .ps4-bar .port-row { display: flex; gap: 8px; width: 100%; }
    .ps4-bar .port-row input { flex: 1; }
    .ps4-bar .port-row button { flex: 1; }
    .controller-card { gap: 8px; padding: 10px 12px; }
    .controller-icon { font-size: 20px; }
    .controller-name { font-size: 13px; }
    .controller-meta { font-size: 10px; }
    .assign-select { height: 28px; font-size: 11px; padding: 0 6px; }
    .pad-slot { padding: 12px; }
    .pad-label { font-size: 13px; }
    .pad-device { font-size: 11px; }
    h1 { font-size: 18px; }
    .section-title { font-size: 12px; }
    body { padding: 12px; }
  }

  /* Pad slots */
  .pads-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 600px) { .pads-grid { grid-template-columns: 1fr; } }
  .pad-slot {
    padding: 14px; border-radius: 12px;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
    transition: all 0.3s;
  }
  .pad-slot.active { border-color: rgba(0,123,255,0.4); background: rgba(0,123,255,0.05); }
  .pad-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .pad-label { font-size: 14px; font-weight: 600; }
  .pad-label .player-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 6px; font-size: 12px;
    margin-right: 6px;
  }
  .p0 .player-num { background: rgba(0,123,255,0.2); color: #4da3ff; }
  .p1 .player-num { background: rgba(220,53,69,0.2); color: #e87c86; }
  .p2 .player-num { background: rgba(40,167,69,0.2); color: #72c585; }
  .p3 .player-num { background: rgba(255,193,7,0.2); color: #ffd54f; }
  .pad-device { font-size: 12px; color: rgba(255,255,255,0.4); }
  .pad-empty { text-align: center; padding: 20px 0; color: rgba(255,255,255,0.15); font-size: 13px; }
  .pad-unassign {
    background: none; border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.4);
    padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;
  }
  .pad-unassign:hover { border-color: #dc3545; color: #dc3545; }

  /* Pad state visualization */
  .pad-viz { display: flex; gap: 12px; align-items: center; justify-content: center; margin-top: 8px; }
  .stick-viz {
    width: 48px; height: 48px; border-radius: 50%; position: relative;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  }
  .stick-dot {
    width: 12px; height: 12px; border-radius: 50%; background: #4da3ff;
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    transition: top 0.05s, left 0.05s;
  }
  .trigger-bar-wrap { display: flex; flex-direction: column; gap: 4px; align-items: center; }
  .trigger-bar {
    width: 8px; height: 32px; border-radius: 4px; position: relative;
    background: rgba(255,255,255,0.06); overflow: hidden;
  }
  .trigger-fill {
    position: absolute; bottom: 0; left: 0; right: 0;
    background: #ffc107; border-radius: 4px; transition: height 0.05s;
  }
  .trigger-label { font-size: 9px; color: rgba(255,255,255,0.3); }
  .buttons-viz { font-size: 12px; color: rgba(255,255,255,0.6); min-width: 60px; text-align: center; word-break: break-all; line-height: 1.6; }

  /* Footer */
  .footer { text-align: center; color: rgba(255,255,255,0.15); font-size: 11px; margin-top: 20px; }
  .msg-count { font-variant-numeric: tabular-nums; }

  .empty-state { text-align: center; padding: 30px 16px; color: rgba(255,255,255,0.2); font-size: 14px; }
  .empty-state .icon { font-size: 32px; margin-bottom: 8px; }
</style>
</head>
<body>

<h1>🎮 RemotePad Bridge</h1>
<p class="subtitle">Forward local controllers → PS4</p>

<div class="section">
  <div class="section-title">PS4 Connection</div>
  <div class="ps4-bar">
    <input type="text" id="ps4Host" placeholder="PS4 IP or hostname" value="z-ps4" />
    <div class="port-row">
      <input type="number" id="ps4Port" value="4263" style="width:80px;flex:none" />
      <button class="btn-connect" id="btnConnect" onclick="doConnect()">Connect</button>
    </div>
  </div>
  <div class="ps4-status" id="ps4Status">
    <span class="status-dot off" id="statusDot"></span>
    <span id="statusText">Not connected</span>
  </div>
</div>

<div class="section">
  <div class="section-title">PS4 Controller Slots</div>
  <div class="pads-grid" id="padsGrid"></div>
</div>

<div class="section">
  <div class="section-title">Detected Controllers</div>
  <div id="controllersList"></div>
</div>

<div class="footer">
  Messages sent: <span class="msg-count" id="msgCount">0</span>
</div>

<script>
const PLAYER_COLORS = ['#4da3ff', '#e87c86', '#72c585', '#ffd54f'];
let ws;
let currentState = { ps4: {}, controllers: [], pads: [{},{},{},{}], msgCount: 0 };

function initWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'fullState') {
      currentState = msg;
      renderAll();
    } else if (msg.type === 'controllers') {
      currentState.controllers = msg.controllers;
      renderControllers();
    } else if (msg.type === 'padStates') {
      for (const p of msg.pads) {
        currentState.pads[p.index] = { ...currentState.pads[p.index], active: p.active, state: p.state };
      }
      currentState.msgCount = msg.msgCount;
      renderPadViz();
      document.getElementById('msgCount').textContent = msg.msgCount.toLocaleString();
    } else if (msg.type === 'ps4Status') {
      currentState.ps4.connected = msg.connected;
      if (msg.host) currentState.ps4.host = msg.host;
      renderPS4Status();
    } else if (msg.type === 'ps4Version') {
      currentState.ps4.version = msg.version;
      renderPS4Status();
    } else if (msg.type === 'padAssignment') {
      currentState.pads[msg.pad] = { ...currentState.pads[msg.pad], device: msg.device, active: !!msg.device };
      renderPads();
      renderControllers();
    }
  };
  ws.onclose = () => setTimeout(initWS, 2000);
}

function renderAll() {
  renderPS4Status();
  renderPads();
  renderControllers();
  // Restore saved host
  const hostInput = document.getElementById('ps4Host');
  if (currentState.ps4.host && !hostInput.value) hostInput.value = currentState.ps4.host;
}

function renderPS4Status() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const btn = document.getElementById('btnConnect');
  if (currentState.ps4.connected) {
    dot.className = 'status-dot on';
    const ver = currentState.ps4.version ? ' v' + currentState.ps4.version : '';
    text.textContent = 'Connected to ' + currentState.ps4.host + ':' + currentState.ps4.port + ver;
    btn.textContent = 'Disconnect';
    btn.className = 'btn-disconnect';
    btn.onclick = doDisconnect;
  } else {
    dot.className = 'status-dot off';
    text.textContent = 'Not connected';
    btn.textContent = 'Connect';
    btn.className = 'btn-connect';
    btn.onclick = doConnect;
  }
}

function renderPads() {
  const grid = document.getElementById('padsGrid');
  grid.innerHTML = currentState.pads.map((p, i) => {
    const hasDevice = !!p.device;
    return '<div class="pad-slot p' + i + (hasDevice && p.active ? ' active' : '') + '" id="pad' + i + '">' +
      '<div class="pad-header">' +
        '<span class="pad-label"><span class="player-num">P' + (i+1) + '</span>' +
          (hasDevice ? p.device.icon + ' ' + p.device.label : 'Empty') +
        '</span>' +
        (hasDevice ? '<button class="pad-unassign" onclick="doUnassign(' + i + ')">✕</button>' : '') +
      '</div>' +
      (hasDevice
        ? '<div class="pad-device">' + p.device.name + ' · ' +
            (p.device.inputType || (p.device.connectionType === 'bluetooth' ? 'BT' : 'USB')) +
            (p.device.battery ? ' · ' + (p.device.battery.status === 'Charging' ? '⚡' : '🔋') + p.device.battery.level + '%' : '') +
          '</div>' +
          '<div class="pad-viz" id="padViz' + i + '"></div>'
        : '<div class="pad-empty">Assign a controller below</div>'
      ) +
    '</div>';
  }).join('');
  renderPadViz();
}

function renderPadViz() {
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById('padViz' + i);
    if (!el) continue;
    const p = currentState.pads[i];
    if (!p.state || !p.active) { el.innerHTML = ''; continue; }
    const s = p.state;
    const lxPct = (s.lx / 255 * 100).toFixed(0);
    const lyPct = (s.ly / 255 * 100).toFixed(0);
    const rxPct = (s.rx / 255 * 100).toFixed(0);
    const ryPct = (s.ry / 255 * 100).toFixed(0);
    const l2Pct = (s.l2 / 255 * 100).toFixed(0);
    const r2Pct = (s.r2 / 255 * 100).toFixed(0);
    // Pressed buttons
    const pressed = [];
    const names = {16384:'✕',8192:'○',32768:'□',4096:'△',1024:'L1',2048:'R1',2:'L3',4:'R3',16:'↑',32:'→',64:'↓',128:'←',8:'OPT',1:'SHR'};
    for (const [bit, name] of Object.entries(names)) {
      if (s.buttons & Number(bit)) pressed.push(name);
    }
    el.innerHTML =
      '<div class="stick-viz"><div class="stick-dot" style="left:' + lxPct + '%;top:' + lyPct + '%"></div></div>' +
      '<div class="trigger-bar-wrap"><div class="trigger-bar"><div class="trigger-fill" style="height:' + l2Pct + '%"></div></div><span class="trigger-label">L2</span></div>' +
      '<div class="buttons-viz">' + (pressed.length ? pressed.join(' ') : '·') + '</div>' +
      '<div class="trigger-bar-wrap"><div class="trigger-bar"><div class="trigger-fill" style="height:' + r2Pct + '%"></div></div><span class="trigger-label">R2</span></div>' +
      '<div class="stick-viz"><div class="stick-dot" style="left:' + rxPct + '%;top:' + ryPct + '%"></div></div>';
  }
}

function renderControllers() {
  const el = document.getElementById('controllersList');
  if (!currentState.controllers.length) {
    el.innerHTML = '<div class="empty-state"><div class="icon">🔍</div>No controllers detected<br><small>Connect a controller via Bluetooth or USB</small></div>';
    return;
  }
  // Find which controllers are already assigned
  const assigned = new Set();
  for (const p of currentState.pads) {
    if (p.device) assigned.add(p.device.eventPath);
  }

  el.innerHTML = currentState.controllers.map(c => {
    const isAssigned = assigned.has(c.eventPath);
    const connClass = c.inputType === 'Bluetooth' ? 'conn-bt' : c.inputType === '2.4G Dongle' ? 'conn-dongle' : 'conn-usb';
    const connIcon = c.inputType === 'Bluetooth' ? '📶' : c.inputType === '2.4G Dongle' ? '📡' : '🔌';
    // Battery display
    let batteryHtml = '';
    if (c.battery) {
      const lvl = c.battery.level;
      const isCharging = c.battery.status === 'Charging';
      const cls = isCharging ? 'charging' : lvl <= 20 ? 'low' : 'ok';
      const icon = isCharging ? '⚡' : lvl <= 20 ? '🪫' : '🔋';
      batteryHtml = ' <span class="battery-badge ' + cls + '">' + icon + ' ' + lvl + '%</span>';
    }
    // Build assign dropdown — only show unassigned pads
    let assignHtml = '';
    if (isAssigned) {
      const padIdx = currentState.pads.findIndex(p => p.device?.eventPath === c.eventPath);
      assignHtml = '<span style="font-size:12px;color:' + PLAYER_COLORS[padIdx] + ';font-weight:600">P' + (padIdx+1) + '</span>';
    } else {
      const opts = ['<option value="">Assign…</option>'];
      for (let i = 0; i < 4; i++) {
        if (!currentState.pads[i].device) opts.push('<option value="' + i + '">Player ' + (i+1) + '</option>');
      }
      assignHtml = '<select class="assign-select" onchange="doAssign(\\'' + c.eventPath.replace(/'/g, "\\\\'") + '\\', this.value)">' + opts.join('') + '</select>';
    }
    return '<div class="controller-card">' +
      '<span class="controller-icon">' + c.icon + '</span>' +
      '<div class="controller-info">' +
        '<div class="controller-name">' + c.name + '</div>' +
        '<div class="controller-meta">' +
          '<span class="conn-badge ' + connClass + '">' + connIcon + ' ' + c.inputType + '</span>' +
          batteryHtml +
          (c.uniq ? ' · ' + c.uniq : '') +
        '</div>' +
      '</div>' +
      assignHtml +
    '</div>';
  }).join('');
}

function doConnect() {
  const host = document.getElementById('ps4Host').value.trim();
  const port = parseInt(document.getElementById('ps4Port').value) || 4263;
  if (!host) { document.getElementById('ps4Host').focus(); return; }
  localStorage.setItem('rp_host', host);
  localStorage.setItem('rp_port', String(port));
  fetch('/api/connect', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ host, port }) });
}

function doDisconnect() {
  fetch('/api/disconnect', { method: 'POST' });
}

function doAssign(eventPath, padIndex) {
  if (padIndex === '') return;
  fetch('/api/assign', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ eventPath, padIndex: parseInt(padIndex) }) });
}

function doUnassign(padIndex) {
  fetch('/api/unassign', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ padIndex }) });
}

// Init
const savedHost = localStorage.getItem('rp_host');
const savedPort = localStorage.getItem('rp_port');
document.getElementById('ps4Host').value = savedHost || 'z-ps4';
if (savedPort) document.getElementById('ps4Port').value = savedPort;
initWS();
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

function printBanner(uiPort: number) {
  const host = hostname();
  console.log(`
  🎮  RemotePad Bridge
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  UI: http://${host}:${uiPort}
  `);
}

async function main() {
  const args = process.argv.slice(2);
  let uiPort = 3458;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ui-port" && args[i + 1]) uiPort = parseInt(args[++i]);
    if (args[i] === "--list") {
      const c = detectControllers();
      if (!c.length) console.log("No controllers detected.");
      else c.forEach((d, i) => console.log(`[${i}] ${d.name} (${getControllerLabel(d)}) ${d.uniq || "wired"} [${d.bus === "0005" ? "BT" : "USB"}] ${d.eventPath}`));
      process.exit(0);
    }
    if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: sudo bun run bridge.ts [--ui-port <n>] [--list]");
      process.exit(0);
    }
  }

  printBanner(uiPort);

  // Initial controller scan
  state.controllers = detectControllers();
  console.log(`  Found ${state.controllers.length} controller(s)`);

  const server = Bun.serve({
    port: uiPort,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API endpoints
      if (url.pathname === "/api/connect" && req.method === "POST") {
        return req.json().then((body: any) => {
          const { host, port: p } = body;
          if (!host) return new Response(JSON.stringify({ ok: false, error: "Missing host" }), { status: 400, headers: { "Content-Type": "application/json" } });
          // Close existing
          if (ps4Connection) ps4Connection.close();
          state.ps4Host = host;
          state.ps4Port = p || 4263;
          ps4Connection = createPS4Connection(state.ps4Host, state.ps4Port);
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        });
      }

      if (url.pathname === "/api/disconnect" && req.method === "POST") {
        if (ps4Connection) {
          ps4Connection.close();
          ps4Connection = null;
        }
        state.ps4Connected = false;
        state.ps4Host = "";
        state.ps4Version = "";
        broadcastUI({ type: "ps4Status", connected: false });
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }

      if (url.pathname === "/api/assign" && req.method === "POST") {
        return req.json().then((body: any) => {
          const { eventPath, padIndex } = body;
          if (padIndex < 0 || padIndex > 3) return new Response(JSON.stringify({ ok: false, error: "Invalid pad" }), { status: 400, headers: { "Content-Type": "application/json" } });
          const dev = state.controllers.find((c) => c.eventPath === eventPath);
          if (!dev) return new Response(JSON.stringify({ ok: false, error: "Controller not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

          // Unassign from previous pad if any
          for (let i = 0; i < 4; i++) {
            if (state.pads[i].device?.eventPath === eventPath) {
              stopEvdevReader(i);
              state.pads[i].device = null;
              broadcastUI({ type: "padAssignment", pad: i, device: null });
            }
          }

          // Unassign current pad occupant
          if (state.pads[padIndex].device) {
            stopEvdevReader(padIndex);
          }

          // Assign
          state.pads[padIndex].device = dev;
          startEvdevReader(padIndex);

          const deviceInfo = serializeDev(dev);
          broadcastUI({ type: "padAssignment", pad: padIndex, device: deviceInfo });

          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        });
      }

      if (url.pathname === "/api/unassign" && req.method === "POST") {
        return req.json().then((body: any) => {
          const { padIndex } = body;
          if (padIndex < 0 || padIndex > 3) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { "Content-Type": "application/json" } });
          stopEvdevReader(padIndex);
          state.pads[padIndex].device = null;
          broadcastUI({ type: "padAssignment", pad: padIndex, device: null });
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        });
      }

      if (url.pathname === "/api/status") {
        return new Response(JSON.stringify(getFullState()), { headers: { "Content-Type": "application/json" } });
      }

      // Serve UI
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(serveUI(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const client = { ws, send: (d: string) => ws.send(d) };
        uiClients.add(client);
        (ws as any).__client = client;
        // Send full state on connect
        ws.send(JSON.stringify(getFullState()));
      },
      message(ws, msg) {
        // No incoming messages expected from UI via WS
      },
      close(ws) {
        const client = (ws as any).__client;
        if (client) uiClients.delete(client);
      },
    },
  });

  console.log(`  Server listening on :${uiPort}`);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  Shutting down...");
    for (let i = 0; i < 4; i++) stopEvdevReader(i);
    ps4Connection?.close();
    server.stop();
    process.exit(0);
  });
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
