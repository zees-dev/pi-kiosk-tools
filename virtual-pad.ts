#!/usr/bin/env bun
/**
 * Virtual Gamepad — Multi-player web controllers → uinput on Pi
 *
 * /             → Controller UI (phone)  ?player=N to claim slot
 * /view         → Kiosk display showing all controllers + live state
 * /ws?player=N  → Binary WebSocket (controller)
 * /ws/view      → JSON WebSocket (kiosk view)
 * /health       → Health check
 *
 * Port: 3461
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, readFileSync, openSync, closeSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { networkInterfaces } from "node:os";

const PORT = 3461;
const BASE_DIR = dirname(import.meta.path);
const UINPUT_BIN = join(BASE_DIR, "uinput-gamepad");
const MAX_PLAYERS = 4;

// ── Event constants ─────────────────────────────────────────────────────
const EV_SYN = 0, EV_KEY = 1, EV_ABS = 3;
const SYN_REPORT = 0;
const BTN_SOUTH = 0x130, BTN_EAST = 0x131, BTN_NORTH = 0x133, BTN_WEST = 0x134;
const BTN_TL = 0x136, BTN_TR = 0x137, BTN_TL2 = 0x138, BTN_TR2 = 0x139;
const BTN_SELECT = 0x13a, BTN_START = 0x13b, BTN_MODE = 0x13c;
const BTN_THUMBL = 0x13d, BTN_THUMBR = 0x13e;
const ABS_X = 0, ABS_Y = 1, ABS_Z = 2, ABS_RX = 3, ABS_RY = 4, ABS_RZ = 5;
const ABS_HAT0X = 0x10, ABS_HAT0Y = 0x11;
const EVENT_SIZE = 24; // aarch64: timeval(16) + type(2) + code(2) + value(4)

// ── Vendor config (single source of truth) ──────────────────────────────
// Controllers are identified by USB vendor ID. Add new vendors here.
// swapFace: Nintendo layout has A/B and X/Y in opposite positions to Xbox
interface VendorConfig { swapFace: boolean }
const VENDORS: Record<number, VendorConfig> = {
  0x054c: { swapFace: false }, // Sony (PlayStation)
  0x057e: { swapFace: true },  // Nintendo
};
function getVendorConfig(vid: number): VendorConfig {
  return VENDORS[vid] || { swapFace: false };
}

const BUTTON_MAP: [number, number][] = [
  [0, BTN_SOUTH], [1, BTN_EAST], [2, BTN_WEST], [3, BTN_NORTH],
  [4, BTN_TL], [5, BTN_TR], [6, BTN_TL2], [7, BTN_TR2],
  [8, BTN_SELECT], [9, BTN_START], [10, BTN_THUMBL], [11, BTN_THUMBR],
  [16, BTN_MODE],
];

// ── Player Slots (web controllers) ─────────────────────────────────────
interface PlayerSlot {
  ws: any | null;
  proc: Subprocess | null;
  prevButtons: number;
  prevAxes: Uint8Array;
  lastState: Uint8Array | null;
  label: string;
  vendorId: number;
}

const slots: PlayerSlot[] = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  const axes = new Uint8Array(6);
  axes[0] = axes[1] = axes[2] = axes[3] = 128;
  slots.push({ ws: null, proc: null, prevButtons: 0, prevAxes: axes, lastState: null, label: "", vendorId: 0 });
}

const viewClients = new Set<any>();

function startSlot(idx: number): boolean {
  const slot = slots[idx];
  if (slot.proc) return true;
  if (!existsSync(UINPUT_BIN)) { console.error("uinput-gamepad binary not found"); return false; }
  try {
    slot.proc = spawn([UINPUT_BIN, String(idx + 1)], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
    slot.prevButtons = 0;
    slot.prevAxes = new Uint8Array(6);
    slot.prevAxes[0] = slot.prevAxes[1] = slot.prevAxes[2] = slot.prevAxes[3] = 128;
    console.log(`  ✓ Slot ${idx + 1}: uinput started (pid ${slot.proc.pid})`);
    return true;
  } catch (e: any) {
    console.error(`  ✗ Slot ${idx + 1}: failed to start uinput:`, e.message);
    slot.proc = null;
    return false;
  }
}

function stopSlot(idx: number) {
  const slot = slots[idx];
  if (!slot.proc) return;
  try { slot.proc.kill("SIGTERM"); } catch {}
  slot.proc = null;
  slot.lastState = null;
  console.log(`  ■ Slot ${idx + 1}: uinput stopped`);
}

function writeEvent(slot: PlayerSlot, type: number, code: number, value: number) {
  if (!slot.proc?.stdin) return;
  const buf = Buffer.alloc(EVENT_SIZE);
  buf.writeUInt16LE(type, 16);
  buf.writeUInt16LE(code, 18);
  buf.writeInt32LE(value, 20);
  try { slot.proc.stdin.write(buf); } catch {}
}

function processInput(idx: number, data: ArrayBuffer) {
  const slot = slots[idx];
  if (!slot.proc || data.byteLength < 10) return;

  const view = new DataView(data);
  const buttons = view.getUint32(0, true);
  const axes = [view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7), view.getUint8(8), view.getUint8(9)];
  // Vendor ID at bytes 10-11 (optional, 12-byte protocol)
  if (data.byteLength >= 12) {
    const vid = view.getUint16(10, true);
    slot.vendorId = vid;
  }
  let changed = false;

  if (buttons !== slot.prevButtons) {
    for (const [bit, btn] of BUTTON_MAP) {
      const now = (buttons >> bit) & 1;
      const was = (slot.prevButtons >> bit) & 1;
      if (now !== was) { writeEvent(slot, EV_KEY, btn, now); changed = true; }
    }
    const hatX = ((buttons >> 15) & 1) - ((buttons >> 14) & 1);
    const prevHatX = ((slot.prevButtons >> 15) & 1) - ((slot.prevButtons >> 14) & 1);
    const hatY = ((buttons >> 13) & 1) - ((buttons >> 12) & 1);
    const prevHatY = ((slot.prevButtons >> 13) & 1) - ((slot.prevButtons >> 12) & 1);
    if (hatX !== prevHatX) { writeEvent(slot, EV_ABS, ABS_HAT0X, hatX); changed = true; }
    if (hatY !== prevHatY) { writeEvent(slot, EV_ABS, ABS_HAT0Y, hatY); changed = true; }
    slot.prevButtons = buttons;
  }

  const absCodes = [ABS_X, ABS_Y, ABS_RX, ABS_RY, ABS_Z, ABS_RZ];
  for (let i = 0; i < 6; i++) {
    if (axes[i] !== slot.prevAxes[i]) {
      writeEvent(slot, EV_ABS, absCodes[i], axes[i]);
      slot.prevAxes[i] = axes[i];
      changed = true;
    }
  }

  if (changed) writeEvent(slot, EV_SYN, SYN_REPORT, 0);
  slot.lastState = new Uint8Array(data.slice(0));
  broadcastPlayerState(idx);
}

function findFreeSlot(): number {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (!slots[i].ws) return i;
  }
  return -1;
}

// ── Hardware controller evdev reading ───────────────────────────────────
interface HwController {
  name: string;
  type: string; // bluetooth | usb
  eventPath: string;
  eventNum: number;
  vendorId: number;
  // Axis calibration
  absInfo: Map<number, { min: number; max: number }>;
  // Live state — same 10-byte protocol as web controllers
  state: Uint8Array;
  stream: ReturnType<typeof createReadStream> | null;
  // Raw button/axis state for evdev→protocol translation
  rawButtons: Set<number>;
  rawAxes: Map<number, number>;
}

const hwControllers = new Map<string, HwController>(); // key = eventPath

function readAbsInfo(eventNum: number, absCode: number): { min: number; max: number } | null {
  try {
    const raw = readFileSync(`/sys/class/input/event${eventNum}/device/absinfo/${absCode}`, "utf-8");
    // Format: "Value Min Max Fuzz Flat Resolution" — one per line or space-separated
    // Actually it's like: Value: 0\nMin: -32768\nMax: 32767\n...
    // Or on some kernels just numbers
    const min = parseInt(raw.match(/Min:\s*(-?\d+)/)?.[1] ?? raw.split("\n")[1]?.trim() ?? "0");
    const max = parseInt(raw.match(/Max:\s*(-?\d+)/)?.[1] ?? raw.split("\n")[2]?.trim() ?? "255");
    return { min, max };
  } catch {
    return null;
  }
}

// EVIOCGABS(abs) ioctl: _IOR('E', 0x40 + abs, struct input_absinfo)
// input_absinfo = { value, minimum, maximum, fuzz, flat, resolution } = 6 x int32 = 24 bytes
// _IOR(type, nr, size) on aarch64 = ((2 << 30) | (size << 16) | (type << 8) | nr)
function eviocgabs(abs: number): number {
  return ((2 << 30) | (24 << 16) | (0x45 << 8) | (0x40 + abs)) >>> 0;
}

let libc: any = null;
let _ptr: any = null;
try {
  const ffi = await import("bun:ffi");
  _ptr = ffi.ptr;
  libc = ffi.dlopen("libc.so.6", {
    ioctl: { args: [ffi.FFIType.i32, ffi.FFIType.u32, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
  });
} catch (e) {
  console.error("  ⚠ Could not load libc for ioctl — axis ranges will use defaults");
}

function readAbsInfoIoctl(fd: number, absCode: number): { min: number; max: number } | null {
  if (!libc || !_ptr) return null;
  const buf = new Int32Array(6);
  const ret = libc.symbols.ioctl(fd, eviocgabs(absCode), _ptr(buf));
  if (ret !== 0) return null;
  return { min: buf[1], max: buf[2] };
}

function readAbsInfoFromDevice(eventPath: string, eventNum: number): Map<number, { min: number; max: number }> {
  const info = new Map<number, { min: number; max: number }>();
  // Read abs capabilities bitmap from sysfs
  try {
    const capHex = readFileSync(`/sys/class/input/event${eventNum}/device/capabilities/abs`, "utf-8").trim();
    const words = capHex.split(/\s+/);
    // Try to open the device for ioctl
    let fd = -1;
    try { fd = openSync(eventPath, "r"); } catch {}

    for (let wi = 0; wi < words.length; wi++) {
      const val = BigInt("0x" + words[words.length - 1 - wi]);
      for (let bit = 0; bit < 64; bit++) {
        if (val & (1n << BigInt(bit))) {
          const absCode = wi * 64 + bit;
          if (absCode > ABS_HAT0Y) continue; // only care about sticks, triggers, hats

          // Try ioctl first for accurate ranges
          let range: { min: number; max: number } | null = null;
          if (fd >= 0) range = readAbsInfoIoctl(fd, absCode);

          if (!range) {
            // Fallback defaults
            if (absCode === ABS_HAT0X || absCode === ABS_HAT0Y) {
              range = { min: -1, max: 1 };
            } else {
              range = { min: -32768, max: 32767 };
            }
          }
          info.set(absCode, range);
        }
      }
    }
    if (fd >= 0) closeSync(fd);
  } catch {}
  return info;
}

// Map raw evdev axis value to 0-255 range
function normalizeAxis(value: number, min: number, max: number): number {
  if (max === min) return 128;
  return Math.round(((value - min) / (max - min)) * 255);
}

// Convert HwController raw state to protocol 10-byte format
function hwStateToProtocol(hw: HwController): void {
  const buf = hw.state;
  const dv = new DataView(buf.buffer, buf.byteOffset);

  // Buttons → bitmask (bit0=A, bit1=B, bit2=X, bit3=Y)
  // Kernel evdev codes are POSITIONAL: SOUTH=bottom, EAST=right, NORTH=top, WEST=left
  //
  // Nintendo physical layout: A=right(EAST), B=bottom(SOUTH), X=top(NORTH), Y=left(WEST)
  //   → EAST→A(0), SOUTH→B(1), NORTH→X(2), WEST→Y(3)
  //
  // Xbox/GameSir X-input: A=bottom(SOUTH), B=right(EAST), X=top(NORTH), Y=left(WEST)
  //   → SOUTH→A(0), EAST→B(1), NORTH→X(2), WEST→Y(3)
  let buttons = 0;
  const vcfg = getVendorConfig(hw.vendorId);
  const btnMap: [number, number][] = vcfg.swapFace ? [
    [BTN_EAST, 0], [BTN_SOUTH, 1], [BTN_NORTH, 2], [BTN_WEST, 3],
    [BTN_TL, 4], [BTN_TR, 5], [BTN_TL2, 6], [BTN_TR2, 7],
    [BTN_SELECT, 8], [BTN_START, 9], [BTN_THUMBL, 10], [BTN_THUMBR, 11],
    [BTN_MODE, 16],
  ] : [
    [BTN_SOUTH, 0], [BTN_EAST, 1], [BTN_NORTH, 2], [BTN_WEST, 3],
    [BTN_TL, 4], [BTN_TR, 5], [BTN_TL2, 6], [BTN_TR2, 7],
    [BTN_SELECT, 8], [BTN_START, 9], [BTN_THUMBL, 10], [BTN_THUMBR, 11],
    [BTN_MODE, 16],
  ];
  for (const [code, bit] of btnMap) {
    if (hw.rawButtons.has(code)) buttons |= (1 << bit);
  }

  // D-pad from HAT axes
  const hatX = hw.rawAxes.get(ABS_HAT0X) ?? 0;
  const hatY = hw.rawAxes.get(ABS_HAT0Y) ?? 0;
  if (hatY < 0) buttons |= (1 << 12); // up
  if (hatY > 0) buttons |= (1 << 13); // down
  if (hatX < 0) buttons |= (1 << 14); // left
  if (hatX > 0) buttons |= (1 << 15); // right

  dv.setUint32(0, buttons, true);

  // Axes
  const axisMap: [number, number][] = [
    [ABS_X, 4], [ABS_Y, 5],
    [ABS_RX, 6], [ABS_RY, 7],
    [ABS_Z, 8], [ABS_RZ, 9],
  ];
  for (const [code, offset] of axisMap) {
    const raw = hw.rawAxes.get(code);
    if (raw !== undefined) {
      const info = hw.absInfo.get(code);
      if (info) {
        buf[offset] = normalizeAxis(raw, info.min, info.max);
      }
    }
  }

  // Digital trigger fallback: if no analog ABS_Z/RZ axes, fill l2/r2 from BTN_TL2/TR2
  if (!hw.absInfo.has(ABS_Z) && hw.rawButtons.has(BTN_TL2)) buf[8] = 255;
  if (!hw.absInfo.has(ABS_Z) && !hw.rawButtons.has(BTN_TL2)) buf[8] = 0;
  if (!hw.absInfo.has(ABS_RZ) && hw.rawButtons.has(BTN_TR2)) buf[9] = 255;
  if (!hw.absInfo.has(ABS_RZ) && !hw.rawButtons.has(BTN_TR2)) buf[9] = 0;
}

function startHwMonitor(hw: HwController) {
  if (hw.stream) return;
  let fd: number;
  try {
    fd = openSync(hw.eventPath, "r");
  } catch (e: any) {
    console.error(`  ✗ Can't open ${hw.eventPath}:`, e.message);
    return;
  }

  const stream = createReadStream("", { fd, highWaterMark: EVENT_SIZE * 64 });
  hw.stream = stream;
  let remainder = Buffer.alloc(0);

  stream.on("data", (chunk: Buffer) => {
    let data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    let offset = 0;
    let changed = false;

    while (offset + EVENT_SIZE <= data.length) {
      const type = data.readUInt16LE(offset + 16);
      const code = data.readUInt16LE(offset + 18);
      const value = data.readInt32LE(offset + 20);
      offset += EVENT_SIZE;

      if (type === EV_KEY) {
        if (value) hw.rawButtons.add(code);
        else hw.rawButtons.delete(code);
        changed = true;
      } else if (type === EV_ABS) {
        hw.rawAxes.set(code, value);
        changed = true;
      } else if (type === EV_SYN && changed) {
        hwStateToProtocol(hw);
        broadcastHwState(hw.eventPath);
        changed = false;
      }
    }
    remainder = data.subarray(offset);
  });

  stream.on("error", () => {
    stopHwMonitor(hw.eventPath);
  });
  stream.on("close", () => {
    stopHwMonitor(hw.eventPath);
  });

  console.log(`  📡 Monitoring ${hw.name} (${hw.eventPath})`);
}

function stopHwMonitor(eventPath: string) {
  const hw = hwControllers.get(eventPath);
  if (!hw) return;
  if (hw.stream) { try { hw.stream.destroy(); } catch {} hw.stream = null; }
  hwControllers.delete(eventPath);
  console.log(`  ✗ Stopped monitoring ${hw.name}`);
  broadcastFull();
}

// ── Hardware controller scanning ────────────────────────────────────────
function scanAndUpdateHw() {
  const found = new Map<string, { name: string; type: string; eventNum: number }>();

  try {
    const raw = readFileSync("/proc/bus/input/devices", "utf-8");
    for (const block of raw.split("\n\n")) {
      if (!block.trim()) continue;
      const lines = block.split("\n");
      const get = (p: string) => lines.find(l => l.startsWith(p))?.slice(p.length).trim() || "";
      const name = get("N: Name=").replace(/^"|"$/g, "");
      if (name.startsWith("Virtual Gamepad")) continue;
      const handlers = get("H: Handlers=");
      const busStr = get("I: ").match(/Bus=(\w+)/)?.[1] || "";

      // Detect gamepads
      const hasJs = /\bjs\d+\b/.test(handlers);
      const keyBits = get("B: KEY=");
      let hasGamepadBtn = false;
      if (keyBits) {
        const words = keyBits.split(/\s+/);
        const wordIdx = words.length - 1 - Math.floor(304 / 64);
        if (wordIdx >= 0 && wordIdx < words.length) {
          const val = BigInt("0x" + words[wordIdx]);
          if (val & (1n << 48n)) hasGamepadBtn = true;
        }
      }
      const absBits = get("B: ABS=");
      const hasAbs = absBits && absBits !== "0";
      if (!hasJs && !hasGamepadBtn) continue;
      if (!hasAbs && !hasJs) continue;

      const type = busStr === "0005" ? "bluetooth" : busStr === "0003" ? "usb" : busStr === "0006" ? "virtual" : "other";
      if (type === "virtual") continue;

      const eventMatch = handlers.match(/event(\d+)/);
      if (!eventMatch) continue;
      const eventNum = parseInt(eventMatch[1]);
      const eventPath = `/dev/input/event${eventNum}`;
      // Detect controller brand by vendor
      const vendorStr = (get("I: ").match(/Vendor=(\w+)/)?.[1] || "").toLowerCase();
      const vendorId = parseInt(vendorStr, 16) || 0;
      found.set(eventPath, { name, type, eventNum, vendorId });
    }
  } catch {}

  // Add new controllers
  for (const [path, info] of found) {
    if (!hwControllers.has(path)) {
      const absInfo = readAbsInfoFromDevice(path, info.eventNum);
      const state = new Uint8Array(10);
      state[4] = state[5] = state[6] = state[7] = 128; // center sticks
      const hw: HwController = {
        name: info.name, type: info.type, eventPath: path, eventNum: info.eventNum,
        vendorId: info.vendorId, absInfo, state, stream: null,
        rawButtons: new Set(), rawAxes: new Map(),
      };
      hwControllers.set(path, hw);
      startHwMonitor(hw);
      broadcastFull();
    }
  }

  // Remove disconnected
  for (const path of hwControllers.keys()) {
    if (!found.has(path)) {
      stopHwMonitor(path);
    }
  }
}

// Scan every 2s for connects/disconnects
setInterval(scanAndUpdateHw, 2000);
scanAndUpdateHw();

// ── View broadcast ──────────────────────────────────────────────────────
function broadcastPlayerState(idx: number) {
  if (viewClients.size === 0) return;
  const s = slots[idx];
  const msg = JSON.stringify({
    type: "player",
    slot: idx + 1,
    connected: !!s.ws,
    label: s.label,
    vendor: s.vendorId,
    state: s.lastState ? Array.from(s.lastState) : null,
  });
  for (const c of viewClients) { try { c.send(msg); } catch {} }
}

function broadcastHwState(eventPath: string) {
  if (viewClients.size === 0) return;
  const hw = hwControllers.get(eventPath);
  if (!hw) return;
  const msg = JSON.stringify({
    type: "hw",
    eventPath,
    name: hw.name,
    connType: hw.type,
    vendor: hw.vendorId,
    state: Array.from(hw.state),
  });
  for (const c of viewClients) { try { c.send(msg); } catch {} }
}

function broadcastConnect(idx: number) {
  if (viewClients.size === 0) return;
  const s = slots[idx];
  const msg = JSON.stringify({ type: "connect", slot: idx + 1, label: s.label });
  for (const c of viewClients) { try { c.send(msg); } catch {} }
}

function broadcastDisconnect(idx: number) {
  if (viewClients.size === 0) return;
  const msg = JSON.stringify({ type: "disconnect", slot: idx + 1 });
  for (const c of viewClients) { try { c.send(msg); } catch {} }
}

function broadcastFull() {
  if (viewClients.size === 0) return;
  const msg = getFullState();
  for (const c of viewClients) { try { c.send(msg); } catch {} }
}

function getFullState(): string {
  const players = slots.map((s, i) => ({
    slot: i + 1, connected: !!s.ws, label: s.label,
    vendor: s.vendorId,
    state: s.lastState ? Array.from(s.lastState) : null,
  })).filter(p => p.connected);
  const hw = Array.from(hwControllers.values()).map(h => ({
    eventPath: h.eventPath, name: h.name, connType: h.type,
    vendor: h.vendorId, state: Array.from(h.state),
  }));
  return JSON.stringify({ type: "full", players, hw });
}

// ── IP ──────────────────────────────────────────────────────────────────
function getIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

// ── Controller HTML ─────────────────────────────────────────────────────
const CONTROLLER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Virtual Gamepad</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0a0a; color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; touch-action: none; user-select: none; }
  .container { display: flex; flex-direction: column; height: 100%; }

  /* Status — top right */
  .status { position: fixed; top: 6px; right: 10px; display: flex; align-items: center; gap: 6px; z-index: 10; }
  .player-badge { background: #222; border: 1px solid #444; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; }
  .p1 { color: #4a9eff; border-color: #4a9eff44; }
  .p2 { color: #f44336; border-color: #f4433644; }
  .p3 { color: #4CAF50; border-color: #4CAF5044; }
  .p4 { color: #FFC107; border-color: #FFC10744; }
  .conn-dot { width: 7px; height: 7px; border-radius: 50%; }
  .conn-dot.connected { background: #4CAF50; }
  .conn-dot.connecting { background: #FFC107; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Gamepad layout */
  .gamepad { flex: 1; display: flex; position: relative; }
  .left { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .right { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 80px; }
  .center-row { display: flex; gap: 6px; }

  /* D-pad */
  .dpad { position: relative; width: 120px; height: 120px; }
  .dpad-btn { position: absolute; background: #1a1a1a; border: 1px solid #333; display: flex; align-items: center; justify-content: center; font-size: 18px; color: #888; transition: background 0.05s; }
  .dpad-btn.pressed { background: #333; color: #fff; }
  .dpad-up { top: 0; left: 36px; width: 48px; height: 48px; border-radius: 8px 8px 0 0; }
  .dpad-down { bottom: 0; left: 36px; width: 48px; height: 48px; border-radius: 0 0 8px 8px; }
  .dpad-left { top: 36px; left: 0; width: 48px; height: 48px; border-radius: 8px 0 0 8px; }
  .dpad-right { top: 36px; right: 0; width: 48px; height: 48px; border-radius: 0 8px 8px 0; }
  .dpad-center { top: 36px; left: 36px; width: 48px; height: 48px; background: #151515; border: none; }

  /* Sticks */
  .stick-zone { width: 120px; height: 120px; background: #141414; border: 2px solid #282828; border-radius: 50%; position: relative; }
  .stick-thumb { width: 50px; height: 50px; background: #333; border: 2px solid #444; border-radius: 50%; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); transition: background 0.05s; }
  .stick-thumb.active { background: #4a9eff; border-color: #5ab0ff; }
  .stick-label { font-size: 10px; color: #444; text-align: center; }

  /* Face buttons */
  .face-buttons { position: relative; width: 130px; height: 130px; }
  .face-btn { position: absolute; width: 46px; height: 46px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; border: 2px solid; transition: background 0.05s; }
  .face-btn.pressed { filter: brightness(1.5); }
  .face-a { bottom: 0; left: 42px; background: #1a3a1a; border-color: #4CAF50; color: #4CAF50; }
  .face-b { top: 42px; right: 0; background: #3a1a1a; border-color: #f44336; color: #f44336; }
  .face-x { top: 42px; left: 0; background: #1a1a3a; border-color: #2196F3; color: #2196F3; }
  .face-y { top: 0; left: 42px; background: #3a3a1a; border-color: #FFC107; color: #FFC107; }

  /* Shoulders */
  .shoulders { display: flex; justify-content: space-between; padding: 0 8px; flex-shrink: 0; }
  .shoulder-group { display: flex; gap: 4px; }
  .shoulder-btn { padding: 10px 18px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; font-size: 12px; font-weight: 600; color: #888; transition: background 0.05s; }
  .shoulder-btn.pressed { background: #333; color: #fff; }
  .trigger-btn { padding: 10px 18px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; font-size: 12px; font-weight: 600; color: #888; position: relative; overflow: hidden; }
  .trigger-btn .fill { position: absolute; bottom: 0; left: 0; right: 0; background: #4a9eff33; transition: height 0.05s; }
  .trigger-btn.pressed { background: #222; color: #fff; }

  /* Small center buttons */
  .sm-btn { width: 32px; height: 24px; background: #1a1a1a; border: 1px solid #333; border-radius: 12px; font-size: 9px; font-weight: 600; color: #666; display: flex; align-items: center; justify-content: center; }
  .sm-btn.pressed { background: #333; color: #fff; }
  .home-btn { width: 28px; height: 28px; border-radius: 50%; font-size: 12px; }

  @media (orientation: portrait) {
    .gamepad { flex-direction: column; }
    .left, .right { flex-direction: row; }
  }
</style>
</head>
<body>
<div class="container">
  <!-- Status: top-right player badge + connection dot -->
  <div class="status">
    <span class="player-badge" id="playerBadge">P?</span>
    <span class="conn-dot connecting" id="connDot"></span>

  </div>

  <div class="shoulders">
    <div class="shoulder-group">
      <div class="trigger-btn" data-btn="6"><div class="fill" id="fillL2"></div>L2</div>
      <div class="shoulder-btn" data-btn="4">L1</div>
    </div>
    <div class="shoulder-group">
      <div class="shoulder-btn" data-btn="5">R1</div>
      <div class="trigger-btn" data-btn="7"><div class="fill" id="fillR2"></div>R2</div>
    </div>
  </div>
  <div class="gamepad">
    <div class="left">
      <div class="dpad">
        <div class="dpad-btn dpad-up" data-btn="12">▲</div>
        <div class="dpad-btn dpad-left" data-btn="14">◀</div>
        <div class="dpad-center"></div>
        <div class="dpad-btn dpad-right" data-btn="15">▶</div>
        <div class="dpad-btn dpad-down" data-btn="13">▼</div>
      </div>
      <div>
        <div class="stick-zone" id="stickL"><div class="stick-thumb" id="thumbL"></div></div>
        <div class="stick-label">L3</div>
      </div>
    </div>
    <div class="center">
      <div class="center-row">
        <div class="sm-btn" data-btn="8">SEL</div>
        <div class="sm-btn home-btn" data-btn="16">⊙</div>
        <div class="sm-btn" data-btn="9">STR</div>
      </div>
      <div class="center-row">
        <div class="sm-btn" data-btn="10">L3</div>
        <div class="sm-btn" data-btn="11">R3</div>
      </div>
    </div>
    <div class="right">
      <div class="face-buttons">
        <div class="face-btn face-y" data-btn="3">Y</div>
        <div class="face-btn face-x" data-btn="2">X</div>
        <div class="face-btn face-b" data-btn="1">B</div>
        <div class="face-btn face-a" data-btn="0">A</div>
      </div>
      <div>
        <div class="stick-zone" id="stickR"><div class="stick-thumb" id="thumbR"></div></div>
        <div class="stick-label">R3</div>
      </div>
    </div>
  </div>
</div>

<script>
// ═══════════════════════════════════════════════════════════════
// NETWORK LAYER — binary WebSocket, player assignment, reconnect
// ═══════════════════════════════════════════════════════════════
const net = (() => {
  const buf = new ArrayBuffer(12), dv = new DataView(buf);
  const params = new URLSearchParams(location.search);
  const wantP = parseInt(params.get('player') || params.get('p') || '0');
  let ws = null, player = null;
  const cbs = { assign: [], kick: [], state: [] };

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws' + (wantP ? '?player=' + wantP : ''));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => cbs.state.forEach(f => f('connected'));
    ws.onclose = () => { cbs.state.forEach(f => f('connecting')); player = null; setTimeout(connect, 1000); };
    ws.onerror = () => ws.close();
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.type === 'assigned') { player = m.player; cbs.assign.forEach(f => f(player)); }
        else if (m.type === 'kicked') { player = null; cbs.kick.forEach(f => f()); ws.close(); }
      }
    };
  }
  connect();

  return {
    send(buttons, lx, ly, rx, ry, l2, r2, vendor) {
      if (!ws || ws.readyState !== 1) return;
      dv.setUint32(0, buttons, true);
      dv.setUint8(4, lx); dv.setUint8(5, ly); dv.setUint8(6, rx); dv.setUint8(7, ry);
      dv.setUint8(8, l2); dv.setUint8(9, r2);
      dv.setUint16(10, vendor, true);
      ws.send(buf);
    },
    onAssign(fn) { cbs.assign.push(fn); },
    onKick(fn) { cbs.kick.push(fn); },
    onState(fn) { cbs.state.push(fn); },
    get player() { return player; },
  };
})();

// ═══════════════════════════════════════════════════════════════
// INPUT STATE — shared mutable state, either touch or gamepad
// ═══════════════════════════════════════════════════════════════
let buttons = 0, lx = 128, ly = 128, rx = 128, ry = 128, l2 = 0, r2 = 0;
let touchBtns = 0; // bits currently held by touch UI
let gpVendor = 0;  // raw USB vendor ID from Gamepad API (e.g. 0x054c)


function flush() { net.send(buttons, lx, ly, rx, ry, l2, r2, gpVendor); }

// ═══════════════════════════════════════════════════════════════
// STATUS UI — top-right badge + dot
// ═══════════════════════════════════════════════════════════════
const badge = document.getElementById('playerBadge');
const dot = document.getElementById('connDot');
net.onAssign(p => { badge.textContent = 'P' + p; badge.className = 'player-badge p' + p; });
net.onState(s => {
  dot.className = 'conn-dot ' + s;
});

// ═══════════════════════════════════════════════════════════════
// TOUCH UI — buttons, sticks, triggers
// ═══════════════════════════════════════════════════════════════
function setBtn(bit, on) {
  // Track touch-owned bits separately so gamepad can clear its own
  if (on) { buttons |= (1 << bit); touchBtns |= (1 << bit); }
  else { buttons &= ~(1 << bit); touchBtns &= ~(1 << bit); }
  document.querySelector('[data-btn="'+bit+'"]')?.classList.toggle('pressed', on);
  if (bit === 6) { l2 = on ? 255 : 0; document.getElementById('fillL2').style.height = (on ? '100' : '0') + '%'; }
  if (bit === 7) { r2 = on ? 255 : 0; document.getElementById('fillR2').style.height = (on ? '100' : '0') + '%'; }
  flush();
}

document.querySelectorAll('[data-btn]').forEach(el => {
  const b = parseInt(el.dataset.btn);
  el.addEventListener('touchstart', e => { e.preventDefault(); setBtn(b, true); }, { passive: false });
  el.addEventListener('touchend', e => { e.preventDefault(); setBtn(b, false); }, { passive: false });
  el.addEventListener('touchcancel', e => { e.preventDefault(); setBtn(b, false); }, { passive: false });
  el.addEventListener('mousedown', e => { e.preventDefault(); setBtn(b, true); });
  el.addEventListener('mouseup', e => { e.preventDefault(); setBtn(b, false); });
  el.addEventListener('mouseleave', e => { if (e.buttons) setBtn(b, false); });
});

function setupStick(zoneId, thumbId, isRight, clickBit) {
  const zone = document.getElementById(zoneId), thumb = document.getElementById(thumbId), maxD = 35;
  let active = false, tid = null;
  function upd(cx2, cy2) {
    const r = zone.getBoundingClientRect(), cx = r.left + r.width/2, cy = r.top + r.height/2;
    let dx = cx2-cx, dy = cy2-cy, d = Math.sqrt(dx*dx+dy*dy);
    if (d > maxD) { dx = dx/d*maxD; dy = dy/d*maxD; }
    thumb.style.transform = 'translate(calc(-50% + '+dx+'px),calc(-50% + '+dy+'px))';
    const nx = Math.round(128+(dx/maxD)*127), ny = Math.round(128+(dy/maxD)*127);
    if (isRight) { rx=nx; ry=ny; } else { lx=nx; ly=ny; }
    flush();
  }
  function rst() {
    thumb.style.transform = 'translate(-50%,-50%)'; thumb.classList.remove('active');
    if (isRight) { rx=128; ry=128; } else { lx=128; ly=128; }
    active=false; tid=null; flush();
  }
  zone.addEventListener('touchstart', e => { e.preventDefault(); const t=e.changedTouches[0]; tid=t.identifier; active=true; thumb.classList.add('active'); upd(t.clientX,t.clientY); }, {passive:false});
  zone.addEventListener('touchmove', e => { e.preventDefault(); for(const t of e.changedTouches) if(t.identifier===tid){upd(t.clientX,t.clientY);break;} }, {passive:false});
  zone.addEventListener('touchend', e => { e.preventDefault(); for(const t of e.changedTouches) if(t.identifier===tid){rst();break;} }, {passive:false});
  zone.addEventListener('touchcancel', e => { e.preventDefault(); rst(); }, {passive:false});
  let lt=0; zone.addEventListener('touchstart', ()=>{ const n=Date.now(); if(n-lt<300){setBtn(clickBit,true);setTimeout(()=>setBtn(clickBit,false),100);} lt=n; });
  zone.addEventListener('mousedown', e => { active=true; thumb.classList.add('active'); upd(e.clientX,e.clientY); });
  window.addEventListener('mousemove', e => { if(active) upd(e.clientX,e.clientY); });
  window.addEventListener('mouseup', () => { if(active) rst(); });
}
setupStick('stickL','thumbL',false,10);
setupStick('stickR','thumbR',true,11);

// ═══════════════════════════════════════════════════════════════
// GAMEPAD API — forward physical controller connected to phone
// Gamepad fully owns state when active (replaces, not ORs)
// Touch inputs merge on top via setBtn which sets individual bits
// ═══════════════════════════════════════════════════════════════
let gpPrevB = 0, gpPrevA = [128,128,128,128,0,0];

// ── Vendor config (single source of truth) ──
// Add new controller brands here — everything else derives from this
const VENDOR_CFG = {
  0x054c: { type: 'playstation', face: { 0: '✕', 1: '○', 2: '□', 3: '△' }, swapFace: false },
  0x057e: { type: 'nintendo',    face: { 0: 'A', 1: 'B', 2: 'X', 3: 'Y' }, swapFace: true },
};
const XBOX_FACE = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y' };

function getVendorId(gp) {
  const id = gp.id || '';
  const m = id.match(/Vendor:\\s*([0-9a-fA-F]{4})/i);
  if (m) return parseInt(m[1], 16);
  // Fallback: match only unambiguous names (BT gamepads may omit vendor string)
  const lo = id.toLowerCase();
  if (lo.includes('dualshock') || lo.includes('dualsense')) return 0x054c;
  if (lo.includes('pro controller') || lo.includes('joy-con')) return 0x057e;
  return 0;
}

// URL override: ?labels=xbox|ps|nintendo
const qp = new URLSearchParams(location.search);
const labelsOverride = qp.get('labels') || qp.get('l') || '';
const OVERRIDE_VENDORS = { ps: 0x054c, playstation: 0x054c, nintendo: 0x057e, xbox: 0 };
let currentVendor = -1; // force first apply

// Apply face labels from vendor config
function applyFaceLabels(vendor) {
  if (OVERRIDE_VENDORS[labelsOverride] !== undefined) vendor = OVERRIDE_VENDORS[labelsOverride];
  if (vendor === currentVendor) return;
  currentVendor = vendor;
  const cfg = VENDOR_CFG[vendor];
  const face = cfg ? cfg.face : XBOX_FACE;
  for (const [bit, label] of Object.entries(face)) {
    const el = document.querySelector('[data-btn="' + bit + '"]');
    if (el) el.textContent = label;
  }
}
// Apply immediately (defaults to xbox unless overridden)
applyFaceLabels(0);

function pollGamepad() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (const g of gps) { if (g && g.connected) { gp = g; break; } }
  if (gp) {
    let gb = 0;
    for (let i = 0; i < Math.min(gp.buttons.length, 17); i++) if (gp.buttons[i].pressed) gb |= (1 << i);
    // Extract raw vendor ID, update labels
    gpVendor = getVendorId(gp);
    applyFaceLabels(gpVendor);

    // Swap face buttons if vendor config says so (Nintendo layout)
    if (VENDOR_CFG[gpVendor]?.swapFace) {
      const a = (gb >> 0) & 1, b = (gb >> 1) & 1, x = (gb >> 2) & 1, y = (gb >> 3) & 1;
      gb = (gb & ~0xF) | (b << 0) | (a << 1) | (y << 2) | (x << 3);
    }
    const a = [
      Math.round(128 + gp.axes[0] * 127), Math.round(128 + gp.axes[1] * 127),
      gp.axes.length > 2 ? Math.round(128 + gp.axes[2] * 127) : 128,
      gp.axes.length > 3 ? Math.round(128 + gp.axes[3] * 127) : 128,
      Math.round((gp.buttons[6] ? gp.buttons[6].value : 0) * 255),
      Math.round((gp.buttons[7] ? gp.buttons[7].value : 0) * 255),
    ];
    let changed = gb !== gpPrevB;
    if (!changed) for (let i = 0; i < 6; i++) if (a[i] !== gpPrevA[i]) { changed = true; break; }
    if (changed) {
      buttons = gb | touchBtns;
      lx = a[0]; ly = a[1]; rx = a[2]; ry = a[3]; l2 = a[4]; r2 = a[5];
      // Trigger fills
      document.getElementById('fillL2').style.height = (a[4]/255*100)+'%';
      document.getElementById('fillR2').style.height = (a[5]/255*100)+'%';
      // Button highlights
      for (let i = 0; i < 17; i++) {
        document.querySelector('[data-btn="'+i+'"]')?.classList.toggle('pressed', !!(buttons & (1<<i)));
      }
      // Stick thumbs
      const tL = document.getElementById('thumbL'), tR = document.getElementById('thumbR');
      const ldx = ((a[0]-128)/127*35).toFixed(1), ldy = ((a[1]-128)/127*35).toFixed(1);
      const rdx = ((a[2]-128)/127*35).toFixed(1), rdy = ((a[3]-128)/127*35).toFixed(1);
      tL.style.transform = 'translate(calc(-50% + '+ldx+'px),calc(-50% + '+ldy+'px))';
      tR.style.transform = 'translate(calc(-50% + '+rdx+'px),calc(-50% + '+rdy+'px))';
      tL.classList.toggle('active', a[0]!==128||a[1]!==128);
      tR.classList.toggle('active', a[2]!==128||a[3]!==128);
      flush();
      gpPrevB = gb; gpPrevA = a;
    }
  }
  requestAnimationFrame(pollGamepad);
}
requestAnimationFrame(pollGamepad);
window.addEventListener('gamepadconnected', () => {});
window.addEventListener('gamepaddisconnected', () => {});

// Prevent zoom/scroll
document.addEventListener('touchmove', e => e.preventDefault(), {passive:false});
if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(()=>{});
// Screen Wake Lock (requires HTTPS secure context)
let _wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (_wakeLock) return;
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});
// Acquire immediately — no user gesture needed for Wake Lock API
requestWakeLock();
</script>
</body>
</html>`;

// ── Kiosk View HTML ─────────────────────────────────────────────────────
const VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Controllers</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0f0f0f; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 20px; }
  .section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #666; font-weight: 600; margin: 24px 0 10px; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .empty-msg { color: #444; font-size: 12px; padding: 16px 0; }

  .ctrl-card { background: #1a1a1a; border: 1px solid #282828; border-radius: 10px; padding: 14px; width: 280px;
    animation: fadeIn 0.2s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .ctrl-card.removing { opacity: 0; transform: translateY(-8px); transition: all 0.2s ease; }

  .ctrl-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .ctrl-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #4CAF50; }
  .ctrl-name { font-size: 13px; font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctrl-type { font-size: 10px; color: #555; background: #222; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .player-num { font-size: 12px; font-weight: 700; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .p1 { background: #4a9eff22; color: #4a9eff; border: 1px solid #4a9eff44; }
  .p2 { background: #f4433622; color: #f44336; border: 1px solid #f4433644; }
  .p3 { background: #4CAF5022; color: #4CAF50; border: 1px solid #4CAF5044; }
  .p4 { background: #FFC10722; color: #FFC107; border: 1px solid #FFC10744; }

  /* Pad viz — RemotePad style */
  .pad-viz { display: flex; gap: 12px; align-items: center; justify-content: center; padding: 6px 0; }
  .stick-viz { width: 48px; height: 48px; border-radius: 50%; position: relative;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); flex-shrink: 0; }
  .stick-dot { width: 12px; height: 12px; border-radius: 50%; background: #444;
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    transition: top 0.05s, left 0.05s; }
  .stick-dot.active { background: #4da3ff; }
  .trigger-bar-wrap { display: flex; flex-direction: column; gap: 4px; align-items: center; flex-shrink: 0; }
  .trigger-bar { width: 8px; height: 32px; border-radius: 4px; position: relative;
    background: rgba(255,255,255,0.06); overflow: hidden; }
  .trigger-fill { position: absolute; bottom: 0; left: 0; right: 0;
    background: #ffc107; border-radius: 4px; transition: height 0.05s; }
  .trigger-label { font-size: 9px; color: rgba(255,255,255,0.3); }
  .buttons-viz { font-size: 12px; color: rgba(255,255,255,0.6); min-width: 60px; text-align: center;
    word-break: break-all; line-height: 1.6; }

  .status-bar { display: flex; align-items: center; gap: 8px; padding: 12px 0 0; font-size: 11px; color: #555; }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; }
  .status-dot.on { background: #4CAF50; }
  .status-dot.off { background: #f44; }
</style>
</head>
<body>
<div class="container">
  <h1>🎮 Controllers</h1>

  <div class="section-title">Hardware</div>
  <div class="grid" id="hwGrid"></div>
  <div class="empty-msg" id="hwEmpty">No hardware controllers detected</div>

  <div class="section-title">Web Controllers</div>
  <div class="grid" id="webGrid"></div>
  <div class="empty-msg" id="webEmpty">Open <b>http://<span id="hostAddr"></span>/</b> on a phone to connect</div>

  <div class="status-bar">
    <span class="status-dot" id="viewDot"></span>
    <span id="viewText">Connecting...</span>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
$('hostAddr').textContent = location.host;

// Vendor → full button label set. Add new vendors here.
const VENDOR_LABELS = {
  0x054c: {0:'✕',1:'○',2:'□',3:'△',4:'L1',5:'R1',6:'L2',7:'R2',8:'SHR',9:'OPT',10:'L3',11:'R3',12:'↑',13:'↓',14:'←',15:'→',16:'PS'},
  0x057e: {0:'A',1:'B',2:'X',3:'Y',4:'L',5:'R',6:'ZL',7:'ZR',8:'-',9:'+',10:'L3',11:'R3',12:'↑',13:'↓',14:'←',15:'→',16:'⊙'},
};
const DEFAULT_LABELS = {0:'A',1:'B',2:'X',3:'Y',4:'LB',5:'RB',6:'LT',7:'RT',8:'SEL',9:'STR',10:'L3',11:'R3',12:'↑',13:'↓',14:'←',15:'→',16:'⊙'};
function getBtnNames(vendor) { return VENDOR_LABELS[vendor] || DEFAULT_LABELS; }

// Parse 10-byte state array into usable object
function parseState(s) {
  if (!s || s.length < 10) return null;
  const b = s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24);
  return { buttons: b, lx: s[4], ly: s[5], rx: s[6], ry: s[7], l2: s[8], r2: s[9] };
}

function renderViz(state, ctrlType) {
  const s = parseState(state);
  if (!s) return '<div class="pad-viz" style="color:#444;font-size:11px">Idle</div>';

  const lxP = (s.lx / 255 * 100).toFixed(0);
  const lyP = (s.ly / 255 * 100).toFixed(0);
  const rxP = (s.rx / 255 * 100).toFixed(0);
  const ryP = (s.ry / 255 * 100).toFixed(0);
  const l2P = (s.l2 / 255 * 100).toFixed(0);
  const r2P = (s.r2 / 255 * 100).toFixed(0);
  const lActive = s.lx !== 128 || s.ly !== 128;
  const rActive = s.rx !== 128 || s.ry !== 128;
  const names = getBtnNames(ctrlType || 'xbox');

  const pressed = [];
  for (const [bit, name] of Object.entries(names)) {
    if (s.buttons & (1 << Number(bit))) pressed.push(name);
  }

  return '<div class="pad-viz">' +
    '<div class="stick-viz"><div class="stick-dot' + (lActive ? ' active' : '') + '" style="left:'+lxP+'%;top:'+lyP+'%"></div></div>' +
    '<div class="trigger-bar-wrap"><div class="trigger-bar"><div class="trigger-fill" style="height:'+l2P+'%"></div></div><span class="trigger-label">L2</span></div>' +
    '<div class="buttons-viz">' + (pressed.length ? pressed.join(' ') : '·') + '</div>' +
    '<div class="trigger-bar-wrap"><div class="trigger-bar"><div class="trigger-fill" style="height:'+r2P+'%"></div></div><span class="trigger-label">R2</span></div>' +
    '<div class="stick-viz"><div class="stick-dot' + (rActive ? ' active' : '') + '" style="left:'+rxP+'%;top:'+ryP+'%"></div></div>' +
    '</div>';
}

// State tracking
let webPlayers = {};  // slot -> { label, state }
let hwDevices = {};   // eventPath -> { name, connType, state }

function renderWebCard(slot, data) {
  return '<div class="ctrl-card" id="web-'+slot+'">' +
    '<div class="ctrl-header">' +
    '<div class="player-num p'+slot+'">'+slot+'</div>' +
    '<div class="ctrl-dot"></div>' +
    '<span class="ctrl-name">'+(data.label || 'Web Controller')+'</span>' +
    '<span class="ctrl-type">web</span>' +
    '</div>' +
    '<div class="ctrl-state">'+renderViz(data.state, data.vendor)+'</div>' +
    '</div>';
}

function renderHwCard(key, data) {
  const icon = data.connType === 'bluetooth' ? '📶' : data.connType === 'usb' ? '🔌' : '🎮';
  return '<div class="ctrl-card" id="hw-'+CSS.escape(key)+'">' +
    '<div class="ctrl-header">' +
    '<div class="ctrl-dot"></div>' +
    '<span class="ctrl-name">'+data.name+'</span>' +
    '<span class="ctrl-type">'+icon+' '+data.connType+'</span>' +
    '</div>' +
    '<div class="ctrl-state">'+renderViz(data.state, data.vendor)+'</div>' +
    '</div>';
}

function refreshWebGrid() {
  const keys = Object.keys(webPlayers).sort();
  $('webEmpty').style.display = keys.length ? 'none' : 'block';
  $('webGrid').innerHTML = keys.map(k => renderWebCard(k, webPlayers[k])).join('');
}

function refreshHwGrid() {
  const keys = Object.keys(hwDevices);
  $('hwEmpty').style.display = keys.length ? 'none' : 'block';
  $('hwGrid').innerHTML = keys.map(k => renderHwCard(k, hwDevices[k])).join('');
}

// Surgical update — just update the viz inside existing card
function updateViz(id, state, ctrlType) {
  const card = document.getElementById(id);
  if (!card) return false;
  const el = card.querySelector('.ctrl-state');
  if (el) el.innerHTML = renderViz(state, ctrlType);
  return true;
}

function handle(msg) {
  if (msg.type === 'full') {
    webPlayers = {};
    for (const p of msg.players) webPlayers[p.slot] = { label: p.label, state: p.state, vendor: p.vendor };
    hwDevices = {};
    for (const h of msg.hw) hwDevices[h.eventPath] = { name: h.name, connType: h.connType, state: h.state, vendor: h.vendor };
    refreshWebGrid();
    refreshHwGrid();
  } else if (msg.type === 'connect') {
    webPlayers[msg.slot] = { label: msg.label, state: null };
    refreshWebGrid();
  } else if (msg.type === 'disconnect') {
    const card = document.getElementById('web-'+msg.slot);
    if (card) { card.classList.add('removing'); setTimeout(() => { delete webPlayers[msg.slot]; refreshWebGrid(); }, 200); }
    else { delete webPlayers[msg.slot]; refreshWebGrid(); }
  } else if (msg.type === 'player') {
    if (msg.connected) {
      if (!webPlayers[msg.slot]) { webPlayers[msg.slot] = { label: msg.label, state: msg.state, vendor: msg.vendor }; refreshWebGrid(); }
      else { webPlayers[msg.slot].state = msg.state; webPlayers[msg.slot].vendor = msg.vendor; updateViz('web-'+msg.slot, msg.state, msg.vendor); }
    }
  } else if (msg.type === 'hw') {
    if (!hwDevices[msg.eventPath]) {
      hwDevices[msg.eventPath] = { name: msg.name, connType: msg.connType, state: msg.state, vendor: msg.vendor };
      refreshHwGrid();
    } else {
      hwDevices[msg.eventPath].state = msg.state;
      updateViz('hw-'+CSS.escape(msg.eventPath), msg.state, hwDevices[msg.eventPath].vendor);
    }
  }
}

function connectView() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws/view');
  ws.onopen = () => { $('viewDot').className = 'status-dot on'; $('viewText').textContent = 'Live'; };
  ws.onclose = () => { $('viewDot').className = 'status-dot off'; $('viewText').textContent = 'Reconnecting...'; setTimeout(connectView, 1000); };
  ws.onerror = () => ws.close();
  ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch {} };
}
connectView();
refreshWebGrid();
refreshHwGrid();
</script>
</body>
</html>`;

// ── Server ──────────────────────────────────────────────────────────────
// TLS — reuse retrobox certs for secure context (Wake Lock API requires HTTPS)
const CERT_DIR = "/home/pi/retrobox/certs";
let tlsOpts: { cert?: string; key?: string } = {};
try {
  tlsOpts = {
    cert: readFileSync(join(CERT_DIR, "cert.pem"), "utf-8"),
    key: readFileSync(join(CERT_DIR, "key.pem"), "utf-8"),
  };
} catch { console.log("⚠ No TLS certs found, running HTTP only"); }

const server = Bun.serve({
  port: PORT,
  ...(tlsOpts.cert ? { tls: tlsOpts } : {}),
  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws") {
      const player = parseInt(url.searchParams.get("player") || "0");
      if (server.upgrade(req, { data: { type: "controller", wantPlayer: player } })) return;
      return new Response("Upgrade failed", { status: 400 });
    }
    if (path === "/ws/view") {
      if (server.upgrade(req, { data: { type: "view" } })) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    if (path === "/health") return Response.json({ status: "ok" });
    if (path === "/deps/nosleep.min.js") {
      try {
        const ns = readFileSync(join(BASE_DIR, "deps", "nosleep.min.js"));
        return new Response(ns, { headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=86400" } });
      } catch { return new Response("Not found", { status: 404 }); }
    }
    if (path === "/debug") {
      const hw = Array.from(hwControllers.values()).map(h => ({
        name: h.name, eventPath: h.eventPath,
        rawButtons: [...h.rawButtons].map(b => "0x" + b.toString(16)),
        rawAxes: Object.fromEntries([...h.rawAxes].map(([k,v]) => ["0x"+k.toString(16), v])),
        state: Array.from(h.state),
        absInfo: Object.fromEntries([...h.absInfo].map(([k,v]) => [k, v])),
      }));
      return Response.json({ hw, slots: slots.map((s,i) => ({ slot: i+1, connected: !!s.ws, state: s.lastState ? Array.from(s.lastState) : null })) });
    }
    if (path === "/view") return new Response(VIEW_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    return new Response(CONTROLLER_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  },
  websocket: {
    open(ws) {
      const d = (ws as any).data;
      if (d.type === "view") {
        viewClients.add(ws);
        try { ws.send(getFullState()); } catch {}
        console.log(`  👁 View client connected (${viewClients.size})`);
        return;
      }

      let idx = -1;
      if (d.wantPlayer >= 1 && d.wantPlayer <= MAX_PLAYERS) {
        idx = d.wantPlayer - 1;
        if (slots[idx].ws) {
          try { slots[idx].ws.send(JSON.stringify({ type: "kicked" })); } catch {}
          try { slots[idx].ws.close(); } catch {}
          stopSlot(idx);
          slots[idx].ws = null;
        }
      } else {
        idx = findFreeSlot();
      }

      if (idx === -1) {
        try { ws.send(JSON.stringify({ type: "error", message: "All 4 slots full" })); ws.close(); } catch {}
        return;
      }

      slots[idx].ws = ws;
      slots[idx].label = `Player ${idx + 1}`;
      (ws as any).data.slotIndex = idx;

      if (!startSlot(idx)) {
        try { ws.send(JSON.stringify({ type: "error", message: "Failed to create virtual gamepad" })); ws.close(); } catch {}
        slots[idx].ws = null;
        return;
      }

      try { ws.send(JSON.stringify({ type: "assigned", player: idx + 1 })); } catch {}
      console.log(`  + Player ${idx + 1} connected`);
      broadcastConnect(idx);
    },
    message(ws, data) {
      const d = (ws as any).data;
      if (d.type === "view") return;
      if (d.slotIndex !== undefined && (data instanceof ArrayBuffer || data instanceof Uint8Array)) {
        const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        processInput(d.slotIndex, ab);
      }
    },
    close(ws) {
      const d = (ws as any).data;
      if (d.type === "view") {
        viewClients.delete(ws);
        console.log(`  👁 View client disconnected (${viewClients.size})`);
        return;
      }
      if (d.slotIndex !== undefined) {
        const idx = d.slotIndex;
        if (slots[idx].ws === ws) {
          const resetBuf = new ArrayBuffer(10);
          const rv = new DataView(resetBuf);
          rv.setUint8(4, 128); rv.setUint8(5, 128);
          rv.setUint8(6, 128); rv.setUint8(7, 128);
          processInput(idx, resetBuf);
          slots[idx].ws = null;
          slots[idx].lastState = null;
          setTimeout(() => { if (!slots[idx].ws) stopSlot(idx); }, 500);
          console.log(`  - Player ${idx + 1} disconnected`);
          broadcastDisconnect(idx);
        }
      }
    },
  },
});

const proto = tlsOpts.cert ? 'https' : 'http';
console.log(`🎮 Virtual Gamepad server on ${proto}://${getIP()}:${PORT}`);
console.log(`   Controller: ${proto}://${getIP()}:${PORT}/`);
console.log(`   Kiosk view: ${proto}://${getIP()}:${PORT}/view`);
