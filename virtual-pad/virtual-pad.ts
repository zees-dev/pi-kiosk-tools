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
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { networkInterfaces } from "node:os";

const PORT = 3461;
const BASE_DIR = dirname(import.meta.path);
const UINPUT_BIN = join(BASE_DIR, "uinput-gamepad");
const CONFIG_FILE = join(BASE_DIR, "virtual-pad-config.json");
const MAX_PLAYERS = 32; // OS practical limit, not enforced artificially

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

// ── FFI for ioctl (must be before EVIOCGRAB usage) ─────────────────────
let libc: any = null;
let _ptr: any = null;
try {
  const ffi = await import("bun:ffi");
  _ptr = ffi.ptr;
  libc = ffi.dlopen("libc.so.6", {
    ioctl: { args: [ffi.FFIType.i32, ffi.FFIType.u32, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
  });
} catch (e) {
  console.error("  ⚠ Could not load libc for ioctl — axis ranges and EVIOCGRAB will use defaults");
}

// ── Global Controller Hub config ────────────────────────────────────────
interface VpadConfig { globalHub: boolean }
function loadConfig(): VpadConfig {
  try { if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); } catch {}
  return { globalHub: false };
}
function saveConfig(cfg: VpadConfig) {
  try { writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n"); } catch {}
}
let globalHubEnabled = loadConfig().globalHub;

// EVIOCGRAB ioctl: _IOW('E', 0x90, int) — exclusively grab an evdev device
// _IOW(type, nr, size) on aarch64 = ((1 << 30) | (size << 16) | (type << 8) | nr)
const EVIOCGRAB = ((1 << 30) | (4 << 16) | (0x45 << 8) | 0x90) >>> 0;

// Map of grabbed evdev FDs for release on disable
const grabbedFds = new Map<string, number>(); // eventPath → fd

function grabDevice(eventPath: string): boolean {
  if (!libc || !_ptr) return false;
  if (grabbedFds.has(eventPath)) return true;
  try {
    const fd = openSync(eventPath, "r");
    const buf = new Int32Array([1]); // 1 = grab
    const ret = libc.symbols.ioctl(fd, EVIOCGRAB, _ptr(buf));
    if (ret === 0) {
      grabbedFds.set(eventPath, fd);
      console.log(`  🔒 Grabbed ${eventPath}`);
      return true;
    } else {
      closeSync(fd);
      console.error(`  ✗ EVIOCGRAB failed for ${eventPath}`);
      return false;
    }
  } catch (e: any) {
    console.error(`  ✗ Failed to grab ${eventPath}:`, e.message);
    return false;
  }
}

function ungrabDevice(eventPath: string) {
  const fd = grabbedFds.get(eventPath);
  if (fd === undefined) return;
  try {
    const buf = new Int32Array([0]); // 0 = ungrab
    if (libc && _ptr) libc.symbols.ioctl(fd, EVIOCGRAB, _ptr(buf));
    closeSync(fd);
  } catch {}
  grabbedFds.delete(eventPath);
  console.log(`  🔓 Ungrabbed ${eventPath}`);
}

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

function ensureSlot(idx: number) {
  while (slots.length <= idx) {
    const axes = new Uint8Array(6);
    axes[0] = axes[1] = axes[2] = axes[3] = 128;
    slots.push({ ws: null, proc: null, prevButtons: 0, prevAxes: axes, lastState: null, label: "", vendorId: 0 });
  }
}
// Pre-allocate a few slots
for (let i = 0; i < 4; i++) ensureSlot(i);

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
  const hwSlots = new Set(hwSlotMap.values());
  // Check existing slots first
  for (let i = 0; i < slots.length; i++) {
    if ((hwForwardingEnabled || globalHubEnabled) && hwSlots.has(i)) continue;
    if (!slots[i].ws) return i;
  }
  // Expand if under limit
  if (slots.length < MAX_PLAYERS) {
    const idx = slots.length;
    ensureSlot(idx);
    return idx;
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

// ── Hardware → uinput forwarding ────────────────────────────────────────
// When enabled, hardware controllers are assigned uinput slots and their raw
// evdev events are forwarded through virtual gamepad devices. This allows
// emulators configured for "Virtual Gamepad N" to receive input from any
// hardware controller connected at any time (hotplug support).
let hwForwardingEnabled = false;
const hwSlotMap = new Map<string, number>(); // eventPath → slot index

function findFreeHwSlot(): number {
  const hwSlots = new Set(hwSlotMap.values());
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i].ws && !hwSlots.has(i)) return i;
  }
  // Expand
  if (slots.length < MAX_PLAYERS) {
    const idx = slots.length;
    ensureSlot(idx);
    return idx;
  }
  return -1;
}

function assignHwToSlot(eventPath: string): number {
  if (hwSlotMap.has(eventPath)) return hwSlotMap.get(eventPath)!;

  const hwSlots = new Set(hwSlotMap.values());

  // Hardware gets priority — find lowest slot, bumping web clients if needed
  let idx = -1;
  for (let i = 0; i < Math.max(slots.length, 1); i++) {
    ensureSlot(i);
    if (hwSlots.has(i)) continue; // already hw-claimed
    if (slots[i].ws) {
      // Web client on this slot — bump it to a higher free slot (or expand)
      let bumpTo = -1;
      for (let j = i + 1; j < slots.length; j++) {
        if (!slots[j].ws && !hwSlots.has(j)) { bumpTo = j; break; }
      }
      // If no free slot found, expand
      if (bumpTo < 0 && slots.length < MAX_PLAYERS) {
        bumpTo = slots.length;
        ensureSlot(bumpTo);
      }
      if (bumpTo >= 0) {
        const oldWs = slots[i].ws;
        const oldLabel = slots[i].label;
        const oldVendor = slots[i].vendorId;
        const oldLast = slots[i].lastState;
        stopSlot(i);
        slots[i].ws = null;

        slots[bumpTo].ws = oldWs;
        slots[bumpTo].label = oldLabel;
        slots[bumpTo].vendorId = oldVendor;
        slots[bumpTo].lastState = oldLast;
        (oldWs as any).data.slotIndex = bumpTo;
        startSlot(bumpTo);
        try { oldWs.send(JSON.stringify({ type: "slot", slot: bumpTo + 1 })); } catch {}
        console.log(`  ↗ Bumped web Player ${i + 1} → slot ${bumpTo + 1} (hw priority)`);
        broadcastPlayerState(bumpTo);
        idx = i;
        break;
      }
      continue; // can't bump, try next slot
    }
    // Empty slot
    idx = i;
    break;
  }
  // If still no slot, try expanding
  if (idx < 0 && slots.length < MAX_PLAYERS) {
    idx = slots.length;
    ensureSlot(idx);
  }

  if (idx < 0) return -1;
  if (!startSlot(idx)) return -1;
  hwSlotMap.set(eventPath, idx);
  const hw = hwControllers.get(eventPath);
  if (hw) {
    slots[idx].label = hw.name;
    slots[idx].vendorId = hw.vendorId;
  }
  console.log(`  🔗 HW forward: ${hw?.name} → Virtual Gamepad ${idx + 1}`);
  return idx;
}

