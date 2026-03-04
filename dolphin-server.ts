/**
 * Dolphin Manager - Single-file Bun fullstack server
 *
 * Web UI for managing Dolphin Emulator on the Pi kiosk.
 * Browse GameCube/Wii ROMs, launch games, configure settings.
 *
 * Usage: bun run dolphin-server.ts
 * Then open http://localhost:3460
 */

import { serve, spawn as bunSpawn, type Subprocess } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join, basename, extname, relative } from "path";

const PORT = 3460;
const BASE_DIR = import.meta.dir;
const DOLPHIN_DIR = join(BASE_DIR, "dolphin");
const CONFIG_DIR = join(DOLPHIN_DIR, "Config");
const DOLPHIN_NOGUI = "/run/current-system/sw/bin/dolphin-emu-nogui";
const DOLPHIN_GUI = "/run/current-system/sw/bin/dolphin-emu";
const SUDO = "/run/wrappers/bin/sudo";
const CAGE_BIN = "/run/current-system/sw/bin/cage";
const ENV_BIN = "/run/current-system/sw/bin/env";
const ROM_EXTENSIONS = new Set([".iso", ".gcm", ".gcz", ".ciso", ".wbfs", ".rvz", ".wia", ".dol", ".elf"]);

// ── Hotplug Mode ────────────────────────────────────────────────────────────
// When enabled, Dolphin uses Virtual Gamepad devices (via virtual-pad server)
// instead of direct hardware controllers. This allows hotplugging controllers
// at any time, even during gameplay.
const HOTPLUG_FILE = join(BASE_DIR, "dolphin-hotplug.json");
let hotplugMode = true; // default on

try {
  if (existsSync(HOTPLUG_FILE)) {
    hotplugMode = JSON.parse(readFileSync(HOTPLUG_FILE, "utf-8")).enabled ?? true;
  }
} catch {}

function saveHotplugMode() {
  writeFileSync(HOTPLUG_FILE, JSON.stringify({ enabled: hotplugMode }) + "\n");
}

// ── Process State ───────────────────────────────────────────────────────────

type DolphinState = "idle" | "running" | "dolphin-ui";

let dolphinProc: Subprocess | null = null;
let currentRom: string = "";
let currentState: DolphinState = "idle";
let lastError: string = "";

// ── Play History ────────────────────────────────────────────────────────────

const HISTORY_FILE = join(BASE_DIR, "play-history.json");
const PROFILES_FILE = join(BASE_DIR, "dolphin-profiles.json");
const PREV_SETTINGS_FILE = join(BASE_DIR, "dolphin-prev-settings.json");
const MAX_PROFILES = 5;

interface PlayHistory {
  [filename: string]: { lastPlayed: number; playCount: number };
}

function loadHistory(): PlayHistory {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  } catch {}
  return {};
}