function releaseHwSlot(eventPath: string) {
  const idx = hwSlotMap.get(eventPath);
  if (idx === undefined) return;
  // Send neutral state before releasing
  const slot = slots[idx];
  if (slot.proc) {
    for (const [, btn] of BUTTON_MAP) writeEvent(slot, EV_KEY, btn, 0);
    writeEvent(slot, EV_ABS, ABS_X, 128);
    writeEvent(slot, EV_ABS, ABS_Y, 128);
    writeEvent(slot, EV_ABS, ABS_RX, 128);
    writeEvent(slot, EV_ABS, ABS_RY, 128);
    writeEvent(slot, EV_ABS, ABS_Z, 0);
    writeEvent(slot, EV_ABS, ABS_RZ, 0);
    writeEvent(slot, EV_ABS, ABS_HAT0X, 0);
    writeEvent(slot, EV_ABS, ABS_HAT0Y, 0);
    writeEvent(slot, EV_SYN, SYN_REPORT, 0);
  }
  stopSlot(idx);
  slots[idx].label = "";
  slots[idx].vendorId = 0;
  hwSlotMap.delete(eventPath);
  console.log(`  🔓 HW forward released: slot ${idx + 1}`);
}

function enableHwForwarding() {
  if (hwForwardingEnabled) return;
  hwForwardingEnabled = true;
  console.log("🔗 HW forwarding enabled — hardware controllers → uinput");
  for (const [path] of hwControllers) {
    assignHwToSlot(path);
    if (globalHubEnabled) grabDevice(path);
  }
}

function disableHwForwarding() {
  if (!hwForwardingEnabled) return;
  hwForwardingEnabled = false;
  console.log("🔓 HW forwarding disabled — hardware controllers direct");
  for (const path of Array.from(hwSlotMap.keys())) {
    releaseHwSlot(path);
  }
  // Ungrab all devices
  for (const path of Array.from(grabbedFds.keys())) {
    ungrabDevice(path);
  }
}

function enableGlobalHub() {
  if (globalHubEnabled) return;
  globalHubEnabled = true;
  saveConfig({ globalHub: true });
  console.log("🌐 Global Controller Hub enabled — all hardware exclusively routed through uinput");
  enableHwForwarding();
  // Grab all currently monitored hw controllers
  for (const [path] of hwControllers) {
    grabDevice(path);
  }
}

function disableGlobalHub() {
  if (!globalHubEnabled) return;
  globalHubEnabled = false;
  saveConfig({ globalHub: false });
  console.log("🌐 Global Controller Hub disabled — hardware passes through directly");
  disableHwForwarding();
}

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
        // Forward normalized state through uinput (same pipeline as web controllers)
        if (hwForwardingEnabled || globalHubEnabled) {
          const idx = hwSlotMap.get(hw.eventPath);
          if (idx !== undefined) {
            processInput(idx, hw.state.buffer);
          }
        }
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
  if (hwForwardingEnabled || globalHubEnabled) releaseHwSlot(eventPath);
  ungrabDevice(eventPath);
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
      if (globalHubEnabled) grabDevice(path);
      startHwMonitor(hw);
      if (hwForwardingEnabled || globalHubEnabled) assignHwToSlot(path);
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

// Auto-enable global hub if configured
if (globalHubEnabled) {
  console.log("🌐 Global Controller Hub: auto-enabling from config");
  hwForwardingEnabled = true; // enable forwarding without re-saving config
  for (const [path] of hwControllers) {
    grabDevice(path);
    assignHwToSlot(path);
  }
}

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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎮</text></svg>">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0a0a; color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; touch-action: none; user-select: none; }

  /* Status — top right */
  .status { position: fixed; top: 6px; right: 10px; display: flex; align-items: center; gap: 6px; z-index: 10; }
  .player-badge { background: #222; border: 1px solid #444; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; cursor: pointer; }
  .p1 { color: #4a9eff; border-color: #4a9eff44; }
  .p2 { color: #f44336; border-color: #f4433644; }
  .p3 { color: #4CAF50; border-color: #4CAF5044; }
  .p4 { color: #FFC107; border-color: #FFC10744; }
  .conn-dot { width: 7px; height: 7px; border-radius: 50%; }
  .conn-dot.connected { background: #4CAF50; }
  .conn-dot.connecting { background: #FFC107; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* ─── CSS Grid portrait layout ─── */
  /* 4 rows: top-bar | hud | shoulders+center | dpad+face | sticks */
  .grid { display: grid; width: 100%; height: 100%; grid-template-rows: auto auto auto 1.4fr 1fr; grid-template-columns: 1fr 1fr; }
  .grid.show-zones .zone { border: 1px solid rgba(74,158,255,0.12); }

  /* Row 1: top bar — settings button only */
  .zone-top { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; padding: 8px 6px; }

  /* Row 2: HUD diagnostics (spans full width) */
  .zone-hud { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; padding: 2px 6px; }

  /* Row 3: shoulders with center buttons between them */
  .zone-shoulders { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; padding: 6px 6px; margin-top: 20vh; }
  .shoulder-stack { display: flex; flex-direction: column; gap: 4px; }
  .center-col { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .center-row { display: flex; gap: 6px; }
  .sm-btn { width: 36px; height: 28px; background: rgba(26,26,26,0.85); border: 1px solid #333; border-radius: 14px; font-size: 9px; font-weight: 600; color: #666; display: flex; align-items: center; justify-content: center; transition: all 0.05s; }
  .sm-btn.pressed { background: rgba(74,158,255,0.2); color: #fff; border-color: #4a9eff; }
  .home-btn { width: 30px; height: 30px; border-radius: 50%; font-size: 13px; }
  .shoulder-btn { padding: 10px 18px; background: rgba(26,26,26,0.85); border: 1px solid #333; border-radius: 8px; font-size: 13px; font-weight: 600; color: #888; transition: all 0.05s; text-align: center; }
  .shoulder-btn.pressed { background: rgba(74,158,255,0.2); color: #fff; border-color: #4a9eff; box-shadow: 0 0 10px rgba(74,158,255,0.3); }
  .trigger-btn { padding: 10px 18px; background: rgba(26,26,26,0.85); border: 1px solid #333; border-radius: 8px; font-size: 13px; font-weight: 600; color: #888; position: relative; overflow: hidden; transition: all 0.05s; text-align: center; }
  .trigger-btn .fill { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(74,158,255,0.35); transition: height 0.05s; }
  .trigger-btn.pressed { background: rgba(74,158,255,0.15); color: #fff; border-color: #4a9eff; }

  /* Row 4: dpad (left) + face buttons (right) */
  .zone-dpad { display: flex; align-items: flex-end; justify-content: center; padding-bottom: 8px; }
  .dpad { width: 130px; height: 130px; position: relative; touch-action: none; }
  .dpad-btn { position: absolute; background: rgba(26,26,26,0.85); border: 1px solid #444; display: flex; align-items: center; justify-content: center; font-size: 20px; color: #888; transition: all 0.05s; pointer-events: none; }
  .dpad-btn.pressed { background: rgba(74,158,255,0.2); color: #fff; border-color: #4a9eff; box-shadow: inset 0 0 8px rgba(74,158,255,0.3); }
  .dpad-up { top: 0; left: 39px; width: 52px; height: 52px; border-radius: 10px 10px 0 0; }
  .dpad-down { bottom: 0; left: 39px; width: 52px; height: 52px; border-radius: 0 0 10px 10px; }
  .dpad-left { top: 39px; left: 0; width: 52px; height: 52px; border-radius: 10px 0 0 10px; }
  .dpad-right { top: 39px; right: 0; width: 52px; height: 52px; border-radius: 0 10px 10px 0; }
  .dpad-center { position: absolute; top: 39px; left: 39px; width: 52px; height: 52px; background: rgba(21,21,21,0.6); border: none; pointer-events: none; }

  .zone-face { display: flex; align-items: flex-end; justify-content: center; padding-bottom: 8px; }
  .face-buttons { width: 140px; height: 140px; position: relative; }
  .face-btn { position: absolute; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; border: 2px solid; transition: all 0.05s; }
  .face-a { bottom: 0; left: 45px; background: #1a3a1a; border-color: #4CAF50; color: #4CAF50; }
  .face-a.pressed { background: rgba(76,175,80,0.35); box-shadow: 0 0 12px rgba(76,175,80,0.4); }
  .face-b { top: 45px; right: 0; background: #3a1a1a; border-color: #f44336; color: #f44336; }
  .face-b.pressed { background: rgba(244,67,54,0.35); box-shadow: 0 0 12px rgba(244,67,54,0.4); }
  .face-x { top: 45px; left: 0; background: #1a1a3a; border-color: #2196F3; color: #2196F3; }
  .face-x.pressed { background: rgba(33,150,243,0.35); box-shadow: 0 0 12px rgba(33,150,243,0.4); }
  .face-y { top: 0; left: 45px; background: #3a3a1a; border-color: #FFC107; color: #FFC107; }
  .face-y.pressed { background: rgba(255,193,7,0.35); box-shadow: 0 0 12px rgba(255,193,7,0.4); }

  /* Row 5: sticks (left + right) */
  .zone-stick-l, .zone-stick-r { position: relative; }
  .pin-indicator { display: none; }

  /* Input HUD (inline in top bar) */
  .input-hud { display: flex; align-items: center; gap: 6px; pointer-events: none; }
  .hud-stick { width: 28px; height: 28px; background: rgba(20,20,20,0.8); border: 1px solid #333; border-radius: 50%; position: relative; }
  .hud-stick-dot { width: 6px; height: 6px; background: #555; border-radius: 50%; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); transition: all 0.05s; }
  .hud-stick-dot.active { background: #4da3ff; }
  .hud-trigger { width: 8px; height: 24px; background: rgba(20,20,20,0.8); border: 1px solid #333; border-radius: 3px; position: relative; overflow: hidden; }
  .hud-trigger-fill { position: absolute; bottom: 0; left: 0; right: 0; background: #4a9eff; transition: height 0.05s; }
  .hud-buttons { background: rgba(20,20,20,0.8); border: 1px solid #333; border-radius: 6px; padding: 3px 8px; font-size: 11px; font-weight: 600; color: #888; min-width: 40px; text-align: center; white-space: nowrap; max-width: 50vw; overflow: hidden; }
  .hud-buttons.active { color: #4da3ff; }

  /* Menu button */
  .menu-btn { width: 32px; height: 32px; background: rgba(26,26,26,0.85); border: 1px solid #333; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; color: #666; transition: all 0.2s; position: relative; flex-shrink: 0; }
  .menu-btn.holding { border-color: #4a9eff; }
  .menu-btn .ring { position: absolute; inset: -2px; border-radius: 50%; border: 2px solid transparent; border-top-color: #4a9eff; transition: none; }
  .menu-btn.holding .ring { animation: menu-spin 1s linear; }
  @keyframes menu-spin { to { transform: rotate(360deg); } }
  .menu-btn .dirty-dot { position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; display: none; }
  .menu-btn .dirty-dot.visible { display: block; }

  /* Settings modal */
  .settings-overlay { position: fixed; inset: 0; background: #0a0a0a; z-index: 100; display: none; flex-direction: column; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .settings-overlay.open { display: flex; }
  .settings-header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid #222; flex-shrink: 0; }
  .settings-title { font-size: 16px; font-weight: 700; color: #e0e0e0; display: flex; align-items: center; gap: 8px; }
  .settings-title .dirty-badge { background: #f59e0b; color: #000; font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 8px; display: none; }
  .settings-title .dirty-badge.visible { display: inline-block; }
  .settings-close { width: 36px; height: 36px; background: none; border: 1px solid #333; border-radius: 50%; color: #888; font-size: 18px; display: flex; align-items: center; justify-content: center; cursor: pointer; }

  .settings-body { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 20px; }
  .setting-section { border: 1px solid #222; border-radius: 10px; padding: 14px; background: #111; }
  .setting-section h3 { font-size: 13px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; }
  .setting-row + .setting-row { border-top: 1px solid #1a1a1a; }
  .setting-label { font-size: 14px; color: #ccc; }
  .setting-sub { font-size: 11px; color: #666; margin-top: 2px; }

  /* Toggle switch */
  .toggle { width: 44px; height: 24px; background: #333; border-radius: 12px; position: relative; cursor: pointer; transition: background 0.2s; flex-shrink: 0; }
  .toggle.on { background: #4a9eff; }
  .toggle .knob { width: 20px; height: 20px; background: #fff; border-radius: 50%; position: absolute; top: 2px; left: 2px; transition: transform 0.2s; }
  .toggle.on .knob { transform: translateX(20px); }

  /* Range slider */
  .range-row { display: flex; align-items: center; gap: 10px; width: 100%; }
  .range-row input[type=range] { flex: 1; accent-color: #4a9eff; height: 4px; }
  .range-val { font-size: 12px; color: #4a9eff; font-weight: 600; min-width: 36px; text-align: right; }

  /* Footer buttons */
  .settings-footer { display: flex; gap: 10px; padding: 16px; border-top: 1px solid #222; flex-shrink: 0; }
  .settings-footer button { flex: 1; padding: 12px; border-radius: 8px; font-size: 14px; font-weight: 600; border: none; cursor: pointer; transition: opacity 0.15s; }
  .settings-footer button:disabled { opacity: 0.3; cursor: default; }
  .btn-revert { background: #222; color: #ccc; }
  .btn-save { background: #4a9eff; color: #fff; }

  /* nipplejs overrides */
  .nipple { z-index: 10 !important; }
  .nipple .back { background: rgba(60,60,60,0.5) !important; border: 2px solid rgba(100,100,100,0.4) !important; }
  .nipple .front { background: rgba(74,158,255,0.7) !important; }
</style>
</head>
<body>
  <!-- Status: top-right player badge + connection dot -->
  <div class="status">
    <span class="player-badge" id="playerBadge">P?</span>
    <span class="conn-dot connecting" id="connDot"></span>
  </div>

  <div class="grid" id="padGrid">
    <!-- Row 1: Settings button -->
    <div class="zone zone-top">
      <div class="menu-btn" id="menuBtn">
        <div class="ring"></div>
        <div class="dirty-dot" id="menuDirtyDot"></div>
        ⚙
      </div>
    </div>

    <!-- Row 2: HUD diagnostics -->
    <div class="zone zone-hud">
      <div class="input-hud" id="inputHud">
        <div class="hud-stick" id="hudStickL"><div class="hud-stick-dot" id="hudDotL"></div></div>
        <div class="hud-trigger" id="hudTrigL"><div class="hud-trigger-fill" id="hudFillL"></div></div>
        <div class="hud-buttons" id="hudButtons">·</div>
        <div class="hud-trigger" id="hudTrigR"><div class="hud-trigger-fill" id="hudFillR"></div></div>
        <div class="hud-stick" id="hudStickR"><div class="hud-stick-dot" id="hudDotR"></div></div>
      </div>
    </div>

    <!-- Row 3: Shoulders + center buttons between them -->
    <div class="zone zone-shoulders">
      <div class="shoulder-stack">
        <div class="trigger-btn" data-btn="6"><div class="fill" id="fillL2"></div>L2</div>
        <div class="shoulder-btn" data-btn="4">L1</div>
      </div>
      <div class="center-col">
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
      <div class="shoulder-stack">
        <div class="trigger-btn" data-btn="7"><div class="fill" id="fillR2"></div>R2</div>
        <div class="shoulder-btn" data-btn="5">R1</div>
      </div>
    </div>

    <!-- Row 4: D-pad (left) + Face buttons (right) -->
    <div class="zone zone-dpad">
      <div class="dpad">
        <div class="dpad-btn dpad-up" data-btn="12">▲</div>
        <div class="dpad-btn dpad-left" data-btn="14">◀</div>
        <div class="dpad-center"></div>
        <div class="dpad-btn dpad-right" data-btn="15">▶</div>
        <div class="dpad-btn dpad-down" data-btn="13">▼</div>
      </div>
    </div>
    <div class="zone zone-face">
      <div class="face-buttons">
        <div class="face-btn face-y" data-btn="3">Y</div>
        <div class="face-btn face-x" data-btn="2">X</div>
        <div class="face-btn face-b" data-btn="1">B</div>
        <div class="face-btn face-a" data-btn="0">A</div>
      </div>
    </div>

    <!-- Row 5: Left stick + Right stick -->
    <div class="zone zone-stick-l" id="stickZoneL"><div class="pin-indicator" id="pinL">📌 pinned</div></div>
    <div class="zone zone-stick-r" id="stickZoneR"><div class="pin-indicator" id="pinR">📌 pinned</div></div>
  </div>

  <!-- Settings modal -->
  <div class="settings-overlay" id="settingsModal">
    <div class="settings-header">
      <div class="settings-title">⚙ Settings <span class="dirty-badge" id="dirtyBadge">modified</span></div>
      <div class="settings-close" id="settingsClose">✕</div>
    </div>
    <div class="settings-body">
      <div class="setting-section">
        <h3>General</h3>
        <div class="setting-row">
          <div>
            <div class="setting-label">Haptic Feedback</div>
            <div class="setting-sub">Vibrate on button press</div>
          </div>
          <div class="toggle" id="hapticToggle"><div class="knob"></div></div>
        </div>
        <div class="setting-row" id="hapticMsRow" style="display:none">
          <div style="width:100%">
            <div class="setting-label">Vibration Duration</div>
            <div class="range-row">
              <input type="range" id="hapticMs" min="5" max="50" step="5" value="15">
              <span class="range-val" id="hapticMsVal">15ms</span>
            </div>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Show Grid Zones</div>
            <div class="setting-sub">Show layout zone boundaries</div>
          </div>
          <div class="toggle" id="gridToggle"><div class="knob"></div></div>
        </div>
      </div>
    </div>
    <div class="settings-footer">
      <button class="btn-revert" id="btnRevert" disabled>Revert to Default</button>
      <button class="btn-save" id="btnSave" disabled>Save</button>
    </div>
  </div>

<script src="/nipplejs.min.js"><\/script>

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


function flush() { net.send(buttons, lx, ly, rx, ry, l2, r2, gpVendor); updateHud(); }

// ═══════════════════════════════════════════════════════════════
// STATUS UI — top-right badge + dot
// ═══════════════════════════════════════════════════════════════
const badge = document.getElementById('playerBadge');
const dot = document.getElementById('connDot');
net.onAssign(p => { badge.textContent = 'P' + p; badge.className = 'player-badge p' + p; });
badge.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
});
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
  // Haptic feedback on press (uses saved settings, not draft)
  if (on && savedSettings.hapticEnabled && navigator.vibrate) navigator.vibrate(savedSettings.hapticMs);
  flush();
}

// ── Input HUD ──
const _hudBtns = document.getElementById('hudButtons');
const _hudDotL = document.getElementById('hudDotL');
const _hudDotR = document.getElementById('hudDotR');
const _hudFillL = document.getElementById('hudFillL');
const _hudFillR = document.getElementById('hudFillR');
const _btnNames = {0:'A',1:'B',2:'X',3:'Y',4:'LB',5:'RB',6:'LT',7:'RT',8:'SEL',9:'STR',10:'L3',11:'R3',12:'↑',13:'↓',14:'←',15:'→',16:'⊙'};
function updateHud() {
  // Pressed buttons text
  const pressed = [];
  for (let i = 0; i < 17; i++) { if (buttons & (1 << i)) pressed.push(_btnNames[i]); }
  _hudBtns.textContent = pressed.length ? pressed.join(' ') : '·';
  _hudBtns.classList.toggle('active', pressed.length > 0);
  // Left stick dot position (% within 28px box)
  const lxP = ((lx / 255) * 100).toFixed(0);
  const lyP = ((ly / 255) * 100).toFixed(0);
  _hudDotL.style.left = lxP + '%';
  _hudDotL.style.top = lyP + '%';
  _hudDotL.classList.toggle('active', lx !== 128 || ly !== 128);
  // Right stick dot position
  const rxP = ((rx / 255) * 100).toFixed(0);
  const ryP = ((ry / 255) * 100).toFixed(0);
  _hudDotR.style.left = rxP + '%';
  _hudDotR.style.top = ryP + '%';
  _hudDotR.classList.toggle('active', rx !== 128 || ry !== 128);
  // Trigger fills
  _hudFillL.style.height = (l2 / 255 * 100).toFixed(0) + '%';
  _hudFillR.style.height = (r2 / 255 * 100).toFixed(0) + '%';
}

// Bind non-dpad buttons (dpad uses zone-based touch handling)
const DPAD_BITS = new Set([12, 13, 14, 15]);
document.querySelectorAll('[data-btn]').forEach(el => {
  const b = parseInt(el.dataset.btn);
  if (DPAD_BITS.has(b)) return; // handled by dpad zone
  el.addEventListener('touchstart', e => { e.preventDefault(); setBtn(b, true); }, { passive: false });
  el.addEventListener('touchend', e => { e.preventDefault(); setBtn(b, false); }, { passive: false });
  el.addEventListener('touchcancel', e => { e.preventDefault(); setBtn(b, false); }, { passive: false });
  el.addEventListener('mousedown', e => { e.preventDefault(); setBtn(b, true); });
  el.addEventListener('mouseup', e => { e.preventDefault(); setBtn(b, false); });
  el.addEventListener('mouseleave', e => { if (e.buttons) setBtn(b, false); });
});

// ── D-pad zone touch handler ──
// Treats entire dpad as one touch zone. Direction based on angle from center.
// Diagonals activate two adjacent directions. Dead zone in center.
(() => {
  const dpad = document.querySelector('.dpad');
  const DEAD = 0.2; // dead zone ratio (center 20%)
  let tid = null;
  let curDirs = { up: false, down: false, left: false, right: false };
  const bits = { up: 12, down: 13, left: 14, right: 15 };

  function update(cx, cy) {
    const r = dpad.getBoundingClientRect();
    const mx = r.left + r.width / 2, my = r.top + r.height / 2;
    const dx = (cx - mx) / (r.width / 2);
    const dy = (cy - my) / (r.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);

    const next = { up: false, down: false, left: false, right: false };
    if (dist > DEAD) {
      const angle = Math.atan2(dy, dx); // radians, 0=right, PI/2=down
      // Each cardinal owns 135° centered on its axis (67.5° each side).
      // Adjacent cardinals overlap by 45° = diagonal zones.
      // up=-90°, right=0°, down=90°, left=±180°
      const deg = angle * 180 / Math.PI;
      if (deg >= -157.5 && deg <= -22.5) next.up = true;     // -157.5 to -22.5
      if (deg >= -67.5 && deg <= 67.5) next.right = true;    // -67.5 to 67.5
      if (deg >= 22.5 && deg <= 157.5) next.down = true;     // 22.5 to 157.5
      if (deg >= 112.5 || deg <= -112.5) next.left = true;   // wraps around ±180
    }

    for (const dir of ['up', 'down', 'left', 'right']) {
      if (next[dir] !== curDirs[dir]) setBtn(bits[dir], next[dir]);
    }
    curDirs = next;
  }

  function reset() {
    for (const dir of ['up', 'down', 'left', 'right']) {
      if (curDirs[dir]) setBtn(bits[dir], false);
    }
    curDirs = { up: false, down: false, left: false, right: false };
    tid = null;
  }

  dpad.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    tid = t.identifier;
    update(t.clientX, t.clientY);
  }, { passive: false });

  dpad.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === tid) { update(t.clientX, t.clientY); break; }
    }
  }, { passive: false });

  dpad.addEventListener('touchend', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === tid) { reset(); break; }
    }
  }, { passive: false });

  dpad.addEventListener('touchcancel', e => { e.preventDefault(); reset(); }, { passive: false });

  // Mouse support for desktop/iframe debugging
  let mouseDown = false;
  dpad.addEventListener('mousedown', e => { e.preventDefault(); mouseDown = true; update(e.clientX, e.clientY); });
  dpad.addEventListener('mousemove', e => { if (mouseDown) update(e.clientX, e.clientY); });
  dpad.addEventListener('mouseup', e => { e.preventDefault(); mouseDown = false; reset(); });
  dpad.addEventListener('mouseleave', e => { if (mouseDown) { mouseDown = false; reset(); } });
})();

// ═══════════════════════════════════════════════════════════════
// SETTINGS — persistent, dirty-tracked, default-aware
// ═══════════════════════════════════════════════════════════════
const SETTINGS_KEY = 'virtualpad_settings';
const DEFAULT_SETTINGS = { hapticEnabled: false, hapticMs: 15, showGrid: false };
let savedSettings = { ...DEFAULT_SETTINGS };
let draftSettings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try { const raw = localStorage.getItem(SETTINGS_KEY); if (raw) savedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; } catch {}
  draftSettings = { ...savedSettings };
  renderSettings();
  applyGridFromSaved();
}

function saveSettings() {
  savedSettings = { ...draftSettings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(savedSettings));
  renderSettings();
}

function revertSettings() {
  draftSettings = { ...DEFAULT_SETTINGS };
  renderSettings();
}

function isDirty() { return JSON.stringify(draftSettings) !== JSON.stringify(savedSettings); }
function isDefault() { return JSON.stringify(draftSettings) === JSON.stringify(DEFAULT_SETTINGS); }

const _hapticToggle = document.getElementById('hapticToggle');
const _hapticMs = document.getElementById('hapticMs');
const _hapticMsVal = document.getElementById('hapticMsVal');
const _hapticMsRow = document.getElementById('hapticMsRow');
const _gridToggle = document.getElementById('gridToggle');
const _padGrid = document.getElementById('padGrid');
const _btnSave = document.getElementById('btnSave');
const _btnRevert = document.getElementById('btnRevert');
const _dirtyBadge = document.getElementById('dirtyBadge');
const _menuDirtyDot = document.getElementById('menuDirtyDot');

function renderSettings() {
  _hapticToggle.classList.toggle('on', draftSettings.hapticEnabled);
  _hapticMsRow.style.display = draftSettings.hapticEnabled ? '' : 'none';
  _hapticMs.value = draftSettings.hapticMs;
  _hapticMsVal.textContent = draftSettings.hapticMs + 'ms';
  _gridToggle.classList.toggle('on', draftSettings.showGrid);
  _padGrid.classList.toggle('show-zones', draftSettings.showGrid);
  const dirty = isDirty();
  _btnSave.disabled = !dirty;
  _btnRevert.disabled = isDefault();
  _dirtyBadge.classList.toggle('visible', dirty);
  _menuDirtyDot.classList.toggle('visible', dirty);
}

// Apply grid from saved settings immediately (before modal opens)
function applyGridFromSaved() { _padGrid.classList.toggle('show-zones', savedSettings.showGrid); }

_hapticToggle.addEventListener('click', () => { draftSettings.hapticEnabled = !draftSettings.hapticEnabled; renderSettings(); });
_hapticMs.addEventListener('input', () => { draftSettings.hapticMs = parseInt(_hapticMs.value); _hapticMsVal.textContent = _hapticMs.value + 'ms'; const dirty = isDirty(); _btnSave.disabled = !dirty; _dirtyBadge.classList.toggle('visible', dirty); _menuDirtyDot.classList.toggle('visible', dirty); });
_gridToggle.addEventListener('click', () => { draftSettings.showGrid = !draftSettings.showGrid; renderSettings(); });
_btnSave.addEventListener('click', () => { saveSettings(); applyGridFromSaved(); });
_btnRevert.addEventListener('click', () => { revertSettings(); });

// ── Menu button — 2s long-press ──
const _menuBtn = document.getElementById('menuBtn');
const _modal = document.getElementById('settingsModal');
const _closeBtn = document.getElementById('settingsClose');
let _menuTimer = null;

function openSettings() {
  _modal.classList.add('open');
  history.pushState({ settingsOpen: true }, '');
}
function closeSettings(fromPopstate) {
  _modal.classList.remove('open');
  if (!fromPopstate && history.state && history.state.settingsOpen) history.back();
}

_menuBtn.addEventListener('touchstart', e => {
  e.preventDefault();
  _menuBtn.classList.add('holding');
  _menuTimer = setTimeout(() => { _menuBtn.classList.remove('holding'); openSettings(); }, 1000);
}, { passive: false });
_menuBtn.addEventListener('touchend', e => { e.preventDefault(); clearTimeout(_menuTimer); _menuBtn.classList.remove('holding'); }, { passive: false });
_menuBtn.addEventListener('touchcancel', () => { clearTimeout(_menuTimer); _menuBtn.classList.remove('holding'); });
// Mouse support for desktop/iframe debugging
_menuBtn.addEventListener('mousedown', e => {
  e.preventDefault();
  _menuBtn.classList.add('holding');
  _menuTimer = setTimeout(() => { _menuBtn.classList.remove('holding'); openSettings(); }, 1000);
});
_menuBtn.addEventListener('mouseup', e => { e.preventDefault(); clearTimeout(_menuTimer); _menuBtn.classList.remove('holding'); });
_menuBtn.addEventListener('mouseleave', () => { clearTimeout(_menuTimer); _menuBtn.classList.remove('holding'); });
_closeBtn.addEventListener('click', () => closeSettings(false));
window.addEventListener('popstate', e => { if (_modal.classList.contains('open')) { closeSettings(true); } });

loadSettings();

// ── nipplejs sticks (with pin support) ──
function setupNippleStick(zoneId, isRight, clickBit, pinId) {
  const zone = document.getElementById(zoneId);
  const pinEl = document.getElementById(pinId);
  let mgr = null;
  let pinned = false;
  let pinnedPos = null;
  let holdTimer = null;
  let lastTap = 0;
  let stickSize = 0;

  function calcSize() { return Math.max(80, Math.min(Math.min(zone.offsetWidth, zone.offsetHeight) * 0.75, 140)); }

  function bindEvents(m) {
    m.on('start', () => {
      const now = Date.now();
      if (now - lastTap < 300) { setBtn(clickBit, true); setTimeout(() => setBtn(clickBit, false), 100); }
      lastTap = now;
      // Hold 2s to pin/unpin
      holdTimer = setTimeout(() => {
        if (!pinned) {
          const nipple = zone.querySelector('.nipple');
          if (nipple) {
            const zr = zone.getBoundingClientRect();
            const nr = nipple.getBoundingClientRect();
            pinnedPos = { left: (nr.left - zr.left + nr.width/2) + 'px', top: (nr.top - zr.top + nr.height/2) + 'px' };
            pinned = true;
            recreate();
            if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
          }
        } else {
          pinned = false;
          pinnedPos = null;
          recreate();
          if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
        }
      }, 2000);
    });
    m.on('move', (e, data) => {
      // Cancel hold if finger moved significantly
      if (holdTimer && data.distance > 15) { clearTimeout(holdTimer); holdTimer = null; }
      const maxR = data.instance.options.size / 2;
      const ratio = Math.min(1, data.distance / maxR);
      const rad = data.angle.radian;
      const dx = Math.cos(rad) * ratio;
      const dy = -Math.sin(rad) * ratio;
      const nx = Math.round(128 + dx * 127);
      const ny = Math.round(128 + dy * 127);
      if (isRight) { rx = nx; ry = ny; } else { lx = nx; ly = ny; }
      flush();
    });
    m.on('end', () => {
      clearTimeout(holdTimer); holdTimer = null;
      if (isRight) { rx = 128; ry = 128; } else { lx = 128; ly = 128; }
      flush();
    });
  }

  function recreate() {
    if (mgr) { mgr.destroy(); mgr = null; }
    // Clear leftover nipple DOM
    zone.querySelectorAll('.nipple').forEach(n => n.remove());
    stickSize = calcSize();
    const opts = {
      zone: zone,
      size: stickSize,
      color: 'rgba(74,158,255,0.5)',
      restOpacity: pinned ? 0.5 : 0.3,
      fadeTime: 100,
    };
    if (pinned && pinnedPos) {
      opts.mode = 'static';
      opts.position = pinnedPos;
    } else {
      opts.mode = 'dynamic';
    }
    mgr = nipplejs.create(opts);
    bindEvents(mgr);
    // Add subtle pin icon inside the nipple back circle
    if (pinned) {
      const back = zone.querySelector('.nipple .back');
      if (back) {
        back.style.position = 'relative';
        const pin = document.createElement('div');
        pin.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:12px;opacity:0.25;pointer-events:none;';
        pin.textContent = '\ud83d\udccc';
        back.appendChild(pin);
      }
    }
  }

  recreate();
}
setupNippleStick('stickZoneL', false, 10, 'pinL');
setupNippleStick('stickZoneR', true, 11, 'pinR');

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
      // Stick values already set via nipplejs or gamepad — no DOM thumbs to update
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
// Portrait-first layout — no orientation lock
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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎛️</text></svg>">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0f0f0f; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; min-height: 100vh; }
  .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
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

  .hub-toggle { display: flex; align-items: center; gap: 12px; background: #1a1a1a; border: 1px solid #282828; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; }
  .hub-toggle .hub-info { flex: 1; }
  .hub-toggle .hub-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
  .hub-toggle .hub-desc { font-size: 11px; color: #666; line-height: 1.3; }
  .hub-toggle .hub-badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .hub-badge.on { background: #4a9eff22; color: #4a9eff; border: 1px solid #4a9eff44; }
  .hub-badge.off { background: #33333388; color: #888; border: 1px solid #33333388; }
  .toggle { position: relative; width: 42px; height: 24px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle .knob { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #333; border-radius: 12px; cursor: pointer; transition: .2s; }
  .toggle .knob:before { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; bottom: 3px; background: #888; border-radius: 50%; transition: .2s; }
  .toggle input:checked+.knob { background: #4a9eff; }
  .toggle input:checked+.knob:before { transform: translateX(18px); background: #fff; }

  /* Debug controllers */
  .debug-controls { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .debug-btn { padding: 8px 16px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #ccc; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .debug-btn:hover { background: #222; border-color: #4a9eff; color: #fff; }
  .debug-btn.danger { border-color: #f4433644; color: #f44336; }
  .debug-btn.danger:hover { background: #3a1a1a; border-color: #f44336; }
  .debug-btn:disabled { opacity: 0.3; cursor: default; pointer-events: none; }
  .debug-count { font-size: 11px; color: #555; margin-left: auto; }
  .debug-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; align-items: start; }
  .debug-frame-wrap { background: #1a1a1a; border: 1px solid #282828; border-radius: 10px; overflow: hidden; animation: fadeIn 0.2s ease; }
  .debug-frame-wrap.landscape { grid-column: span 2; }
  .debug-frame-header { display: flex; align-items: center; gap: 2px; padding: 4px 4px 4px 8px; border-bottom: 1px solid #222; }
  .debug-frame-url { flex: 1; min-width: 0; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 3px 6px; font-size: 10px; color: #444; font-family: monospace; outline: none; transition: all 0.15s; cursor: default; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
  .debug-frame-url:hover { color: #888; border-color: #333; cursor: text; }
  .debug-frame-url:focus { background: #111; border-color: #4a9eff; color: #fff; cursor: text; }
  .debug-frame-btn { width: 24px; height: 24px; background: none; border: 1px solid transparent; border-radius: 4px; color: #555; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; flex-shrink: 0; }
  .debug-frame-btn:hover { border-color: #444; color: #ccc; }
  .debug-frame-btn.close { color: #f4433666; }
  .debug-frame-btn.close:hover { border-color: #f44336; color: #f44336; background: #3a1a1a; }
  .debug-frame-body { width: 100%; aspect-ratio: 9/16; overflow: hidden; background: #0f0f0f; }
  .debug-frame-body.landscape { aspect-ratio: 16/9; }
  .debug-frame-body iframe { width: 200%; height: 200%; border: none; transform: scale(0.5); transform-origin: top left; background: #0f0f0f; }
</style>
<script src="http://127.0.0.1/gamepad-nav.js"></script>
</head>
<body>
<div class="container">
  <h1>🎮 Controllers</h1>

  <div class="hub-toggle">
    <div class="hub-info">
      <div class="hub-title">🌐 Global Controller Hub</div>
      <div class="hub-desc">Exclusively capture hardware controllers and route through virtual gamepad slots. Hardware gets priority.</div>
    </div>
    <span class="hub-badge" id="hubBadge">OFF</span>
    <label class="toggle"><input type="checkbox" id="hubToggle" onchange="toggleGlobalHub(this.checked)"><span class="knob"></span></label>
  </div>

  <div class="section-title">Hardware</div>
  <div class="grid" id="hwGrid"></div>
  <div class="empty-msg" id="hwEmpty">No hardware controllers detected</div>

  <div class="section-title">Web Controllers</div>
  <div class="grid" id="webGrid"></div>
  <div class="empty-msg" id="webEmpty">Open <b>http://<span id="hostAddr"></span>/</b> on a phone to connect</div>

  <!-- Debug Controllers -->
  <div class="section-title">🐛 Debug Controllers</div>
  <div id="debugSection">
    <div class="debug-controls">
      <button class="debug-btn" id="addCtrlBtn" onclick="addDebugController()">+ Add Controller</button>
      <button class="debug-btn danger" id="clearCtrlBtn" onclick="clearDebugControllers()" disabled>Clear All</button>
      <span class="debug-count" id="debugCount">0 controllers</span>
    </div>
    <div class="debug-grid" id="debugGrid"></div>
  </div>

  <div class="status-bar">
    <span class="status-dot" id="viewDot"></span>
    <span id="viewText">Connecting...</span>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
$('hostAddr').textContent = location.host;

// Global Hub toggle
async function toggleGlobalHub(enabled) {
  try {
    const resp = await fetch('/api/global-hub', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) });
    const data = await resp.json();
    updateHubBadge(data.enabled);
  } catch {}
}

function updateHubBadge(enabled) {
  const badge = $('hubBadge');
  const toggle = $('hubToggle');
  if (badge) { badge.textContent = enabled ? 'ON' : 'OFF'; badge.className = 'hub-badge ' + (enabled ? 'on' : 'off'); }
  if (toggle) toggle.checked = enabled;
}

// Load initial hub state
fetch('/api/global-hub').then(r => r.json()).then(d => updateHubBadge(d.enabled)).catch(() => {});

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
  const keys = Object.keys(webPlayers).sort((a, b) => Number(a) - Number(b));
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

// ── Debug Controllers ──
let debugCounter = 0;
const debugFrames = new Map(); // id -> { url, iframe }

function getBaseUrl() {
  return location.protocol + '//' + location.host + '/';
}

function addDebugController(playerNum) {
  debugCounter++;
  const id = 'dbg-' + debugCounter;
  const url = playerNum ? getBaseUrl() + '?player=' + playerNum : getBaseUrl();
  
  const wrap = document.createElement('div');
  wrap.className = 'debug-frame-wrap';
  wrap.id = id;
  const header = document.createElement('div');
  header.className = 'debug-frame-header';
  const num = document.createElement('span');
  num.style.cssText = 'font-size:10px;color:#555;font-weight:600;flex-shrink:0';
  num.textContent = '#' + debugCounter;
  const urlInput = document.createElement('input');
  urlInput.className = 'debug-frame-url';
  urlInput.value = url;
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { reloadDebugFrame(id); urlInput.blur(); } });
  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'debug-frame-btn';
  reloadBtn.title = 'Reload';
  reloadBtn.textContent = '\u21bb';
  reloadBtn.addEventListener('click', () => reloadDebugFrame(id));
  const rotateBtn = document.createElement('button');
  rotateBtn.className = 'debug-frame-btn';
  rotateBtn.title = 'Toggle Portrait/Landscape';
  rotateBtn.textContent = '\u{1f504}';
  rotateBtn.addEventListener('click', () => {
    const body = wrap.querySelector('.debug-frame-body');
    body.classList.toggle('landscape');
    wrap.classList.toggle('landscape');
  });
  const closeBtn = document.createElement('button');
  closeBtn.className = 'debug-frame-btn close';
  closeBtn.title = 'Disconnect & Close';
  closeBtn.textContent = '\u2715';
  closeBtn.addEventListener('click', () => removeDebugController(id));
  header.append(num, urlInput, reloadBtn, rotateBtn, closeBtn);
  const body = document.createElement('div');
  body.className = 'debug-frame-body';
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.allow = 'gamepad; vibrate';
  body.appendChild(iframe);
  wrap.append(header, body);

  $('debugGrid').appendChild(wrap);
  debugFrames.set(id, { url });
  updateDebugCount();
}

function reloadDebugFrame(id) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  const urlInput = wrap.querySelector('.debug-frame-url');
  if (!urlInput) return;
  const newUrl = urlInput.value.trim() || getBaseUrl();
  const body = wrap.querySelector('.debug-frame-body');
  body.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = newUrl;
  iframe.allow = 'gamepad; vibrate';
  body.appendChild(iframe);
  debugFrames.set(id, { url: newUrl });
}

function removeDebugController(id) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  // Remove iframe first to trigger WS disconnect
  const iframe = wrap.querySelector('iframe');
  if (iframe) iframe.src = 'about:blank';
  wrap.classList.add('removing');
  setTimeout(() => { wrap.remove(); debugFrames.delete(id); updateDebugCount(); }, 200);
}

function clearDebugControllers() {
  debugFrames.forEach((_, id) => {
    const wrap = document.getElementById(id);
    if (wrap) {
      const iframe = wrap.querySelector('iframe');
      if (iframe) iframe.src = 'about:blank';
    }
  });
  setTimeout(() => {
    $('debugGrid').innerHTML = '';
    debugFrames.clear();
    debugCounter = 0;
    updateDebugCount();
  }, 100);
}

function updateDebugCount() {
  $('debugCount').textContent = debugFrames.size + ' controller' + (debugFrames.size !== 1 ? 's' : '');
  $('clearCtrlBtn').disabled = debugFrames.size === 0;
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
  async fetch(req, server) {
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
    if (path === "/api/controllers") {
      const players = slots.map((s, i) => ({
        slot: i + 1, connected: !!s.ws, label: s.label, vendor: s.vendorId,
      })).filter(p => p.connected);
      const hw = Array.from(hwControllers.values()).map(h => ({
        name: h.name, type: h.type, vendor: h.vendorId,
      }));
      return Response.json({ players, hw });
    }
    if (path === "/api/hw-forwarding") {
      if (req.method === "GET") {
        return Response.json({
          enabled: hwForwardingEnabled,
          mappings: Object.fromEntries(Array.from(hwSlotMap.entries()).map(([ep, idx]) => [ep, idx + 1])),
        });
      }
      if (req.method === "POST") {
        try {
          const body: { enabled: boolean } = await req.json();
          if (body.enabled) enableHwForwarding(); else disableHwForwarding();
          return Response.json({ ok: true, enabled: hwForwardingEnabled });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message }, { status: 400 });
        }
      }
    }
    if (path === "/api/global-hub") {
      if (req.method === "GET") {
        return Response.json({
          enabled: globalHubEnabled,
          hwControllers: hwControllers.size,
          webControllers: slots.filter(s => s.ws).length,
          totalSlots: hwSlotMap.size + slots.filter(s => s.ws).length,
          mappings: Object.fromEntries(Array.from(hwSlotMap.entries()).map(([ep, idx]) => [ep, idx + 1])),
          grabbed: Array.from(grabbedFds.keys()),
        });
      }
      if (req.method === "POST") {
        try {
          const body: { enabled: boolean } = await req.json();
          if (body.enabled) enableGlobalHub(); else disableGlobalHub();
          return Response.json({ ok: true, enabled: globalHubEnabled });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message }, { status: 400 });
        }
      }
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
    if (path === "/nipplejs.min.js") return new Response(readFileSync(join(BASE_DIR, "nipplejs.min.js"), "utf-8"), { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
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
        ensureSlot(idx);
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
        try { ws.send(JSON.stringify({ type: "error", message: "All slots full" })); ws.close(); } catch {}
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