function recordPlay(filename: string): void {
  const history = loadHistory();
  const entry = history[filename] || { lastPlayed: 0, playCount: 0 };
  entry.lastPlayed = Date.now();
  entry.playCount++;
  history[filename] = entry;
  try { writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch {}
}

// ── Settings Profiles ───────────────────────────────────────────────────────

interface SettingsProfile {
  name: string;
  createdAt: number;
  settings: Record<string, string>; // key=value pairs from all settings
}

function loadProfiles(): SettingsProfile[] {
  try {
    if (existsSync(PROFILES_FILE)) return JSON.parse(readFileSync(PROFILES_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveProfiles(profiles: SettingsProfile[]): void {
  try { writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2)); } catch {}
}

function loadPrevSettings(): Record<string, string> | null {
  try {
    if (existsSync(PREV_SETTINGS_FILE)) return JSON.parse(readFileSync(PREV_SETTINGS_FILE, "utf-8"));
  } catch {}
  return null;
}

function savePrevSettings(settings: Record<string, string>): void {
  try { writeFileSync(PREV_SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
}

// Snapshot all current settings as a flat key=value map
function snapshotSettings(): Record<string, string> {
  const s = readSettings();
  const snap: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.gfx)) snap["gfx." + k] = v;
  for (const [k, v] of Object.entries(s.dolphin)) snap["dolphin." + k] = v;
  return snap;
}

// Apply a flat settings snapshot to INI files
function applySnapshot(snap: Record<string, string>): void {
  const mapping: Record<string, { file: string; section: string; key: string; toggle?: boolean; slider?: boolean }> = {
    "gfx.efbScale": { file: "GFX.ini", section: "Settings", key: "EFBScale" },
    "gfx.msaa": { file: "GFX.ini", section: "Settings", key: "MSAA" },
    "gfx.showFps": { file: "GFX.ini", section: "Settings", key: "ShowFPS" },
    "gfx.maxAnisotropy": { file: "GFX.ini", section: "Enhancements", key: "MaxAnisotropy" },
    "gfx.vsync": { file: "GFX.ini", section: "Hardware", key: "VSync" },
    "gfx.shaderCompilationMode": { file: "GFX.ini", section: "Settings", key: "ShaderCompilationMode" },
    "gfx.waitForShaders": { file: "GFX.ini", section: "Settings", key: "WaitForShadersBeforeStarting" },
    "gfx.fastDepthCalc": { file: "GFX.ini", section: "Settings", key: "FastDepthCalc" },
    "gfx.enablePixelLighting": { file: "GFX.ini", section: "Settings", key: "EnablePixelLighting" },
    "gfx.backendMultithreading": { file: "GFX.ini", section: "Settings", key: "BackendMultithreading" },
    "gfx.efbAccessEnable": { file: "GFX.ini", section: "Hacks", key: "EFBAccessEnable" },
    "gfx.efbAccessDeferInvalidation": { file: "GFX.ini", section: "Hacks", key: "EFBAccessDeferInvalidation" },
    "gfx.bboxEnable": { file: "GFX.ini", section: "Hacks", key: "BBoxEnable" },
    "dolphin.gfxBackend": { file: "Dolphin.ini", section: "Core", key: "GFXBackend" },
    "dolphin.cpuCore": { file: "Dolphin.ini", section: "Core", key: "CPUCore" },
    "dolphin.fullscreen": { file: "Dolphin.ini", section: "Display", key: "Fullscreen" },
    "dolphin.overclockEnable": { file: "Dolphin.ini", section: "Core", key: "OverclockEnable" },
    "dolphin.overclock": { file: "Dolphin.ini", section: "Core", key: "Overclock" },
    "dolphin.dspHle": { file: "Dolphin.ini", section: "Core", key: "DSPHLE" },
    "dolphin.skipIdle": { file: "Dolphin.ini", section: "Core", key: "SkipIdle" },
    "dolphin.syncGpu": { file: "Dolphin.ini", section: "Core", key: "SyncGPU" },
    "dolphin.fastmem": { file: "Dolphin.ini", section: "Core", key: "Fastmem" },
    "dolphin.mmu": { file: "Dolphin.ini", section: "Core", key: "MMU" },
    "dolphin.fprf": { file: "Dolphin.ini", section: "Core", key: "FPRF" },
    "dolphin.audioStretching": { file: "Dolphin.ini", section: "Core", key: "AudioStretch" },
    "dolphin.emulationSpeed": { file: "Dolphin.ini", section: "Core", key: "EmulationSpeed" },
  };
  const changes: { file: string; section: string; key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(snap)) {
    const m = mapping[k];
    if (m) changes.push({ file: m.file, section: m.section, key: m.key, value: v });
  }
  if (changes.length > 0) writeSettings(changes);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd: string, timeout = 10000): string {
  try {
    return execSync(cmd, {
      timeout,
      encoding: "utf-8",
      env: { ...process.env, PATH: "/run/current-system/sw/bin:/run/wrappers/bin:" + (process.env.PATH || "") },
    }).trim();
  } catch (e: any) {
    return e.stdout?.toString()?.trim() || "";
  }
}

function stopKiosk(): void {
  try {
    execSync(`${SUDO} systemctl stop kiosk.service`, { timeout: 10000 });
  } catch {}
}

function restartKiosk(): void {
  try {
    // Remove any runtime drop-in overrides (e.g. Restart=no from other tools)
    execSync(`${SUDO} rm -rf /run/systemd/system/kiosk.service.d`, { timeout: 5000 });
    execSync(`${SUDO} systemctl daemon-reload`, { timeout: 5000 });
    execSync(`${SUDO} systemctl restart kiosk.service`, { timeout: 10000 });
  } catch {}
}

function ensureDirs(): void {
  const dirs = [
    join(DOLPHIN_DIR, "gamecube", "roms"),
    join(DOLPHIN_DIR, "wii", "roms"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

ensureDirs();

// ── ROM Scanner ─────────────────────────────────────────────────────────────

interface RomEntry {
  name: string;
  displayName: string;
  filename: string;
  ext: string;
  size: number;
  sizeFormatted: string;
  mtime: number;
  mtimeFormatted: string;
  platform: string;
  path: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function prettifyName(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, "");
  return name
    .replace(/[_-]/g, " ")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scanRoms(): { gamecube: RomEntry[]; wii: RomEntry[] } {
  const result: { gamecube: RomEntry[]; wii: RomEntry[] } = { gamecube: [], wii: [] };

  for (const platform of ["gamecube", "wii"] as const) {
    const romDir = join(DOLPHIN_DIR, platform, "roms");
    if (!existsSync(romDir)) continue;
    const files = readdirSync(romDir);
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (!ROM_EXTENSIONS.has(ext)) continue;
      const fullPath = join(romDir, file);
      try {
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        result[platform].push({
          name: file,
          displayName: prettifyName(file),
          filename: file,
          ext: ext.slice(1).toUpperCase(),
          size: st.size,
          sizeFormatted: formatSize(st.size),
          mtime: st.mtimeMs,
          mtimeFormatted: new Date(st.mtimeMs).toLocaleDateString("en-NZ", {
            day: "numeric",
            month: "short",
            year: "numeric",
          }),
          platform,
          path: fullPath,
        });
      } catch {}
    }
    result[platform].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return result;
}

// ── Save File Scanner ───────────────────────────────────────────────────────

interface SaveEntry {
  name: string;
  path: string;       // relative to DOLPHIN_DIR for API use
  fullPath: string;
  type: "gci" | "savestate" | "wii";
  gameCode: string;   // 4-char game code (e.g. "GM4E")
  size: number;
  sizeFormatted: string;
  mtime: number;
  mtimeFormatted: string;
}

function scanSaves(): SaveEntry[] {
  const saves: SaveEntry[] = [];
  const gcDir = join(DOLPHIN_DIR, "GC");
  const stateDir = join(DOLPHIN_DIR, "StateSaves");

  // Scan GCI files: GC/{region}/Card A/*.gci
  // GCI filename format: {blocks}-{GAMECODE4}-{title}.gci
  if (existsSync(gcDir)) {
    for (const region of readdirSync(gcDir)) {
      const cardDir = join(gcDir, region, "Card A");
      if (!existsSync(cardDir)) continue;
      try {
        for (const file of readdirSync(cardDir)) {
          if (!file.endsWith(".gci")) continue;
          const fullPath = join(cardDir, file);
          try {
            const st = statSync(fullPath);
            if (!st.isFile()) continue;
            // Parse game code from GCI filename: "64-GM4E-MarioKart Double Dash!!.gci"
            const match = file.match(/^\d+-([A-Z0-9]{4})-/);
            const gameCode = match ? match[1] : file.slice(0, 4);
            saves.push({
              name: file,
              path: relative(DOLPHIN_DIR, fullPath),
              fullPath,
              type: "gci",
              gameCode,
              size: st.size,
              sizeFormatted: formatSize(st.size),
              mtime: st.mtimeMs,
              mtimeFormatted: new Date(st.mtimeMs).toLocaleDateString("en-NZ", {
                day: "numeric", month: "short", year: "numeric",
                hour: "2-digit", minute: "2-digit",
              }),
            });
          } catch {}
        }
      } catch {}
    }
  }

  // Scan Wii NAND saves: Wii/title/{upper}/{lower_hex}/data/*
  // lower_hex is the 4-char game ID encoded as ASCII hex (e.g. "SMNE" → "534d4e45")
  const wiiTitleDir = join(DOLPHIN_DIR, "Wii", "title");
  if (existsSync(wiiTitleDir)) {
    try {
      for (const upper of readdirSync(wiiTitleDir)) {
        // Skip system titles (00000001)
        const upperDir = join(wiiTitleDir, upper);
        try {
          for (const lowerHex of readdirSync(upperDir)) {
            const dataDir = join(upperDir, lowerHex, "data");
            if (!existsSync(dataDir)) continue;
            // Decode game code from hex: "534d4e45" → "SMNE"
            let gameCode = "";
            try {
              const buf = Buffer.from(lowerHex, "hex");
              gameCode = buf.toString("ascii").replace(/[^\x20-\x7E]/g, "");
            } catch {}
            if (gameCode.length !== 4) continue;

            for (const file of readdirSync(dataDir)) {
              // Skip banner.bin (system file, not user save)
              if (file === "banner.bin") continue;
              const fullPath = join(dataDir, file);
              try {
                const st = statSync(fullPath);
                if (!st.isFile()) continue;
                saves.push({
                  name: file,
                  path: relative(DOLPHIN_DIR, fullPath),
                  fullPath,
                  type: "wii",
                  gameCode,
                  size: st.size,
                  sizeFormatted: formatSize(st.size),
                  mtime: st.mtimeMs,
                  mtimeFormatted: new Date(st.mtimeMs).toLocaleDateString("en-NZ", {
                    day: "numeric", month: "short", year: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  }),
                });
              } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Scan Wii system/profile saves: shared2/sys/SYSCONF, title/00000001/*/data/*
  const wiiSharedSys = join(DOLPHIN_DIR, "Wii", "shared2", "sys", "SYSCONF");
  if (existsSync(wiiSharedSys)) {
    try {
      const st = statSync(wiiSharedSys);
      saves.push({
        name: "SYSCONF (Wii System Config)",
        path: relative(DOLPHIN_DIR, wiiSharedSys),
        fullPath: wiiSharedSys,
        type: "wii",
        gameCode: "_WII_SYSTEM",
        size: st.size,
        sizeFormatted: formatSize(st.size),
        mtime: st.mtimeMs,
        mtimeFormatted: new Date(st.mtimeMs).toLocaleDateString("en-NZ", {
          day: "numeric", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        }),
      });
    } catch {}
  }
  const wiiSysDataDir = join(DOLPHIN_DIR, "Wii", "title", "00000001", "00000002", "data");
  if (existsSync(wiiSysDataDir)) {
    try {
      for (const file of readdirSync(wiiSysDataDir)) {
        if (file === "banner.bin") continue;
        const fullPath = join(wiiSysDataDir, file);
        try {
          const st = statSync(fullPath);
          if (!st.isFile()) continue;
          saves.push({
            name: file + " (Wii Profile)",
            path: relative(DOLPHIN_DIR, fullPath),
            fullPath,
            type: "wii",
            gameCode: "_WII_SYSTEM",
            size: st.size,
            sizeFormatted: formatSize(st.size),
            mtime: st.mtimeMs,
            mtimeFormatted: new Date(st.mtimeMs).toLocaleDateString("en-NZ", {
              day: "numeric", month: "short", year: "numeric",
              hour: "2-digit", minute: "2-digit",
            }),
          });
        } catch {}
      }
    } catch {}
  }

  // Scan save states: StateSaves/GAMEID.s01, .s02, etc.
  if (existsSync(stateDir)) {
    try {
      for (const file of readdirSync(stateDir)) {
        const fullPath = join(stateDir, file);
        try {
          const st = statSync(fullPath);
          if (!st.isFile()) continue;
          // Save state filename: GAMEID6.s01 or GAMEID6.sav
          const gameCode = file.slice(0, 4);
          saves.push({
            name: file,
            path: relative(DOLPHIN_DIR, fullPath),
            fullPath,
            type: "savestate",
            gameCode,
            size: st.size,
            sizeFormatted: formatSize(st.size),
            mtime: st.mtimeMs,
            mtimeFormatted: new Date(st.mtimeMs).toLocaleDateString("en-NZ", {
              day: "numeric", month: "short", year: "numeric",
              hour: "2-digit", minute: "2-digit",
            }),
          });
        } catch {}
      }
    } catch {}
  }

  return saves;
}

// Read game code from ISO header (first 4 bytes)
function readGameCode(romPath: string): string | null {
  try {
    const ext = extname(romPath).toLowerCase();
    // Only works for uncompressed ISOs
    if (ext === ".iso" || ext === ".gcm") {
      const fd = require("fs").openSync(romPath, "r");
      const buf = Buffer.alloc(6);
      require("fs").readSync(fd, buf, 0, 6, 0);
      require("fs").closeSync(fd);
      const code = buf.toString("ascii", 0, 4);
      if (/^[A-Z0-9]{4}$/.test(code)) return code;
    }
  } catch {}
  return null;
}

// ── INI Parser/Writer ───────────────────────────────────────────────────────

interface IniData {
  sections: { name: string; entries: { type: "kv" | "comment" | "blank"; key?: string; value?: string; raw: string }[] }[];
}

function parseIni(content: string): IniData {
  const result: IniData = { sections: [{ name: "", entries: [] }] };
  let currentSection = result.sections[0];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const name = trimmed.slice(1, -1);
      currentSection = { name, entries: [] };
      result.sections.push(currentSection);
    } else if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      currentSection.entries.push({ type: trimmed === "" ? "blank" : "comment", raw: line });
    } else {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        currentSection.entries.push({ type: "kv", key, value, raw: line });
      } else {
        currentSection.entries.push({ type: "comment", raw: line });
      }
    }
  }
  return result;
}

function serializeIni(data: IniData): string {
  const lines: string[] = [];
  for (const section of data.sections) {
    if (section.name) lines.push(`[${section.name}]`);
    for (const entry of section.entries) {
      if (entry.type === "kv") {
        lines.push(`${entry.key} = ${entry.value}`);
      } else {
        lines.push(entry.raw);
      }
    }
  }
  return lines.join("\n");
}

function getIniValue(data: IniData, section: string, key: string): string | null {
  const sec = data.sections.find((s) => s.name === section);
  if (!sec) return null;
  const entry = sec.entries.find((e) => e.type === "kv" && e.key === key);
  return entry?.value ?? null;
}

function setIniValue(data: IniData, section: string, key: string, value: string): void {
  let sec = data.sections.find((s) => s.name === section);
  if (!sec) {
    sec = { name: section, entries: [] };
    data.sections.push(sec);
  }
  const entry = sec.entries.find((e) => e.type === "kv" && e.key === key);
  if (entry) {
    entry.value = value;
  } else {
    sec.entries.push({ type: "kv", key, value, raw: `${key} = ${value}` });
  }
}

function readIniFile(filename: string): IniData {
  const path = join(CONFIG_DIR, filename);
  if (!existsSync(path)) return { sections: [] };
  return parseIni(readFileSync(path, "utf-8"));
}

function writeIniFile(filename: string, data: IniData): void {
  const path = join(CONFIG_DIR, filename);
  writeFileSync(path, serializeIni(data));
}

// ── Settings ────────────────────────────────────────────────────────────────

interface Settings {
  gfx: {
    efbScale: string;
    msaa: string;
    showFps: string;
    maxAnisotropy: string;
    vsync: string;
    // Performance
    shaderCompilationMode: string;
    waitForShaders: string;
    fastDepthCalc: string;
    enablePixelLighting: string;
    backendMultithreading: string;
    // Hacks
    efbAccessEnable: string;
    efbAccessDeferInvalidation: string;
    bboxEnable: string;
  };
  dolphin: {
    gfxBackend: string;
    cpuCore: string;
    fullscreen: string;
    overclockEnable: string;
    overclock: string;
    // Performance
    dspHle: string;
    skipIdle: string;
    syncGpu: string;
    fastmem: string;
    mmu: string;
    fprf: string;
    audioStretching: string;
    emulationSpeed: string;
  };
  controllers: {
    player: number;
    device: string;
    buttonCount: number;
  }[];
}

function readSettings(): Settings {
  const gfx = readIniFile("GFX.ini");
  const dolphin = readIniFile("Dolphin.ini");
  const gcpad = readIniFile("GCPadNew.ini");

  // Parse controllers
  const controllers: Settings["controllers"] = [];
  for (let i = 1; i <= 4; i++) {
    const sec = gcpad.sections.find((s) => s.name === `GCPad${i}`);
    if (!sec) continue;
    const device = sec.entries.find((e) => e.type === "kv" && e.key === "Device")?.value || "Not configured";
    const buttonCount = sec.entries.filter(
      (e) => e.type === "kv" && e.key !== "Device" && e.key !== undefined
    ).length;
    controllers.push({ player: i, device, buttonCount });
  }

  return {
    gfx: {
      efbScale: getIniValue(gfx, "Settings", "EFBScale") ?? "4",
      msaa: getIniValue(gfx, "Settings", "MSAA") ?? "0x00000000",
      showFps: getIniValue(gfx, "Settings", "ShowFPS") ?? "False",
      maxAnisotropy: getIniValue(gfx, "Enhancements", "MaxAnisotropy") ?? "0",
      vsync: getIniValue(gfx, "Hardware", "VSync") ?? "False",
      // Performance
      shaderCompilationMode: getIniValue(gfx, "Settings", "ShaderCompilationMode") ?? "0",
      waitForShaders: getIniValue(gfx, "Settings", "WaitForShadersBeforeStarting") ?? "False",
      fastDepthCalc: getIniValue(gfx, "Settings", "FastDepthCalc") ?? "True",
      enablePixelLighting: getIniValue(gfx, "Settings", "EnablePixelLighting") ?? "False",
      backendMultithreading: getIniValue(gfx, "Settings", "BackendMultithreading") ?? "True",
      // Hacks
      efbAccessEnable: getIniValue(gfx, "Hacks", "EFBAccessEnable") ?? "True",
      efbAccessDeferInvalidation: getIniValue(gfx, "Hacks", "EFBAccessDeferInvalidation") ?? "False",
      bboxEnable: getIniValue(gfx, "Hacks", "BBoxEnable") ?? "False",
    },
    dolphin: {
      gfxBackend: getIniValue(dolphin, "Core", "GFXBackend") ?? "Vulkan",
      cpuCore: getIniValue(dolphin, "Core", "CPUCore") ?? "1",
      fullscreen: getIniValue(dolphin, "Display", "Fullscreen") ?? "True",
      overclockEnable: getIniValue(dolphin, "Core", "OverclockEnable") ?? "False",
      overclock: getIniValue(dolphin, "Core", "Overclock") ?? "1.0",
      // Performance
      dspHle: getIniValue(dolphin, "Core", "DSPHLE") ?? "True",
      skipIdle: getIniValue(dolphin, "Core", "SkipIdle") ?? "True",
      syncGpu: getIniValue(dolphin, "Core", "SyncGPU") ?? "True",
      fastmem: getIniValue(dolphin, "Core", "Fastmem") ?? "True",
      mmu: getIniValue(dolphin, "Core", "MMU") ?? "False",
      fprf: getIniValue(dolphin, "Core", "FPRF") ?? "False",
      audioStretching: getIniValue(dolphin, "Core", "AudioStretch") ?? "False",
      emulationSpeed: getIniValue(dolphin, "Core", "EmulationSpeed") ?? "1.0",
    },
    controllers,
    hotplugMode,
  };
}

function writeSettings(changes: { file: string; section: string; key: string; value: string }[]): void {
  const fileCache: Record<string, IniData> = {};

  for (const change of changes) {
    if (!fileCache[change.file]) {
      fileCache[change.file] = readIniFile(change.file);
    }
    setIniValue(fileCache[change.file], change.section, change.key, change.value);
  }

  for (const [filename, data] of Object.entries(fileCache)) {
    // Write via sudo tee to handle kiosk-owned files
    const filePath = join(CONFIG_DIR, filename);
    const content = serializeIni(data);
    try {
      execSync(`${SUDO} tee "${filePath}" > /dev/null`, {
        input: content,
        timeout: 5000,
      });
    } catch (e: any) {
      throw new Error(`Failed to write ${filename}: ${e.message}`);
    }
  }
}

// ── Dolphin Process Management ──────────────────────────────────────────────

function cleanupDolphin(): void {
  dolphinProc = null;
  currentRom = "";
  currentState = "idle";
  // Disable hw forwarding when Dolphin stops
  if (hotplugMode) {
    fetch("https://127.0.0.1:3461/api/hw-forwarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
      tls: { rejectUnauthorized: false },
    }).catch(() => {});
  }
  restartKiosk();
}

// ── Dynamic Controller Config ───────────────────────────────────────────────

/**
 * Scan /proc/bus/input/devices for connected gamepads and generate GCPadNew.ini.
 * Dolphin evdev requires exact device name match — this auto-detects any controller.
 * Supports up to 4 players. Uses a standard Xbox-like mapping that works for most
 * controllers (GameSir, DS4, Xbox, Pro Controller, 8BitDo, etc.)
 */
function generateVirtualPadConfig(): void {
  // Generate INI for Virtual Gamepad 1-4 (stable device names, always present)
  // Virtual gamepads are Xbox 360-style: ABS_X(0),Y(1),Z(2),RX(3),RY(4),RZ(5),HAT0X(16),HAT0Y(17)
  // Sequential axis indices: 0=X, 1=Y, 2=Z, 3=RX, 4=RY, 5=RZ, 6=HAT0X, 7=HAT0Y
  const lines: string[] = [];
  const wiiLines: string[] = [];

  for (let i = 0; i < 4; i++) {
    const devName = `Virtual Gamepad ${i + 1}`;
    lines.push(`[GCPad${i + 1}]`);
    lines.push(`Device = evdev/0/${devName}`);
    lines.push(`Buttons/A = \`EAST\``);
    lines.push(`Buttons/B = \`SOUTH\``);
    lines.push(`Buttons/X = \`NORTH\``);
    lines.push(`Buttons/Y = \`WEST\``);
    lines.push(`Buttons/Z = \`TR\``);
    lines.push(`Buttons/Start = \`START\``);
    lines.push(`Main Stick/Up = \`Axis 1-\``);
    lines.push(`Main Stick/Down = \`Axis 1+\``);
    lines.push(`Main Stick/Left = \`Axis 0-\``);
    lines.push(`Main Stick/Right = \`Axis 0+\``);
    lines.push(`Main Stick/Modifier/Range = 50.0`);
    lines.push(`Main Stick/Dead Zone = 15.0`);
    lines.push(`C-Stick/Up = \`Axis 4-\``);
    lines.push(`C-Stick/Down = \`Axis 4+\``);
    lines.push(`C-Stick/Left = \`Axis 3-\``);
    lines.push(`C-Stick/Right = \`Axis 3+\``);
    lines.push(`C-Stick/Dead Zone = 15.0`);
    lines.push(`Triggers/L = \`Axis 2+\``);
    lines.push(`Triggers/R = \`Axis 5+\``);
    lines.push(`Triggers/L-Analog = \`Axis 2+\``);
    lines.push(`Triggers/R-Analog = \`Axis 5+\``);
    lines.push(`D-Pad/Up = \`Axis 7-\``);
    lines.push(`D-Pad/Down = \`Axis 7+\``);
    lines.push(`D-Pad/Left = \`Axis 6-\``);
    lines.push(`D-Pad/Right = \`Axis 6+\``);
    lines.push(``);

    wiiLines.push(`[Wiimote${i + 1}]`);
    wiiLines.push(`Device = evdev/0/${devName}`);
    wiiLines.push(`Buttons/A = \`SOUTH\``);
    wiiLines.push(`Buttons/B = \`EAST\``);
    wiiLines.push(`Buttons/- = \`SELECT\``);
    wiiLines.push(`Buttons/+ = \`START\``);
    wiiLines.push(`Buttons/Home = \`MODE\``);
    wiiLines.push(`Buttons/1 = \`NORTH\``);
    wiiLines.push(`Buttons/2 = \`WEST\``);
    wiiLines.push(`D-Pad/Up = \`Axis 7-\``);
    wiiLines.push(`D-Pad/Down = \`Axis 7+\``);
    wiiLines.push(`D-Pad/Left = \`Axis 6-\``);
    wiiLines.push(`D-Pad/Right = \`Axis 6+\``);
    wiiLines.push(`IR/Up = \`Axis 4-\``);
    wiiLines.push(`IR/Down = \`Axis 4+\``);
    wiiLines.push(`IR/Left = \`Axis 3-\``);
    wiiLines.push(`IR/Right = \`Axis 3+\``);
    wiiLines.push(`Shake/X = \`TL\``);
    wiiLines.push(`Shake/Y = \`TL\``);
    wiiLines.push(`Shake/Z = \`TL\``);
    wiiLines.push(`Extension = Nunchuk`);
    wiiLines.push(`Nunchuk/Buttons/C = \`Axis 2+\``);
    wiiLines.push(`Nunchuk/Buttons/Z = \`Axis 5+\``);
    wiiLines.push(`Nunchuk/Stick/Up = \`Axis 1-\``);
    wiiLines.push(`Nunchuk/Stick/Down = \`Axis 1+\``);
    wiiLines.push(`Nunchuk/Stick/Left = \`Axis 0-\``);
    wiiLines.push(`Nunchuk/Stick/Right = \`Axis 0+\``);
    wiiLines.push(`Nunchuk/Stick/Dead Zone = 15.0`);
    wiiLines.push(`Nunchuk/Shake/X = \`TR\``);
    wiiLines.push(`Nunchuk/Shake/Y = \`TR\``);
    wiiLines.push(`Nunchuk/Shake/Z = \`TR\``);
    wiiLines.push(``);

    console.log(`[input] GCPad${i + 1} + Wiimote${i + 1} → ${devName} (hotplug mode)`);
  }

  writeFileSync(join(CONFIG_DIR, "GCPadNew.ini"), lines.join("\n") + "\n");
  writeFileSync(join(CONFIG_DIR, "WiimoteNew.ini"), wiiLines.join("\n") + "\n");

  // Ensure all 4 SI (GameCube controller) ports are enabled
  const dolphinIni = readIniFile("Dolphin.ini");
  const changes: { file: string; section: string; key: string; value: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const current = getIniValue(dolphinIni, "Core", `SIDevice${i}`);
    if (current !== "6") {
      changes.push({ file: "Dolphin.ini", section: "Core", key: `SIDevice${i}`, value: "6" });
    }
  }
  if (changes.length > 0) {
    writeSettings(changes);
    console.log(`[input] Enabled ${changes.length} GC controller port(s) in Dolphin.ini`);
  }

  console.log("[input] Generated hotplug configs for 4 Virtual Gamepad slots");
}

function generateGCPadConfig(): void {
  const inputDevices = readFileSync("/proc/bus/input/devices", "utf-8");
  const blocks = inputDevices.split("\n\n").filter(Boolean);

  // Find gamepad devices: must have js handler (joystick) and ABS capabilities
  const gamepads: { name: string; eventHandler: string; jsIndex: number }[] = [];

  for (const block of blocks) {
    const nameMatch = block.match(/N: Name="(.+?)"/);
    const handlersMatch = block.match(/H: Handlers=(.+)/);
    if (!nameMatch || !handlersMatch) continue;

    const name = nameMatch[1];
    const handlers = handlersMatch[1];

    // Must have js (joystick) handler
    const jsMatch = handlers.match(/js(\d+)/);
    if (!jsMatch) continue;

    // Skip virtual/system devices
    if (name.includes("ydotoold") || name.includes("Virtual Mouse") || name.includes("Consumer Control")) continue;

    const eventMatch = handlers.match(/event(\d+)/);
    if (!eventMatch) continue;

    gamepads.push({
      name,
      eventHandler: `event${eventMatch[1]}`,
      jsIndex: parseInt(jsMatch[1]),
    });
  }

  if (gamepads.length === 0) {
    console.log("[input] No gamepads detected, keeping existing GCPadNew.ini");
    return;
  }

  // Sort by js index for consistent player ordering
  gamepads.sort((a, b) => a.jsIndex - b.jsIndex);

  interface PadMapping {
    leftX: number; leftY: number; rightX: number; rightY: number;
    triggerL: string; triggerR: string; // "Axis N+" or "TL2" (button name)
    hatX: number; hatY: number;
  }

  /**
   * Build sequential axis index map from sysfs ABS capabilities.
   * Dolphin evdev assigns Axis indices sequentially for each ABS code present
   * (0 to ABS_MISC=0x28), NOT using raw ABS codes.
   */
  function getAxisMapping(eventHandler: string): PadMapping {
    // Default: assume Xbox-like with ABS_X(0),Y(1),Z(2),RX(3),RY(4),RZ(5),HAT0X(16),HAT0Y(17)
    const defaults: PadMapping = {
      leftX: 0, leftY: 1, rightX: 3, rightY: 4,
      triggerL: "Axis 2+", triggerR: "Axis 5+", hatX: 6, hatY: 7,
    };

    try {
      const absLine = readFileSync(`/sys/class/input/${eventHandler}/device/capabilities/abs`, "utf-8").trim();
      const absBits = BigInt("0x" + absLine.replace(/\s+/g, ""));

      // Build sequential index for each ABS code present (up to ABS_MISC=0x28)
      const ABS_MISC = 0x28;
      const codeToIdx: Record<number, number> = {};
      let idx = 0;
      for (let code = 0; code < ABS_MISC; code++) {
        if (absBits & (1n << BigInt(code))) {
          codeToIdx[code] = idx++;
        }
      }

      const ABS_X = 0, ABS_Y = 1, ABS_Z = 2, ABS_RX = 3, ABS_RY = 4, ABS_RZ = 5;
      const ABS_GAS = 9, ABS_BRAKE = 10, ABS_HAT0X = 16, ABS_HAT0Y = 17;

      const hasRxRy = codeToIdx[ABS_RX] !== undefined && codeToIdx[ABS_RY] !== undefined;
      const hasZRz = codeToIdx[ABS_Z] !== undefined && codeToIdx[ABS_RZ] !== undefined;
      const hasGasBrake = codeToIdx[ABS_GAS] !== undefined && codeToIdx[ABS_BRAKE] !== undefined;

      const mapping: PadMapping = {
        leftX: codeToIdx[ABS_X] ?? 0,
        leftY: codeToIdx[ABS_Y] ?? 1,
        hatX: codeToIdx[ABS_HAT0X] ?? 6,
        hatY: codeToIdx[ABS_HAT0Y] ?? 7,
        // Defaults overridden below
        rightX: 0, rightY: 0, triggerL: "TL2", triggerR: "TR2",
      };

      if (hasRxRy && hasZRz) {
        // Xbox kernel driver: RX/RY for right stick, Z/RZ for triggers
        mapping.rightX = codeToIdx[ABS_RX]; mapping.rightY = codeToIdx[ABS_RY];
        mapping.triggerL = `Axis ${codeToIdx[ABS_Z]}+`; mapping.triggerR = `Axis ${codeToIdx[ABS_RZ]}+`;
      } else if (hasZRz && hasGasBrake) {
        // GameSir/some HID: Z/RZ for right stick, GAS/BRAKE for triggers
        mapping.rightX = codeToIdx[ABS_Z]; mapping.rightY = codeToIdx[ABS_RZ];
        mapping.triggerL = `Axis ${codeToIdx[ABS_BRAKE]}+`; mapping.triggerR = `Axis ${codeToIdx[ABS_GAS]}+`;
      } else if (hasRxRy && !hasZRz) {
        // Nintendo Pro Controller / Switch: RX/RY for right stick, digital-only triggers (buttons)
        mapping.rightX = codeToIdx[ABS_RX]; mapping.rightY = codeToIdx[ABS_RY];
        mapping.triggerL = "TL2"; mapping.triggerR = "TR2";
      } else if (hasZRz) {
        // Fallback: Z/RZ as right stick, digital triggers
        mapping.rightX = codeToIdx[ABS_Z]; mapping.rightY = codeToIdx[ABS_RZ];
        mapping.triggerL = "TL2"; mapping.triggerR = "TR2";
      } else {
        return defaults;
      }

      console.log(`[input] Axis map: ${JSON.stringify(codeToIdx)} → L:${mapping.leftX}/${mapping.leftY} R:${mapping.rightX}/${mapping.rightY} T:${mapping.triggerL}/${mapping.triggerR} H:${mapping.hatX}/${mapping.hatY}`);
      return mapping;
    } catch (e: any) {
      console.log(`[input] Failed to read sysfs for ${eventHandler}, using defaults:`, e.message);
      return defaults;
    }
  }

  // Generate config for up to 4 players.
  // Dolphin evdev buttons: NamedButton strips BTN_/KEY_ prefix → "SOUTH", "EAST", etc.
  // Dolphin evdev axes: Sequential index "Axis N+/-" (NOT raw ABS codes).
  const lines: string[] = [];
  for (let i = 0; i < Math.min(gamepads.length, 4); i++) {
    const gp = gamepads[i];
    const ax = getAxisMapping(gp.eventHandler);

    lines.push(`[GCPad${i + 1}]`);
    lines.push(`Device = evdev/${i}/${gp.name}`);
    // GC A = East face button, GC B = South, GC X = North, GC Y = West
    lines.push(`Buttons/A = \`EAST\``);
    lines.push(`Buttons/B = \`SOUTH\``);
    lines.push(`Buttons/X = \`NORTH\``);
    lines.push(`Buttons/Y = \`WEST\``);
    lines.push(`Buttons/Z = \`TR\``);
    lines.push(`Buttons/Start = \`START\``);
    lines.push(`Main Stick/Up = \`Axis ${ax.leftY}-\``);
    lines.push(`Main Stick/Down = \`Axis ${ax.leftY}+\``);
    lines.push(`Main Stick/Left = \`Axis ${ax.leftX}-\``);
    lines.push(`Main Stick/Right = \`Axis ${ax.leftX}+\``);
    lines.push(`Main Stick/Modifier/Range = 50.0`);
    lines.push(`Main Stick/Dead Zone = 15.0`);
    lines.push(`C-Stick/Up = \`Axis ${ax.rightY}-\``);
    lines.push(`C-Stick/Down = \`Axis ${ax.rightY}+\``);
    lines.push(`C-Stick/Left = \`Axis ${ax.rightX}-\``);
    lines.push(`C-Stick/Right = \`Axis ${ax.rightX}+\``);
    lines.push(`C-Stick/Dead Zone = 15.0`);
    lines.push(`Triggers/L = \`${ax.triggerL}\``);
    lines.push(`Triggers/R = \`${ax.triggerR}\``);
    lines.push(`Triggers/L-Analog = \`${ax.triggerL}\``);
    lines.push(`Triggers/R-Analog = \`${ax.triggerR}\``);
    lines.push(`D-Pad/Up = \`Axis ${ax.hatY}-\``);
    lines.push(`D-Pad/Down = \`Axis ${ax.hatY}+\``);
    lines.push(`D-Pad/Left = \`Axis ${ax.hatX}-\``);
    lines.push(`D-Pad/Right = \`Axis ${ax.hatX}+\``);
    lines.push(``);

    console.log(`[input] GCPad${i + 1} → ${gp.name} (${gp.eventHandler}, js${gp.jsIndex})`);
  }

  const configPath = join(DOLPHIN_DIR, "Config", "GCPadNew.ini");
  writeFileSync(configPath, lines.join("\n") + "\n");
  console.log(`[input] Generated GCPadNew.ini for ${Math.min(gamepads.length, 4)} controller(s)`);

  // Ensure SI ports are enabled for detected controllers
  const dolphinIni = readIniFile("Dolphin.ini");
  const siChanges: { file: string; section: string; key: string; value: string }[] = [];
  for (let i = 0; i < Math.min(gamepads.length, 4); i++) {
    const current = getIniValue(dolphinIni, "Core", `SIDevice${i}`);
    if (current !== "6") {
      siChanges.push({ file: "Dolphin.ini", section: "Core", key: `SIDevice${i}`, value: "6" });
    }
  }
  if (siChanges.length > 0) {
    writeSettings(siChanges);
    console.log(`[input] Enabled ${siChanges.length} GC controller port(s) in Dolphin.ini`);
  }

  // Also generate WiimoteNew.ini for Wii games (emulated Wiimote + Nunchuk)
  const wiiLines: string[] = [];
  for (let i = 0; i < Math.min(gamepads.length, 4); i++) {
    const gp = gamepads[i];
    const ax = getAxisMapping(gp.eventHandler);

    wiiLines.push(`[Wiimote${i + 1}]`);
    wiiLines.push(`Device = evdev/${i}/${gp.name}`);
    // Wiimote buttons
    wiiLines.push(`Buttons/A = \`SOUTH\``);
    wiiLines.push(`Buttons/B = \`EAST\``);
    wiiLines.push(`Buttons/- = \`SELECT\``);
    wiiLines.push(`Buttons/+ = \`START\``);
    wiiLines.push(`Buttons/Home = \`MODE\``);
    wiiLines.push(`Buttons/1 = \`NORTH\``);
    wiiLines.push(`Buttons/2 = \`WEST\``);
    // D-Pad on hat
    wiiLines.push(`D-Pad/Up = \`Axis ${ax.hatY}-\``);
    wiiLines.push(`D-Pad/Down = \`Axis ${ax.hatY}+\``);
    wiiLines.push(`D-Pad/Left = \`Axis ${ax.hatX}-\``);
    wiiLines.push(`D-Pad/Right = \`Axis ${ax.hatX}+\``);
    // IR pointer on right stick
    wiiLines.push(`IR/Up = \`Axis ${ax.rightY}-\``);
    wiiLines.push(`IR/Down = \`Axis ${ax.rightY}+\``);
    wiiLines.push(`IR/Left = \`Axis ${ax.rightX}-\``);
    wiiLines.push(`IR/Right = \`Axis ${ax.rightX}+\``);
    // Shake on bumpers
    wiiLines.push(`Shake/X = \`TL\``);
    wiiLines.push(`Shake/Y = \`TL\``);
    wiiLines.push(`Shake/Z = \`TL\``);
    // Nunchuk extension
    wiiLines.push(`Extension = Nunchuk`);
    wiiLines.push(`Nunchuk/Buttons/C = \`${ax.triggerL}\``);
    wiiLines.push(`Nunchuk/Buttons/Z = \`${ax.triggerR}\``);
    wiiLines.push(`Nunchuk/Stick/Up = \`Axis ${ax.leftY}-\``);
    wiiLines.push(`Nunchuk/Stick/Down = \`Axis ${ax.leftY}+\``);
    wiiLines.push(`Nunchuk/Stick/Left = \`Axis ${ax.leftX}-\``);
    wiiLines.push(`Nunchuk/Stick/Right = \`Axis ${ax.leftX}+\``);
    wiiLines.push(`Nunchuk/Stick/Dead Zone = 15.0`);
    wiiLines.push(`Nunchuk/Shake/X = \`TR\``);
    wiiLines.push(`Nunchuk/Shake/Y = \`TR\``);
    wiiLines.push(`Nunchuk/Shake/Z = \`TR\``);
    wiiLines.push(``);

    console.log(`[input] Wiimote${i + 1} → ${gp.name} (emulated + Nunchuk)`);
  }

  const wiiConfigPath = join(DOLPHIN_DIR, "Config", "WiimoteNew.ini");
  writeFileSync(wiiConfigPath, wiiLines.join("\n") + "\n");
  console.log(`[input] Generated WiimoteNew.ini for ${Math.min(gamepads.length, 4)} controller(s)`);
}

async function launchDolphin(romPath?: string): Promise<{ ok: boolean; error?: string }> {
  if (currentState !== "idle") {
    return { ok: false, error: `Dolphin is already ${currentState === "running" ? "running a game" : "in GUI mode"}` };
  }

  // Always use nogui — Qt GUI crashes with Cage (no Xwayland on this system)
  const binary = DOLPHIN_NOGUI;
  if (!existsSync(binary)) {
    return { ok: false, error: `Binary not found: ${binary}` };
  }

  if (romPath && !existsSync(romPath)) {
    return { ok: false, error: `ROM not found: ${romPath}` };
  }

  // GUI mode without a ROM doesn't work with nogui (needs a ROM to launch)
  if (!romPath) {
    return { ok: false, error: "GUI mode unavailable — this kiosk has no Xwayland. Use the Settings panel to configure Dolphin instead." };
  }

  lastError = "";

  // Generate controller config
  try {
    if (hotplugMode) {
      generateVirtualPadConfig();
      // Enable hw→uinput forwarding on virtual-pad server
      try {
        await fetch("https://127.0.0.1:3461/api/hw-forwarding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
          tls: { rejectUnauthorized: false },
        });
      } catch (e: any) {
        console.log("[input] Warning: could not enable hw forwarding on virtual-pad:", e.message);
      }
    } else {
      generateGCPadConfig();
    }
  } catch (e: any) {
    console.log("[input] Failed to generate controller config:", e.message);
  }

  // Stop kiosk (frees the DRM seat for Cage)
  try {
    stopKiosk();
  } catch (e: any) {
    lastError = "Failed to stop kiosk: " + e.message;
  }

  // Wait for seatd to release the seat
  await new Promise((r) => setTimeout(r, 1500));

  try {
    // Dolphin args
    const dolphinArgs = [binary, "-u", DOLPHIN_DIR];
    if (romPath) dolphinArgs.push("-e", romPath);

    // Cage args: -s (last survivor), -d (allow VT switching)
    const cageArgs = ["-s", "-d", "--", ...dolphinArgs];

    // Environment for kiosk user (owns the DRM seat)
    const envVars: Record<string, string> = {
      XDG_RUNTIME_DIR: "/run/user/1001",
      LIBSEAT_BACKEND: "seatd",
      WLR_RENDERER: "gles2",
      WLR_NO_HARDWARE_CURSORS: "1",
      HOME: "/var/cache/kiosk-home",
      PULSE_SERVER: "/run/user/1001/pulse/native",
      PATH: "/run/wrappers/bin:/run/current-system/sw/bin",
    };
    const envArgs = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

    // sudo -u kiosk env VAR=val cage -s -d -- dolphin-emu ...
    dolphinProc = bunSpawn({
      cmd: [SUDO, "-u", "kiosk", ENV_BIN, ...envArgs, CAGE_BIN, ...cageArgs],
      stdout: "pipe",
      stderr: "pipe",
    });

    currentState = romPath ? "running" : "dolphin-ui";
    currentRom = romPath ? basename(romPath) : "";
    if (romPath) recordPlay(basename(romPath));

    // Log output
    const readStream = (stream: ReadableStream<Uint8Array> | null, prefix: string) => {
      if (!stream) return;
      const reader = stream.getReader();
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) return;
          const text = new TextDecoder().decode(value).trim();
          if (text) console.log(`🐬 [${prefix}] ${text}`);
          pump();
        }).catch(() => {});
      };
      pump();
    };
    readStream(dolphinProc.stdout, "out");
    readStream(dolphinProc.stderr, "err");

    // Monitor process exit
    dolphinProc.exited.then((code) => {
      console.log(`🐬 Cage+Dolphin exited (code ${code})`);
      // Only set error for unexpected exits (not user-initiated stops)
      if (code !== 0 && code !== null && currentState !== "idle") {
        lastError = `Dolphin exited with code ${code}`;
      }
      cleanupDolphin();
    }).catch(() => {
      cleanupDolphin();
    });

    console.log(`🐬 Launched Cage+Dolphin (${currentState}) pid=${dolphinProc.pid}${romPath ? " rom=" + basename(romPath) : ""}`);
    return { ok: true };
  } catch (e: any) {
    lastError = e.message;
    restartKiosk();
    return { ok: false, error: e.message };
  }
}

async function stopDolphin(): Promise<{ ok: boolean; error?: string }> {
  if (!dolphinProc || currentState === "idle") {
    return { ok: false, error: "Dolphin is not running" };
  }

  const proc = dolphinProc;
  const sudoPid = proc.pid;

  try {
    // Find the actual dolphin process (child of cage, grandchild of sudo)
    // Send SIGINT to dolphin directly — it handles graceful shutdown on SIGINT
    const killed = (() => {
      try {
        const dolphinPid = run(`pgrep -f "dolphin-emu.*-u.*/dolphin"`, 3000);
        if (dolphinPid) {
          const pids = dolphinPid.split("\n").map(p => p.trim()).filter(Boolean);
          for (const pid of pids) {
            run(`${SUDO} kill -SIGINT ${pid}`, 3000);
          }
          console.log(`🐬 Sent SIGINT to Dolphin pid(s): ${pids.join(", ")}`);
          return true;
        }
      } catch {}
      return false;
    })();

    if (!killed) {
      // Fallback: kill the sudo/cage process group
      console.log(`🐬 Fallback: killing sudo process ${sudoPid}`);
      try { run(`${SUDO} kill ${sudoPid}`, 3000); } catch {}
    }

    // Wait up to 5 seconds for graceful exit
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);

    if (!exited) {
      // Force kill the whole process tree
      console.log(`🐬 Graceful exit timed out, force killing`);
      try { run(`${SUDO} kill -9 ${sudoPid}`, 3000); } catch {}
      try { run(`${SUDO} pkill -9 -f "dolphin-emu.*-u.*/dolphin"`, 3000); } catch {}
      await Promise.race([
        proc.exited,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }

    // State cleanup happens in the exited handler, but force it if needed
    if (currentState !== "idle") {
      cleanupDolphin();
    }

    lastError = ""; // Clear any exit code error since this was a user-initiated stop
    return { ok: true };
  } catch (e: any) {
    // Force cleanup
    cleanupDolphin();
    lastError = "";
    return { ok: true };
  }
}

// ── HTML Frontend ───────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dolphin Manager</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐬</text></svg>">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; min-height: 100vh; }
  .container { max-width: 640px; margin: 0 auto; padding: 16px; }

  /* Header */
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; margin-bottom: 16px; border-bottom: 1px solid #222; }
  header h1 { font-size: 20px; font-weight: 600; }
  .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; }
  .status-badge.idle { background: #1a2a1a; color: #4CAF50; }
  .status-badge.running { background: #2a1a1a; color: #ff6b6b; }
  .status-badge.dolphin-ui { background: #1a1a2a; color: #4a9eff; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-dot.idle { background: #4CAF50; }
  .status-dot.running { background: #ff6b6b; animation: pulse 2s infinite; }
  .status-dot.dolphin-ui { background: #4a9eff; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

  /* Now Playing */
  .now-playing { background: linear-gradient(135deg, #1a1a2a, #2a1a1a); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 20px; text-align: center; }
  .now-playing .np-label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }
  .now-playing .np-title { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .now-playing .np-mode { font-size: 12px; color: #888; margin-bottom: 16px; }
  .now-playing .stop-btn { background: #c62828; color: #fff; border: none; border-radius: 8px; padding: 12px 32px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
  .now-playing .stop-btn:hover { background: #e53935; }
  .now-playing .stop-btn:active { background: #b71c1c; }
  .now-playing .stop-btn:disabled { background: #555; cursor: not-allowed; }

  /* Error banner */
  .error-banner { background: #2a1a1a; border: 1px solid #c62828; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; color: #ff6b6b; display: flex; align-items: center; gap: 8px; }
  .error-banner .dismiss { background: none; border: none; color: #888; cursor: pointer; margin-left: auto; font-size: 16px; }

  /* Section */
  .section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 10px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .section-title .count { color: #888; font-weight: 400; font-size: 11px; }

  /* Actions bar */
  .actions-bar { display: flex; gap: 8px; margin-bottom: 20px; }
  .action-btn { flex: 1; background: #1a1a1a; border: 1px solid #282828; border-radius: 8px; padding: 10px; color: #aaa; font-size: 13px; cursor: pointer; transition: all 0.15s; text-align: center; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .action-btn:hover { border-color: #444; color: #e0e0e0; background: #1e1e1e; }
  .action-btn:active { background: #222; }
  .action-btn.gui { border-color: #333; }
  .action-btn.gui:hover { border-color: #4a9eff; color: #4a9eff; }

  /* ROM cards */
  .rom-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 24px; }
  .rom-card { display: flex; align-items: center; gap: 12px; background: #1a1a1a; border: 1px solid #282828; border-radius: 10px; padding: 12px 14px; cursor: pointer; transition: all 0.15s; }
  .rom-card:hover { border-color: #444; background: #1e1e1e; }
  .rom-card:active { background: #222; }
  .rom-card .rom-icon { font-size: 24px; flex-shrink: 0; width: 32px; text-align: center; }
  .rom-card .rom-info { flex: 1; min-width: 0; }
  .rom-card .rom-name { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rom-card .rom-meta { font-size: 11px; color: #666; display: flex; gap: 8px; flex-wrap: wrap; }
  .rom-card .rom-meta span { white-space: nowrap; }
  .rom-card .rom-ext { flex-shrink: 0; background: #252525; color: #888; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .platform-empty { text-align: center; color: #444; padding: 16px; font-size: 13px; background: #141414; border: 1px dashed #282828; border-radius: 8px; margin-bottom: 24px; }
  .platform-empty code { color: #666; font-size: 12px; }

  /* System selector cards */
  .system-grid { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
  .system-card { flex: 1; display: flex; align-items: center; gap: 12px; background: #1a1a1a; border: 1px solid #282828; border-radius: 12px; padding: 16px; cursor: pointer; transition: all 0.15s; }
  .system-card:hover { border-color: #4a9eff; background: #1e1e1e; }
  .system-card:active { background: #222; }
  .system-card .system-icon { font-size: 32px; }
  .system-card .system-info { flex: 1; }
  .system-card .system-name { font-size: 16px; font-weight: 600; }
  .system-card .system-count { font-size: 12px; color: #666; }
  .system-card .system-arrow { color: #444; font-size: 18px; }

  /* ROM modal */
  .rom-modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 200; }
  .rom-modal-overlay.open { display: flex; flex-direction: column; }
  .rom-modal { flex: 1; background: #0f0f0f; display: flex; flex-direction: column; max-width: 640px; width: 100%; margin: 0 auto; overflow: hidden; }
  .rom-modal-header { display: flex; align-items: center; gap: 12px; padding: 16px; border-bottom: 1px solid #222; flex-shrink: 0; }
  .rom-modal-header .back-btn { background: none; border: none; color: #aaa; font-size: 22px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
  .rom-modal-header .back-btn:hover { color: #fff; background: #222; }
  .rom-modal-header h2 { font-size: 18px; font-weight: 600; flex: 1; }
  .rom-modal-header .modal-count { font-size: 12px; color: #666; }
  .rom-modal-body { flex: 1; overflow-y: auto; padding: 16px; -webkit-overflow-scrolling: touch; }

  /* Save files — inside ROM card */
  .rom-saves { padding: 4px 0 0; margin-top: 6px; }
  .save-list { display: flex; flex-direction: column; gap: 3px; }
  .save-item { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; background: #151515; border: 1px solid #222; border-radius: 5px; font-size: 11px; cursor: pointer; transition: all 0.15s; }
  .save-item:hover { border-color: #333; background: #1e1e1e; }
  .save-icon { font-size: 12px; flex-shrink: 0; }
  .save-name { color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
  .save-item:hover .save-name { color: #4a9eff; }
  .save-meta { color: #555; font-size: 10px; white-space: nowrap; }
  .save-delete { background: none; border: none; color: #444; cursor: pointer; font-size: 12px; padding: 0 2px; line-height: 1; margin-left: auto; }
  .save-delete:hover { color: #ff4444; }

  /* Collapsible */
  .collapsible { cursor: pointer; user-select: none; display: flex; align-items: center; }
  .collapsible .chevron { font-size: 10px; transition: transform 0.2s; margin-left: auto; }
  .collapsible:not(.open) .chevron { transform: rotate(-90deg); }
  .collapsible-content { margin-bottom: 20px; }
  .collapsible:not(.open) + .collapsible-content { display: none; }

  /* Settings */
  .setting-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #1a1a1a; border: 1px solid #282828; border-radius: 8px; margin-bottom: 6px; }
  .setting-row .setting-label { font-size: 13px; font-weight: 500; }
  .setting-row .setting-desc { font-size: 11px; color: #666; }
  .setting-row select, .setting-row input[type="range"] { accent-color: #4a9eff; background: #111; border: 1px solid #333; color: #e0e0e0; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
  .setting-row select { min-width: 100px; }
  .setting-row input[type="range"] { width: 100px; }

  /* Toggle switch */
  .toggle { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle .slider { position: absolute; inset: 0; background: #333; border-radius: 11px; cursor: pointer; transition: background 0.2s; }
  .toggle .slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 2px; top: 2px; background: #888; border-radius: 50%; transition: all 0.2s; }
  .toggle input:checked + .slider { background: #2e7d32; }
  .toggle input:checked + .slider::before { transform: translateX(18px); background: #4CAF50; }

  /* Controllers */
  .ctrl-card { background: #1a1a1a; border: 1px solid #282828; border-radius: 8px; padding: 10px 14px; margin-bottom: 6px; }
  .ctrl-card .ctrl-player { font-size: 12px; font-weight: 600; color: #4a9eff; margin-bottom: 2px; }
  .ctrl-card .ctrl-device { font-size: 13px; }
  .ctrl-card .ctrl-bindings { font-size: 11px; color: #666; }

  /* Overclock slider value */
  .oc-value { font-size: 12px; color: #4a9eff; font-weight: 500; min-width: 36px; text-align: right; }

  /* Save button */
  .save-bar { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; margin-bottom: 20px; }
  .save-btn { background: #4a9eff; color: #fff; border: none; border-radius: 8px; padding: 10px 24px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
  .save-btn:hover { background: #3a8eef; }
  .save-btn:active { background: #2a7edf; }
  .save-btn:disabled { background: #333; color: #666; cursor: not-allowed; }
  .save-btn.saved { background: #2e7d32; }
  .revert-btn { background: transparent; color: #aaa; border: 1px solid #333; border-radius: 8px; padding: 10px 16px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
  .revert-btn:hover { border-color: #FF9800; color: #FF9800; }
  .revert-btn:disabled { opacity: 0.3; cursor: not-allowed; }

  /* Profiles */
  .profiles-section { margin-top: 12px; margin-bottom: 20px; }
  .profiles-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .profile-card { display: flex; align-items: center; gap: 8px; background: #1a1a1a; border: 1px solid #282828; border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: all 0.15s; min-width: 0; flex: 1; min-width: 140px; max-width: 200px; }
  .profile-card:hover { border-color: #4a9eff; background: #1e1e1e; }
  .profile-card .profile-name { flex: 1; font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .profile-card .profile-date { font-size: 10px; color: #555; }
  .profile-card .profile-delete { background: none; border: none; color: #444; cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1; flex-shrink: 0; }
  .profile-card .profile-delete:hover { color: #ff4444; }
  .profile-add { display: flex; align-items: center; justify-content: center; background: transparent; border: 2px dashed #333; border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: all 0.15s; min-width: 140px; max-width: 200px; flex: 1; color: #555; font-size: 13px; gap: 6px; }
  .profile-add:hover { border-color: #4a9eff; color: #4a9eff; }

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
    <h1>🐬 Dolphin Manager</h1>
    <div class="status-badge idle" id="statusBadge">
      <span class="status-dot idle" id="statusDot"></span>
      <span id="statusText">Idle</span>
    </div>
  </header>

  <div id="errorBanner" style="display:none" class="error-banner">
    <span>⚠️</span>
    <span id="errorText"></span>
    <button class="dismiss" onclick="dismissError()">✕</button>
  </div>

  <div id="nowPlaying" style="display:none" class="now-playing">
    <div class="np-label">Now Playing</div>
    <div class="np-title" id="npTitle"></div>
    <div class="np-mode" id="npMode"></div>
    <button class="stop-btn" id="stopBtn" onclick="stopDolphin()">⏹ Stop & Return to Kiosk</button>
    <button class="stop-btn" id="restartBtn" onclick="restartDolphin()" style="background:#4a9eff; margin-top:8px">🔄 Restart Emulator</button>
  </div>

  <div id="idleContent">
    <div class="actions-bar">
      <button class="action-btn" onclick="refreshRoms()">🔄 Refresh ROMs</button>
      <button class="action-btn gui" onclick="launchUI()" title="Unavailable — no Xwayland on this kiosk" style="opacity:0.4;cursor:not-allowed">🖥️ Dolphin UI (N/A)</button>
    </div>

    <div id="romsContainer"></div>
  </div>

  <div class="rom-modal-overlay" id="romModal">
    <div class="rom-modal">
      <div class="rom-modal-header">
        <button class="back-btn" onclick="history.back()">←</button>
        <h2 id="romModalTitle"></h2>
        <span class="modal-count" id="romModalCount"></span>
      </div>
      <div class="rom-modal-body" id="romModalBody"></div>
    </div>
  </div>

  <div class="section-title collapsible open" id="controllersToggle" onclick="toggleSection('controllers')">
    🎮 Controllers <span class="count" id="ctrlCount"></span> <span class="chevron">▾</span>
  </div>
  <div class="collapsible-content" id="controllersContent">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding:8px 12px;background:#1a1a1a;border-radius:8px;border:1px solid #282828">
      <div>
        <div style="font-size:13px;color:#ccc">Dynamic Hotplug</div>
        <div style="font-size:11px;color:#666;margin-top:2px">Connect/disconnect controllers anytime, even mid-game</div>
      </div>
      <label style="position:relative;width:40px;height:22px;cursor:pointer">
        <input type="checkbox" id="hotplugToggle" onchange="toggleHotplug(this.checked)" style="display:none">
        <span style="position:absolute;inset:0;background:#333;border-radius:11px;transition:0.2s"></span>
        <span style="position:absolute;top:2px;left:2px;width:18px;height:18px;background:#666;border-radius:50%;transition:0.2s" id="hotplugKnob"></span>
      </label>
    </div>
    <div id="controllersList"></div>
  </div>

  <div class="section-title collapsible open" id="settingsToggle" onclick="toggleSection('settings')">
    ⚙️ Settings <span id="dirtyBadge" style="display:none;background:#FF9800;color:#000;font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600;letter-spacing:0.3px">UNSAVED</span> <span class="chevron">▾</span>
  </div>
  <div class="collapsible-content" id="settingsContent">
    <div id="settingsForm"></div>
    <div class="save-bar">
      <button class="revert-btn" id="revertBtn" onclick="revertSettings()" disabled>↩ Revert</button>
      <button class="save-btn" id="saveBtn" onclick="saveSettings()">Save Settings</button>
    </div>
    <div class="profiles-section">
      <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Profiles</div>
      <div class="profiles-grid" id="profilesGrid"></div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const $ = id => document.getElementById(id);
let state = { state: 'idle', rom: '' };
let settings = null;
let toastTimer = null;
let pollInterval = null;
let profiles = [];
let hasPrevSettings = false;

function showToast(msg, type = 'success') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast visible ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = 'toast', 2500);
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

function toggleSection(name) {
  const toggle = $(name + 'Toggle');
  toggle.classList.toggle('open');
}

function dismissError() {
  $('errorBanner').style.display = 'none';
}

function showError(msg) {
  $('errorText').textContent = msg;
  $('errorBanner').style.display = 'flex';
}

// ── Status ──
function updateUI() {
  const badge = $('statusBadge');
  const dot = $('statusDot');
  const text = $('statusText');
  const np = $('nowPlaying');
  const idle = $('idleContent');

  badge.className = 'status-badge ' + state.state;
  dot.className = 'status-dot ' + state.state;

  if (state.state === 'idle') {
    text.textContent = 'Idle';
    np.style.display = 'none';
    idle.style.display = 'block';
  } else if (state.state === 'running') {
    text.textContent = 'Running';
    np.style.display = 'block';
    idle.style.display = 'none';
    $('npTitle').textContent = state.rom || 'Unknown ROM';
    $('npMode').textContent = 'nogui mode';
  } else if (state.state === 'dolphin-ui') {
    text.textContent = 'GUI Mode';
    np.style.display = 'block';
    idle.style.display = 'none';
    $('npTitle').textContent = 'Dolphin GUI';
    $('npMode').textContent = 'Full Dolphin interface';
  }
}

async function loadStatus() {
  try {
    const resp = await fetch('/api/status');
    const data = await resp.json();
    const prev = state.state;
    state = data;
    updateUI();
    if (data.error) showError(data.error);
    // If we transitioned to idle, refresh ROMs
    if (prev !== 'idle' && data.state === 'idle') refreshRoms();
  } catch {}
}

// ── ROMs ──
async function loadRoms() {
  try {
    const resp = await fetch('/api/roms');
    const data = await resp.json();
    renderRoms(data);
  } catch { $('romsContainer').innerHTML = '<div class="platform-empty">Failed to load ROMs</div>'; }
}

let romsData = null;
let openModalPlatform = null;

function renderRoms(data) {
  romsData = data;
  if (openModalPlatform && $('romModal').classList.contains('open')) {
    renderModalContent(openModalPlatform);
  }
  const saves = data.saves || [];
  let html = '<div class="system-grid">';
  for (const [platform, label, icon] of [['gamecube', 'GameCube', '🟣'], ['wii', 'Wii', '⚪']]) {
    const roms = data[platform] || [];
    const recentRom = roms.find(r => r.lastPlayed);
    const recentText = recentRom ? '▶ ' + timeAgo(recentRom.lastPlayed) : '';
    html += '<div class="system-card" onclick="openRomModal(\\'' + platform + '\\')">' +
      '<div class="system-icon">' + icon + '</div>' +
      '<div class="system-info"><div class="system-name">' + label + '</div>' +
      '<div class="system-count">' + roms.length + ' game' + (roms.length !== 1 ? 's' : '') +
      (recentText ? ' · <span style="color:#4a9eff">' + recentText + '</span>' : '') +
      '</div></div>' +
      '<div class="system-arrow">›</div></div>';
  }
  html += '</div>';
  $('romsContainer').innerHTML = html;
}

function renderModalContent(platform) {
  if (!romsData) return;
  const saves = romsData.saves || [];
  const labels = { gamecube: ['GameCube', '🟣'], wii: ['Wii', '⚪'] };
  const [label, icon] = labels[platform] || [platform, '🎮'];
  const roms = romsData[platform] || [];

  $('romModalTitle').textContent = icon + ' ' + label;
  $('romModalCount').textContent = roms.length + ' game' + (roms.length !== 1 ? 's' : '');

  let html = '';
  if (roms.length === 0) {
    html = '<div class="platform-empty">No ROMs found<br><code>dolphin/' + platform + '/roms/</code></div>';
  } else {
    html = '<div class="rom-list">';
    for (const rom of roms) {
      const romSaves = rom.gameCode ? saves.filter(s => s.gameCode === rom.gameCode) : [];
      const lastPlayedStr = rom.lastPlayed ? timeAgo(rom.lastPlayed) : '';
      html += '<div class="rom-card" onclick="launchRom(\\'' + escHtml(rom.platform) + '\\',\\'' + escHtml(rom.filename).replace(/'/g, "\\\\'") + '\\')">' +
        '<div class="rom-icon">' + icon + '</div>' +
        '<div class="rom-info"><div class="rom-name">' + escHtml(rom.displayName) + '</div>' +
        '<div class="rom-meta"><span>' + escHtml(rom.sizeFormatted) + '</span><span>' + escHtml(rom.mtimeFormatted) + '</span>' +
        (lastPlayedStr ? '<span style="color:#4a9eff">▶ ' + lastPlayedStr + '</span>' : '') +
        '</div>';
      if (romSaves.length > 0) {
        html += '<div class="rom-saves"><div class="save-list">';
        for (const s of romSaves) {
          const saveIcon = s.type === 'gci' ? '💾' : s.type === 'wii' ? '🎮' : '📌';
          html += '<div class="save-item" onclick="event.stopPropagation();downloadSave(\\'' + escHtml(s.path).replace(/'/g, "\\\\'") + '\\')" title="Download: ' + escHtml(s.name) + '">' +
            '<span class="save-icon">' + saveIcon + '</span>' +
            '<span class="save-name">' + escHtml(s.name) + '</span>' +
            '<span class="save-meta">' + escHtml(s.sizeFormatted) + '</span>' +
            '<button class="save-delete" onclick="event.stopPropagation();deleteSave(\\'' + escHtml(s.path).replace(/'/g, "\\\\'") + '\\',\\'' + escHtml(s.name).replace(/'/g, "\\\\'") + '\\')" title="Delete">✕</button>' +
            '</div>';
        }
        html += '</div></div>';
      }
      html += '</div>' +
        '<span class="rom-ext">' + escHtml(rom.ext) + '</span></div>';
    }
    html += '</div>';
  }

  // Wii system saves at bottom of Wii modal
  if (platform === 'wii') {
    const sysSaves = saves.filter(s => s.gameCode === '_WII_SYSTEM');
    if (sysSaves.length > 0) {
      html += '<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin:16px 0 8px">🌐 Wii System</div>';
      html += '<div class="rom-list"><div class="rom-card" style="cursor:default">' +
        '<div class="rom-icon">⚙️</div>' +
        '<div class="rom-info"><div class="rom-name">System Profile & Config</div>' +
        '<div class="rom-meta"><span>Global settings, play records</span></div>' +
        '<div class="rom-saves"><div class="save-list">';
      for (const s of sysSaves) {
        html += '<div class="save-item" onclick="event.stopPropagation();downloadSave(\\'' + escHtml(s.path).replace(/'/g, "\\\\'") + '\\')" title="Download: ' + escHtml(s.name) + '">' +
          '<span class="save-icon">🎮</span>' +
          '<span class="save-name">' + escHtml(s.name) + '</span>' +
          '<span class="save-meta">' + escHtml(s.sizeFormatted) + '</span>' +
          '<button class="save-delete" onclick="event.stopPropagation();deleteSave(\\'' + escHtml(s.path).replace(/'/g, "\\\\'") + '\\',\\'' + escHtml(s.name).replace(/'/g, "\\\\'") + '\\')" title="Delete">✕</button>' +
          '</div>';
      }
      html += '</div></div></div></div></div>';
    }
  }

  $('romModalBody').innerHTML = html;
}

function openRomModal(platform) {
  if (!romsData) return;
  openModalPlatform = platform;
  history.pushState({ modal: 'roms' }, '');
  renderModalContent(platform);
  $('romModal').classList.add('open');
}

function closeRomModal() {
  if (!$('romModal').classList.contains('open')) return;
  $('romModal').classList.remove('open');
  openModalPlatform = null;
}

window.addEventListener('popstate', (e) => {
  closeRomModal();
});



async function refreshRoms() {
  showToast('Scanning ROMs...');
  await loadRoms();
  showToast('ROMs refreshed');
}

function downloadSave(path) {
  window.open('/api/saves/download?path=' + encodeURIComponent(path), '_blank');
}

async function deleteSave(path, name) {
  if (!confirm('Delete save file?\\n\\n' + name + '\\n\\nThis cannot be undone.')) return;
  try {
    const resp = await fetch('/api/saves/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Deleted: ' + name);
      loadRoms();
    } else {
      showToast(data.error || 'Delete failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
}

// ── Profiles ──
async function loadProfilesData() {
  try {
    const resp = await fetch('/api/profiles');
    const data = await resp.json();
    profiles = data.profiles || [];
    hasPrevSettings = data.hasPrev || false;
    renderProfiles();
    $('revertBtn').disabled = !hasPrevSettings;
  } catch {}
}

function renderProfiles() {
  const grid = $('profilesGrid');
  let html = '';
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    const date = new Date(p.createdAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    html += '<div class="profile-card" onclick="applyProfile(' + i + ')" title="Apply: ' + escHtml(p.name) + '">' +
      '<div><div class="profile-name">' + escHtml(p.name) + '</div><div class="profile-date">' + date + '</div></div>' +
      '<button class="profile-delete" onclick="event.stopPropagation();deleteProfile(' + i + ')" title="Delete">✕</button></div>';
  }
  if (profiles.length < 5) {
    html += '<div class="profile-add" onclick="saveProfile()">+ Save Profile</div>';
  }
  grid.innerHTML = html;
}

async function saveProfile() {
  const name = prompt('Profile name:', 'Profile ' + (profiles.length + 1));
  if (!name) return;
  try {
    const resp = await fetch('/api/profiles/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Profile saved: ' + name);
      loadProfilesData();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
}

async function applyProfile(index) {
  const p = profiles[index];
  if (!confirm('Apply profile "' + p.name + '"?\\nThis will overwrite current settings.')) return;
  try {
    const resp = await fetch('/api/profiles/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Applied: ' + p.name);
      loadSettings();
      loadProfilesData();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
}

async function deleteProfile(index) {
  const p = profiles[index];
  if (!confirm('Delete profile "' + p.name + '"?')) return;
  try {
    const resp = await fetch('/api/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Deleted: ' + p.name);
      loadProfilesData();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
}

async function revertSettings() {
  if (!confirm('Revert to previous settings?')) return;
  try {
    const resp = await fetch('/api/settings/revert', { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      showToast('Settings reverted');
      loadSettings();
      loadProfilesData();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
}

// ── Launch ──
async function launchRom(platform, filename) {
  if (state.state !== 'idle') { showToast('Dolphin is already running', 'error'); return; }
  closeRomModal();
  showToast('Launching ' + filename + '...');
  $('stopBtn').disabled = false;
  try {
    const resp = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, rom: filename }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Game launched!');
      loadStatus();
    } else {
      showToast(data.error || 'Launch failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
}

async function launchUI() {
  if (state.state !== 'idle') { showToast('Dolphin is already running', 'error'); return; }
  showToast('Opening Dolphin UI...');
  try {
    const resp = await fetch('/api/launch-ui', { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      showToast('Dolphin UI opened');
      loadStatus();
    } else {
      showToast(data.error || 'Launch failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
}

async function stopDolphin() {
  const btn = $('stopBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Stopping...';
  showToast('Stopping Dolphin...');
  try {
    const resp = await fetch('/api/stop', { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      showToast('Dolphin stopped, kiosk restored');
    } else {
      showToast(data.error || 'Stop failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
  btn.disabled = false;
  btn.textContent = '⏹ Stop & Return to Kiosk';
  loadStatus();
}

async function restartDolphin() {
  const btn = $('restartBtn');
  btn.disabled = true;
  btn.textContent = '🔄 Restarting...';
  showToast('Restarting Dolphin...');
  try {
    const resp = await fetch('/api/restart', { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      showToast('Dolphin restarted with latest settings');
    } else {
      showToast(data.error || 'Restart failed', 'error');
    }
  } catch { showToast('Request failed', 'error'); }
  btn.disabled = false;
  btn.textContent = '🔄 Restart Emulator';
  loadStatus();
}

// ── Settings ──
async function loadSettings() {
  try {
    const resp = await fetch('/api/settings');
    settings = await resp.json();
    renderSettings();
    renderControllers();
  } catch {}
}

let savedValues = {};

function checkDirty() {
  let dirty = false;
  document.querySelectorAll('[data-key]').forEach(el => {
    const key = el.dataset.key;
    const current = el.type === 'checkbox' ? el.checked : el.value;
    if (savedValues[key] !== undefined && savedValues[key] !== current) dirty = true;
  });
  setDirty(dirty);
}

function setDirty(dirty) {
  $('dirtyBadge').style.display = dirty ? 'inline' : 'none';
  $('saveBtn').disabled = !dirty;
  $('saveBtn').textContent = dirty ? 'Save Settings' : 'Settings Saved';
}

function renderSettings() {
  if (!settings) return;
  const s = settings;
  let html = '';

  // GFX settings
  html += '<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;margin-top:4px">Graphics (GFX.ini)</div>';

  html += settingSelect('Graphics Backend', 'dolphin.gfxBackend', s.dolphin.gfxBackend, [
    ['Vulkan', 'Vulkan'], ['OGL', 'OpenGL']
  ], 'Vulkan is faster on Pi 5, OpenGL for compatibility');
  html += settingSelect('Internal Resolution', 'gfx.efbScale', s.gfx.efbScale, [
    ['2', '1x (Native)'], ['4', '2x (720p)'], ['6', '3x (1080p)']
  ], 'Biggest performance lever — 1x for speed, 2x for quality');
  html += settingSelect('Anti-Aliasing', 'gfx.msaa', s.gfx.msaa, [
    ['0x00000000', 'Off'], ['0x00000002', '2x MSAA'], ['0x00000004', '4x MSAA']
  ], 'Smooths edges — keep off for Pi 5 performance');
  html += settingSelect('Anisotropic Filtering', 'gfx.maxAnisotropy', s.gfx.maxAnisotropy, [
    ['0', '1x'], ['1', '2x'], ['2', '4x'], ['3', '8x']
  ], 'Sharpens textures at angles — low cost');
  html += settingToggle('Show FPS', 'gfx.showFps', s.gfx.showFps === 'True', 'Display frame rate counter on screen');
  html += settingToggle('VSync', 'gfx.vsync', s.gfx.vsync === 'True', 'Sync to display refresh — prevents tearing, may add lag');

  // Dolphin settings
  html += '<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;margin-top:12px">Emulation (Dolphin.ini)</div>';

  html += settingSelect('CPU Engine', 'dolphin.cpuCore', s.dolphin.cpuCore, [
    ['1', 'JIT (Fast)'], ['0', 'Interpreter (Slow)']
  ], 'JIT recompiles — much faster than interpreter');
  html += settingToggle('Fullscreen', 'dolphin.fullscreen', s.dolphin.fullscreen === 'True', 'Run in fullscreen mode');
  html += settingToggle('Overclock', 'dolphin.overclockEnable', s.dolphin.overclockEnable === 'True', 'Overclock the emulated GameCube/Wii CPU');
  html += settingSlider('Overclock Factor', 'dolphin.overclock', parseFloat(s.dolphin.overclock) || 1.0, 0.5, 2.0, 0.1);

  // Performance section
  html += '<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;margin-top:16px">⚡ Performance</div>';

  html += settingSelect('Shader Compilation', 'gfx.shaderCompilationMode', s.gfx.shaderCompilationMode, [
    ['0', 'Synchronous (Accurate)'], ['1', 'Async (Skip drawing)'], ['2', 'Async (Skip + Ubershaders)'], ['3', 'Hybrid Ubershaders']
  ], 'Async modes reduce shader stutter');
  html += settingToggle('Pre-compile Shaders', 'gfx.waitForShaders', s.gfx.waitForShaders === 'True', 'Compile shaders at boot (longer load, less stutter)');
  html += settingToggle('Fast Depth Calc', 'gfx.fastDepthCalc', s.gfx.fastDepthCalc === 'True', 'Skip accurate depth — big GPU save');
  html += settingToggle('Backend Multithreading', 'gfx.backendMultithreading', s.gfx.backendMultithreading === 'True', 'Use multiple CPU cores for rendering');
  html += settingToggle('Pixel Lighting', 'gfx.enablePixelLighting', s.gfx.enablePixelLighting === 'True', 'Per-pixel lighting — expensive, off = faster');
  html += settingToggle('EFB Access', 'gfx.efbAccessEnable', s.gfx.efbAccessEnable === 'True', 'Some games need this — disable for speed');
  html += settingToggle('EFB Defer Invalidation', 'gfx.efbAccessDeferInvalidation', s.gfx.efbAccessDeferInvalidation === 'True', 'Defer EFB cache invalidation — faster when EFB on');
  html += settingToggle('Bounding Box', 'gfx.bboxEnable', s.gfx.bboxEnable === 'True', 'Very expensive — only Paper Mario needs this');

  html += '<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;margin-top:16px">⚡ CPU & Audio</div>';

  html += settingToggle('DSP HLE', 'dolphin.dspHle', s.dolphin.dspHle === 'True', 'High-level audio emulation — much faster than LLE');
  html += settingToggle('Skip Idle', 'dolphin.skipIdle', s.dolphin.skipIdle === 'True', 'Skip idle CPU loops — saves cycles');
  html += settingToggle('Sync GPU', 'dolphin.syncGpu', s.dolphin.syncGpu === 'True', 'GPU synchronization — off = faster but may glitch');
  html += settingToggle('Fast Memory', 'dolphin.fastmem', s.dolphin.fastmem === 'True', 'Fast memory access for JIT — keep enabled');
  html += settingToggle('Full MMU', 'dolphin.mmu', s.dolphin.mmu === 'True', 'Full memory management — very slow, rarely needed');
  html += settingToggle('FP Result Flags', 'dolphin.fprf', s.dolphin.fprf === 'True', 'Floating point accuracy — off = faster');
  html += settingToggle('Audio Stretching', 'dolphin.audioStretching', s.dolphin.audioStretching === 'True', 'Stretch audio to prevent crackling when slow');
  html += settingSlider('Speed Limit', 'dolphin.emulationSpeed', parseFloat(s.dolphin.emulationSpeed) || 1.0, 0.0, 2.0, 0.1);

  $('settingsForm').innerHTML = html;

  // Store initial values for dirty tracking
  savedValues = {};
  document.querySelectorAll('[data-key]').forEach(el => {
    const key = el.dataset.key;
    if (el.type === 'checkbox') savedValues[key] = el.checked;
    else savedValues[key] = el.value;
  });
  setDirty(false);

  // Attach change listeners for dirty tracking
  document.querySelectorAll('[data-key]').forEach(el => {
    const handler = () => checkDirty();
    el.addEventListener('change', handler);
    el.addEventListener('input', handler);
  });

  // Attach slider live updates
  document.querySelectorAll('input[type="range"][data-key]').forEach(slider => {
    slider.oninput = () => {
      const val = parseFloat(slider.value).toFixed(1);
      const suffix = slider.dataset.key === 'dolphin.emulationSpeed' ? (val === '0.0' ? ' (unlimited)' : 'x') : 'x';
      slider.nextElementSibling.textContent = val + suffix;
      checkDirty();
    };
  });
}

function settingSelect(label, key, current, options, desc) {
  let opts = options.map(([val, text]) =>
    '<option value="' + escHtml(val) + '"' + (val === current ? ' selected' : '') + '>' + escHtml(text) + '</option>'
  ).join('');
  return '<div class="setting-row"><div><div class="setting-label">' + escHtml(label) + '</div>' +
    (desc ? '<div class="setting-desc">' + escHtml(desc) + '</div>' : '') + '</div>' +
    '<select data-key="' + key + '">' + opts + '</select></div>';
}

function settingToggle(label, key, checked, desc) {
  return '<div class="setting-row"><div><div class="setting-label">' + escHtml(label) + '</div>' +
    (desc ? '<div class="setting-desc">' + escHtml(desc) + '</div>' : '') + '</div>' +
    '<label class="toggle"><input type="checkbox" data-key="' + key + '"' + (checked ? ' checked' : '') + '><span class="slider"></span></label></div>';
}

function settingSlider(label, key, value, min, max, step) {
  return '<div class="setting-row"><div><div class="setting-label">' + escHtml(label) + '</div></div>' +
    '<div style="display:flex;align-items:center;gap:8px">' +
    '<input type="range" data-key="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '">' +
    '<span class="oc-value">' + value.toFixed(1) + 'x</span></div></div>';
}

async function saveSettings() {
  const btn = $('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  // Backup current settings before overwriting
  try { await fetch('/api/settings/backup', { method: 'POST' }); } catch {}

  // Collect all changed values
  const changes = [];
  const mapping = {
    'gfx.efbScale': { file: 'GFX.ini', section: 'Settings', key: 'EFBScale' },
    'gfx.msaa': { file: 'GFX.ini', section: 'Settings', key: 'MSAA' },
    'gfx.showFps': { file: 'GFX.ini', section: 'Settings', key: 'ShowFPS', toggle: true },
    'gfx.maxAnisotropy': { file: 'GFX.ini', section: 'Enhancements', key: 'MaxAnisotropy' },
    'gfx.vsync': { file: 'GFX.ini', section: 'Hardware', key: 'VSync', toggle: true },
    'dolphin.gfxBackend': { file: 'Dolphin.ini', section: 'Core', key: 'GFXBackend' },
    'dolphin.cpuCore': { file: 'Dolphin.ini', section: 'Core', key: 'CPUCore' },
    'dolphin.fullscreen': { file: 'Dolphin.ini', section: 'Display', key: 'Fullscreen', toggle: true },
    'dolphin.overclockEnable': { file: 'Dolphin.ini', section: 'Core', key: 'OverclockEnable', toggle: true },
    'dolphin.overclock': { file: 'Dolphin.ini', section: 'Core', key: 'Overclock', slider: true },
    // Performance - GFX
    'gfx.shaderCompilationMode': { file: 'GFX.ini', section: 'Settings', key: 'ShaderCompilationMode' },
    'gfx.waitForShaders': { file: 'GFX.ini', section: 'Settings', key: 'WaitForShadersBeforeStarting', toggle: true },
    'gfx.fastDepthCalc': { file: 'GFX.ini', section: 'Settings', key: 'FastDepthCalc', toggle: true },
    'gfx.enablePixelLighting': { file: 'GFX.ini', section: 'Settings', key: 'EnablePixelLighting', toggle: true },
    'gfx.backendMultithreading': { file: 'GFX.ini', section: 'Settings', key: 'BackendMultithreading', toggle: true },
    'gfx.efbAccessEnable': { file: 'GFX.ini', section: 'Hacks', key: 'EFBAccessEnable', toggle: true },
    'gfx.efbAccessDeferInvalidation': { file: 'GFX.ini', section: 'Hacks', key: 'EFBAccessDeferInvalidation', toggle: true },
    'gfx.bboxEnable': { file: 'GFX.ini', section: 'Hacks', key: 'BBoxEnable', toggle: true },
    // Performance - Dolphin
    'dolphin.dspHle': { file: 'Dolphin.ini', section: 'Core', key: 'DSPHLE', toggle: true },
    'dolphin.skipIdle': { file: 'Dolphin.ini', section: 'Core', key: 'SkipIdle', toggle: true },
    'dolphin.syncGpu': { file: 'Dolphin.ini', section: 'Core', key: 'SyncGPU', toggle: true },
    'dolphin.fastmem': { file: 'Dolphin.ini', section: 'Core', key: 'Fastmem', toggle: true },
    'dolphin.mmu': { file: 'Dolphin.ini', section: 'Core', key: 'MMU', toggle: true },
    'dolphin.fprf': { file: 'Dolphin.ini', section: 'Core', key: 'FPRF', toggle: true },
    'dolphin.audioStretching': { file: 'Dolphin.ini', section: 'Core', key: 'AudioStretch', toggle: true },
    'dolphin.emulationSpeed': { file: 'Dolphin.ini', section: 'Core', key: 'EmulationSpeed', slider: true },
  };

  document.querySelectorAll('[data-key]').forEach(el => {
    const key = el.dataset.key;
    const m = mapping[key];
    if (!m) return;
    let value;
    if (m.toggle) {
      value = el.checked ? 'True' : 'False';
    } else if (m.slider) {
      value = parseFloat(el.value).toFixed(1);
    } else {
      value = el.value;
    }
    changes.push({ file: m.file, section: m.section, key: m.key, value });
  });

  try {
    const resp = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Settings saved — takes effect on next launch / restart');
      // Update saved values to match current
      document.querySelectorAll('[data-key]').forEach(el => {
        const key = el.dataset.key;
        savedValues[key] = el.type === 'checkbox' ? el.checked : el.value;
      });
      setDirty(false);
      btn.className = 'save-btn saved';
      btn.textContent = '✓ Saved';
      setTimeout(() => { btn.className = 'save-btn'; setDirty(false); }, 1500);
      loadProfilesData();
    } else {
      showToast(data.error || 'Save failed', 'error');
      btn.disabled = false;
      btn.textContent = 'Save Settings';
    }
  } catch {
    showToast('Request failed', 'error');
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}

// ── Controllers ──
function renderControllers() {
  if (!settings || !settings.controllers) return;
  const ctrls = settings.controllers;
  const isHotplug = settings.hotplugMode;

  // Update hotplug toggle
  const toggle = $('hotplugToggle');
  const knob = $('hotplugKnob');
  if (toggle) toggle.checked = isHotplug;
  if (knob) {
    knob.style.left = isHotplug ? '20px' : '2px';
    knob.style.background = isHotplug ? '#4a9eff' : '#666';
    knob.parentElement.querySelector('span').style.background = isHotplug ? '#1a3a5c' : '#333';
  }

  if (isHotplug) {
    $('ctrlCount').textContent = '(hotplug)';
    $('controllersList').innerHTML = '<div class="platform-empty" style="color:#4a9eff">🔌 Dynamic mode — controllers can be connected anytime.<br><span style="color:#666;font-size:11px">Uses Virtual Gamepad passthrough via the Virtual Pad service.</span></div>';
    return;
  }

  $('ctrlCount').textContent = '(' + ctrls.length + ' players)';

  if (ctrls.length === 0) {
    $('controllersList').innerHTML = '<div class="platform-empty">No controllers configured</div>';
    return;
  }

  let html = '';
  for (const c of ctrls) {
    html += '<div class="ctrl-card">' +
      '<div class="ctrl-player">Player ' + c.player + '</div>' +
      '<div class="ctrl-device">' + escHtml(c.device) + '</div>' +
      '<div class="ctrl-bindings">' + c.buttonCount + ' bindings configured</div>' +
      '</div>';
  }
  $('controllersList').innerHTML = html;
}

async function toggleHotplug(enabled) {
  try {
    const resp = await fetch('/api/hotplug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const data = await resp.json();
    if (data.ok) {
      showToast(enabled ? 'Hotplug mode enabled' : 'Hotplug mode disabled');
      loadSettings();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Poll ──
function startPolling() {
  pollInterval = setInterval(loadStatus, 3000);
}

// ── Init ──
loadStatus();
loadRoms();
loadSettings();
loadProfilesData();
startPolling();
</script>
</body>
</html>`;

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Frontend
    if (path === "/" || path === "/index.html") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // API: ROM list (includes game codes, saves, and play history)
    if (path === "/api/roms" && req.method === "GET") {
      const roms = scanRoms();
      const history = loadHistory();
      // Attach game codes and play history to ROMs
      for (const platform of ["gamecube", "wii"] as const) {
        for (const rom of roms[platform]) {
          const code = readGameCode(rom.path);
          if (code) (rom as any).gameCode = code;
          const h = history[rom.filename];
          if (h) {
            (rom as any).lastPlayed = h.lastPlayed;
            (rom as any).playCount = h.playCount;
          }
        }
        // Sort: recently played first (by lastPlayed desc), then alphabetical
        roms[platform].sort((a, b) => {
          const aPlayed = (a as any).lastPlayed || 0;
          const bPlayed = (b as any).lastPlayed || 0;
          if (aPlayed && !bPlayed) return -1;
          if (!aPlayed && bPlayed) return 1;
          if (aPlayed && bPlayed) return bPlayed - aPlayed;
          return a.displayName.localeCompare(b.displayName);
        });
      }
      const saves = scanSaves();
      return Response.json({ ...roms, saves });
    }

    // API: Status
    if (path === "/api/status" && req.method === "GET") {
      return Response.json({
        state: currentState,
        rom: currentRom ? prettifyName(currentRom) : undefined,
        error: lastError || undefined,
      });
    }

    // API: Launch ROM
    if (path === "/api/launch" && req.method === "POST") {
      try {
        const body = (await req.json()) as { platform: string; rom: string };
        if (!body.platform || !body.rom) {
          return Response.json({ ok: false, error: "Missing platform or rom" }, { status: 400 });
        }
        const romPath = join(DOLPHIN_DIR, body.platform, "roms", body.rom);
        if (!existsSync(romPath)) {
          return Response.json({ ok: false, error: "ROM not found" }, { status: 404 });
        }
        const result = await launchDolphin(romPath);
        return Response.json(result, { status: result.ok ? 200 : 500 });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: Launch GUI
    if (path === "/api/launch-ui" && req.method === "POST") {
      const result = await launchDolphin();
      return Response.json(result, { status: result.ok ? 200 : 500 });
    }

    // API: Restart (stop + relaunch same ROM with fresh settings)
    if (path === "/api/restart" && req.method === "POST") {
      if (currentState === "idle") {
        return Response.json({ ok: false, error: "Dolphin is not running" });
      }
      // Remember what was running
      const romName = currentRom;
      const wasGui = currentState === "dolphin-ui";
      // Find full ROM path before stopping
      let romPath: string | undefined;
      if (romName) {
        for (const platform of ["gamecube", "wii"]) {
          const candidate = join(DOLPHIN_DIR, platform, "roms", romName);
          if (existsSync(candidate)) { romPath = candidate; break; }
        }
      }

      // Stop current instance
      const stopResult = await stopDolphin();
      if (!stopResult.ok) {
        return Response.json({ ok: false, error: "Failed to stop: " + (stopResult.error || "unknown") });
      }

      // Wait for process to fully exit and kiosk to not interfere
      await new Promise((r) => setTimeout(r, 2000));

      // Relaunch
      if (romPath) {
        const result = await launchDolphin(romPath);
        return Response.json(result);
      } else {
        return Response.json({ ok: false, error: "Could not find original ROM to relaunch" });
      }
    }

    // API: Stop
    if (path === "/api/stop" && req.method === "POST") {
      const result = await stopDolphin();
      return Response.json(result);
    }

    // API: Get settings
    if (path === "/api/settings" && req.method === "GET") {
      return Response.json(readSettings());
    }

    // API: Save settings
    if (path === "/api/settings" && req.method === "POST") {
      try {
        const body = (await req.json()) as { changes: { file: string; section: string; key: string; value: string }[] };
        if (!body.changes || !Array.isArray(body.changes)) {
          return Response.json({ ok: false, error: "Missing changes array" }, { status: 400 });
        }
        // Validate filenames
        const allowedFiles = new Set(["GFX.ini", "Dolphin.ini", "GCPadNew.ini"]);
        for (const c of body.changes) {
          if (!allowedFiles.has(c.file)) {
            return Response.json({ ok: false, error: `Invalid config file: ${c.file}` }, { status: 400 });
          }
        }
        writeSettings(body.changes);
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: Download save file
    if (path === "/api/saves/download" && req.method === "GET") {
      const savePath = url.searchParams.get("path");
      if (!savePath) return Response.json({ error: "Missing path" }, { status: 400 });
      const fullPath = join(DOLPHIN_DIR, savePath);
      // Security: ensure path stays within DOLPHIN_DIR
      if (!fullPath.startsWith(DOLPHIN_DIR) || !existsSync(fullPath)) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
      const file = Bun.file(fullPath);
      return new Response(file, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${basename(fullPath)}"`,
        },
      });
    }

    // API: Delete save file
    if (path === "/api/saves/delete" && req.method === "POST") {
      try {
        const body = (await req.json()) as { path: string };
        if (!body.path) return Response.json({ ok: false, error: "Missing path" }, { status: 400 });
        const fullPath = join(DOLPHIN_DIR, body.path);
        // Security: ensure path stays within DOLPHIN_DIR and is a save file
        if (!fullPath.startsWith(DOLPHIN_DIR)) {
          return Response.json({ ok: false, error: "Invalid path" }, { status: 400 });
        }
        if (!existsSync(fullPath)) {
          return Response.json({ ok: false, error: "File not found" }, { status: 404 });
        }
        // Only allow deleting save files (GCI, save states, Wii NAND saves)
        const isInGC = fullPath.includes("/GC/");
        const isInStates = fullPath.includes("/StateSaves/");
        const isInWii = fullPath.includes("/Wii/title/") && fullPath.includes("/data/");
        if (!isInGC && !isInStates && !isInWii) {
          return Response.json({ ok: false, error: "Can only delete save files" }, { status: 400 });
        }
        unlinkSync(fullPath);
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: Get profiles + prev settings state
    if (path === "/api/profiles" && req.method === "GET") {
      return Response.json({
        profiles: loadProfiles(),
        hasPrev: existsSync(PREV_SETTINGS_FILE),
      });
    }

    // API: Save current settings as a profile
    if (path === "/api/profiles/save" && req.method === "POST") {
      try {
        const body = (await req.json()) as { name: string };
        const profiles = loadProfiles();
        if (profiles.length >= MAX_PROFILES) {
          return Response.json({ ok: false, error: "Maximum 5 profiles" }, { status: 400 });
        }
        profiles.push({
          name: body.name || "Profile " + (profiles.length + 1),
          createdAt: Date.now(),
          settings: snapshotSettings(),
        });
        saveProfiles(profiles);
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: Apply a profile
    if (path === "/api/profiles/apply" && req.method === "POST") {
      try {
        const body = (await req.json()) as { index: number };
        const profiles = loadProfiles();
        if (body.index < 0 || body.index >= profiles.length) {
          return Response.json({ ok: false, error: "Invalid profile index" }, { status: 400 });
        }
        // Backup current before applying
        savePrevSettings(snapshotSettings());
        applySnapshot(profiles[body.index].settings);
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: Delete a profile
    if (path === "/api/profiles/delete" && req.method === "POST") {
      try {
        const body = (await req.json()) as { index: number };
        const profiles = loadProfiles();
        if (body.index < 0 || body.index >= profiles.length) {
          return Response.json({ ok: false, error: "Invalid profile index" }, { status: 400 });
        }
        profiles.splice(body.index, 1);
        saveProfiles(profiles);
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: Backup current settings (called before save)
    if (path === "/api/settings/backup" && req.method === "POST") {
      try {
        savePrevSettings(snapshotSettings());
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: Revert to previous settings
    if (path === "/api/settings/revert" && req.method === "POST") {
      try {
        const prev = loadPrevSettings();
        if (!prev) {
          return Response.json({ ok: false, error: "No previous settings to revert to" }, { status: 400 });
        }
        applySnapshot(prev);
        // Remove previous settings file — one-shot revert only
        try { unlinkSync(PREV_SETTINGS_FILE); } catch {}
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // API: Hotplug mode
    if (path === "/api/hotplug") {
      if (req.method === "GET") {
        return Response.json({ enabled: hotplugMode });
      }
      if (req.method === "POST") {
        try {
          const body = await req.json() as { enabled: boolean };
          hotplugMode = !!body.enabled;
          saveHotplugMode();
          return Response.json({ ok: true, enabled: hotplugMode });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message }, { status: 400 });
        }
      }
    }

    // Health check
    if (path === "/health") {
      return Response.json({ status: "ok" });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`🐬 Dolphin Manager running on http://localhost:${PORT}`);
