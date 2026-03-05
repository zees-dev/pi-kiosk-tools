/**
 * SpaghettiKart Manager - Single-file Bun fullstack server
 *
 * Web UI for managing SpaghettiKart (Mario Kart 64 PC port) on the Pi kiosk.
 * Launch/stop the game, configure settings, view connected controllers.
 *
 * Usage: bun run spaghetti-kart.ts
 * Then open http://localhost:3462
 */

import { serve, type Subprocess } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { hostname } from "os";

const PORT = 3462;
const BASE_DIR = import.meta.dir;
const GAME_DIR = "/home/pi/SpaghettiKart/build";
const BINARY = join(GAME_DIR, "Spaghettify");
const CFG_FILE = join(GAME_DIR, "spaghettify.cfg.json");
const PROFILES_FILE = join(BASE_DIR, "sk-profiles.json");
const PREV_SETTINGS_FILE = join(BASE_DIR, "sk-prev-settings.json");
const CAGE_BIN = "/run/current-system/sw/bin/cage";
const ENV_BIN = "/run/current-system/sw/bin/env";
const SUDO = "/run/wrappers/bin/sudo";
const PATH_ENV = "/run/current-system/sw/bin:/run/wrappers/bin:/usr/bin:/bin";

// ── State ───────────────────────────────────────────────────────────────────
let gameProc: Subprocess | null = null;
let gamePid: number | null = null;
let gameRunning = false;
let lastLaunchTime: number | null = null;

// ── Config helpers ──────────────────────────────────────────────────────────

function readConfig(): any {
  try {
    if (existsSync(CFG_FILE)) return JSON.parse(readFileSync(CFG_FILE, "utf-8"));
  } catch {}
  return { CVars: {}, Window: {} };
}

function writeConfig(cfg: any) {
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 4) + "\n");
}

function getCVar(cfg: any, key: string, def: any = null): any {
  if (cfg.CVars && key in cfg.CVars) return cfg.CVars[key];
  return def;
}

function setCVar(cfg: any, key: string, value: any) {
  if (!cfg.CVars) cfg.CVars = {};
  cfg.CVars[key] = value;
}

// ── Profiles ────────────────────────────────────────────────────────────────

interface SettingsProfile {
  name: string;
  createdAt: number;
  settings: Record<string, any>;
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

function loadPrevSettings(): Record<string, any> | null {
  try {
    if (existsSync(PREV_SETTINGS_FILE)) return JSON.parse(readFileSync(PREV_SETTINGS_FILE, "utf-8"));
  } catch {}
  return null;
}

function savePrevSettings(settings: Record<string, any>): void {
  try { writeFileSync(PREV_SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
}

function deletePrevSettings(): void {
  try { if (existsSync(PREV_SETTINGS_FILE)) require("fs").unlinkSync(PREV_SETTINGS_FILE); } catch {}
}

function getCurrentSettingsSnapshot(): Record<string, any> {
  const cfg = readConfig();
  const snap: Record<string, any> = {};
  for (const s of SETTINGS) snap[s.key] = getCVar(cfg, s.key, s.default);
  return snap;
}

// ── Settings definitions ────────────────────────────────────────────────────

interface Setting {
  key: string;
  label: string;
  type: "toggle" | "slider" | "select" | "snap-slider";
  tooltip?: string;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  snaps?: number[];
  options?: { value: any; label: string }[];
  section: string;
  disabledBy?: string; // key that disables this setting when truthy
}

const SETTINGS: Setting[] = [
  // Graphics
  { key: "gInterpolationFPS", label: "FPS", type: "snap-slider", section: "Graphics", min: 20, max: 240, step: 1, snaps: [45, 60, 120, 144, 240], default: 60, tooltip: "Interpolation FPS target", disabledBy: "gMatchRefreshRate" },
  { key: "gMatchRefreshRate", label: "Match Refresh Rate", type: "toggle", section: "Graphics", default: 0, tooltip: "Match FPS to display refresh rate (overrides FPS slider)", dynamicLabel: true },
  { key: "gVsyncEnabled", label: "VSync", type: "toggle", section: "Graphics", default: 1, tooltip: "Enable vertical sync" },
  { key: "gTextureFilter", label: "Texture Filter", type: "select", section: "Graphics", default: 0, options: [
    { value: 0, label: "Nearest" }, { value: 1, label: "Linear" }, { value: 2, label: "3-Point" }
  ], tooltip: "Texture filtering mode (needs reload)" },
  { key: "gStatsEnabled", label: "Show FPS Counter", type: "toggle", section: "Graphics", default: 1, tooltip: "Display FPS stats overlay" },
  { key: "gDisableLod", label: "No LOD (High Detail)", type: "toggle", section: "Graphics", default: 0, tooltip: "Disable Level of Detail — always use high-poly models" },
  { key: "gNoCulling", label: "Disable Culling", type: "toggle", section: "Graphics", default: 0, tooltip: "Disable original culling (may reduce performance)" },

  // Audio
  { key: "gGameMasterVolume", label: "Master Volume", type: "slider", section: "Audio", min: 0, max: 100, step: 1, default: 100 },
  { key: "gMainMusicVolume", label: "Music Volume", type: "slider", section: "Audio", min: 0, max: 100, step: 1, default: 100 },
  { key: "gSFXMusicVolume", label: "SFX Volume", type: "slider", section: "Audio", min: 0, max: 100, step: 1, default: 100 },
  { key: "gEnvironmentVolume", label: "Environment Volume", type: "slider", section: "Audio", min: 0, max: 100, step: 1, default: 100 },

  // Enhancements
  { key: "gMultiplayerNoFeatureCuts", label: "No Multiplayer Feature Cuts", type: "toggle", section: "Enhancements", default: 0, tooltip: "Full train and jumbotron in multiplayer" },
  { key: "gBetterResultPortraits", label: "Widescreen Portraits", type: "toggle", section: "Enhancements", default: 0, tooltip: "Better result portrait spacing on widescreen" },
  { key: "gDisableRubberbanding", label: "Disable Rubberbanding", type: "toggle", section: "Enhancements", default: 0, tooltip: "Disable AI rubberbanding" },
  { key: "gEnableCustomCC", label: "Custom CC", type: "toggle", section: "Enhancements", default: 0, tooltip: "Enable custom CC speed" },
  { key: "gCustomCC", label: "CC Value", type: "slider", section: "Enhancements", min: 0, max: 1000, step: 10, default: 150, tooltip: "Custom CC speed value" },
  { key: "gEnableDigitalSpeedometer", label: "Digital Speedometer", type: "toggle", section: "Enhancements", default: 0, tooltip: "Show digital speed readout" },
  { key: "gHarderCPU", label: "Harder CPU", type: "toggle", section: "Enhancements", default: 0, tooltip: "Make AI opponents harder" },
  { key: "gUniqueCharacterSelections", label: "Unique Characters", type: "toggle", section: "Enhancements", default: 1, tooltip: "Prevent players from selecting the same character" },
  { key: "gLookBehind", label: "Look Behind Camera", type: "toggle", section: "Enhancements", default: 0, tooltip: "Press C-Left to look behind you" },
  { key: "gSkipIntro", label: "Skip Intro", type: "toggle", section: "Enhancements", default: 0, tooltip: "Skip the intro sequence" },
  { key: "gShowSpaghettiVersion", label: "Show Version", type: "toggle", section: "Enhancements", default: 0, tooltip: "Show SpaghettiKart version text" },

  // Cheats
  { key: "gEnableMoonJump", label: "Moon Jump", type: "toggle", section: "Cheats", default: 0, tooltip: "Jump to the moon!" },
  { key: "gNoWallColision", label: "No Wall Collision", type: "toggle", section: "Cheats", default: 0, tooltip: "Drive through walls" },
  { key: "gMinHeight", label: "Min Height", type: "slider", section: "Cheats", min: -50, max: 50, step: 1, default: 0, tooltip: "Minimum height when wall collision off" },
  { key: "gDisableItemboxes", label: "No Itemboxes", type: "toggle", section: "Cheats", default: 0, tooltip: "Prevent itemboxes from spawning" },
  { key: "gAllThwompsAreMarty", label: "All Thwomps are Marty", type: "toggle", section: "Cheats", default: 0, tooltip: "All Thwomps are Marty" },
  { key: "gAllBombKartsChase", label: "Bomb Karts Chase Mode", type: "toggle", section: "Cheats", default: 0, tooltip: "All bomb karts will chase you!" },
  { key: "gGoFish", label: "Get the Trophies!", type: "toggle", section: "Cheats", default: 0, tooltip: "Collect trophies — racer with most wins!" },

  // Rulesets (under Cheats dropdown)
  { key: "gNumTrains", label: "Trains", type: "slider", section: "Rulesets", min: 0, max: 19, step: 1, default: 2 },
  { key: "gNumCarriages", label: "Carriages", type: "slider", section: "Rulesets", min: 0, max: 74, step: 1, default: 5 },
  { key: "gHasTender", label: "Train Tender", type: "toggle", section: "Rulesets", default: 1, tooltip: "Only valid with no carriages" },
  { key: "gNumTrucks", label: "Trucks", type: "slider", section: "Rulesets", min: 0, max: 50, step: 1, default: 7 },
  { key: "gNumBuses", label: "Buses", type: "slider", section: "Rulesets", min: 0, max: 50, step: 1, default: 7 },
  { key: "gNumTankerTrucks", label: "Tanker Trucks", type: "slider", section: "Rulesets", min: 0, max: 50, step: 1, default: 7 },
  { key: "gNumCars", label: "Cars", type: "slider", section: "Rulesets", min: 0, max: 50, step: 1, default: 7 },
];

// Defaults map for dirty detection
const DEFAULTS: Record<string, any> = {};
for (const s of SETTINGS) DEFAULTS[s.key] = s.default;

// ── Game lifecycle ──────────────────────────────────────────────────────────

function checkGameRunning(): boolean {
  try {
    const ps = execSync("ps aux", { env: { PATH: PATH_ENV }, timeout: 3000 }).toString();
    gameRunning = ps.includes("Spaghettify");
    if (!gameRunning) { gameProc = null; gamePid = null; }
    return gameRunning;
  } catch { return false; }
}

async function launchGame(): Promise<{ ok: boolean; error?: string }> {
  if (checkGameRunning()) return { ok: false, error: "Game is already running" };
  if (!existsSync(BINARY)) return { ok: false, error: "Spaghettify binary not found" };

  try {
    execSync(`${SUDO} mkdir -p /run/systemd/system/kiosk.service.d/`, { env: { PATH: PATH_ENV }, timeout: 5000 });
    execSync(`echo '[Service]\nExecStart=\nExecStart=/bin/true' | ${SUDO} tee /run/systemd/system/kiosk.service.d/disable.conf`, { env: { PATH: PATH_ENV }, timeout: 5000 });
    execSync(`${SUDO} systemctl daemon-reload`, { env: { PATH: PATH_ENV }, timeout: 5000 });
    execSync(`${SUDO} systemctl stop kiosk.service`, { env: { PATH: PATH_ENV }, timeout: 10000 });
    await new Promise(r => setTimeout(r, 1500));
    execSync(`${SUDO} systemctl restart seatd`, { env: { PATH: PATH_ENV }, timeout: 5000 });
    await new Promise(r => setTimeout(r, 1500));

    for (const d of ["mods", "logs", "saves"]) {
      const p = join(GAME_DIR, d);
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }

    // Ensure FPS counter on by default
    const cfg = readConfig();
    if (getCVar(cfg, "gStatsEnabled") === null) {
      setCVar(cfg, "gStatsEnabled", 1);
      writeConfig(cfg);
    }

    const cageArgs = ["-s", "-d", "--", "./Spaghettify"];
    const proc = Bun.spawn([SUDO, "-u", "kiosk", ENV_BIN,
      `XDG_RUNTIME_DIR=/run/user/1001`,
      `LIBSEAT_BACKEND=seatd`,
      `HOME=/var/cache/kiosk-home`,
      `SDL_VIDEODRIVER=wayland`,
      CAGE_BIN, ...cageArgs
    ], {
      cwd: GAME_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    gameProc = proc;
    gamePid = proc.pid;
    gameRunning = true;
    lastLaunchTime = Date.now();

    proc.exited.then(() => {
      gameRunning = false;
      gameProc = null;
      gamePid = null;
      restoreKiosk();
    });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function stopGame(): { ok: boolean; error?: string } {
  try {
    execSync(`${SUDO} pkill -INT -f Spaghettify`, { env: { PATH: PATH_ENV }, timeout: 3000 });
    setTimeout(() => {
      try { execSync(`${SUDO} pkill -9 -f Spaghettify`, { env: { PATH: PATH_ENV }, timeout: 3000 }); } catch {}
      try { execSync(`${SUDO} pkill -9 -f cage`, { env: { PATH: PATH_ENV }, timeout: 3000 }); } catch {}
      restoreKiosk();
    }, 3000);
    gameRunning = false;
    gameProc = null;
    gamePid = null;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function restoreKiosk() {
  try {
    execSync(`${SUDO} rm -rf /run/systemd/system/kiosk.service.d/`, { env: { PATH: PATH_ENV }, timeout: 5000 });
    execSync(`${SUDO} systemctl daemon-reload`, { env: { PATH: PATH_ENV }, timeout: 5000 });
    execSync(`${SUDO} systemctl restart seatd`, { env: { PATH: PATH_ENV }, timeout: 5000 });
    setTimeout(() => {
      try { execSync(`${SUDO} systemctl start kiosk.service`, { env: { PATH: PATH_ENV }, timeout: 10000 }); } catch {}
    }, 1500);
  } catch {}
}

// ── Controllers ─────────────────────────────────────────────────────────────

function getControllers(): { name: string; type: string; address?: string }[] {
  const controllers: { name: string; type: string; address?: string }[] = [];
  try {
    const raw = readFileSync("/proc/bus/input/devices", "utf-8");
    const blocks = raw.split("\n\n");
    for (const block of blocks) {
      const nameMatch = block.match(/N: Name="(.+)"/);
      const handlersMatch = block.match(/H: Handlers=(.+)/);
      if (!nameMatch || !handlersMatch) continue;
      const name = nameMatch[1];
      const handlers = handlersMatch[1];
      if (name.includes("Virtual Mouse") || name.includes("ydotool") || name.includes("Kiosk")) continue;
      if (name.includes("IMU") || name.includes("Accelerometer")) continue;
      const keyMatch = block.match(/B: KEY=(.+)/);
      if (!keyMatch) continue;
      const keyBits = keyMatch[1].split(" ");
      const hasJs = handlers.includes("js");
      let hasBtnSouth = false;
      if (keyBits.length >= 5) {
        const word = parseInt(keyBits[keyBits.length - 5], 16);
        hasBtnSouth = (word & (1 << (48 % 32))) !== 0;
      }
      if (!hasJs && !hasBtnSouth) continue;

      const uniqMatch = block.match(/U: Uniq=(\S+)/);
      let type = "Unknown";
      if (name.includes("Xbox") || name.includes("X-Box")) type = "Xbox";
      else if (name.includes("DualShock") || name.includes("DualSense") || name.includes("Wireless Controller")) type = "PlayStation";
      else if (name.includes("Pro Controller") || name.includes("Nintendo")) type = "Nintendo";
      else if (name.includes("GameSir") || name.includes("Nova")) type = "GameSir";
      else if (name.includes("Virtual Gamepad")) type = "Virtual";
      else type = "Gamepad";

      controllers.push({ name, type, address: uniqMatch?.[1] });
    }
  } catch {}
  return controllers;
}

// ── Version ─────────────────────────────────────────────────────────────────

function getVersion(): string {
  try {
    const out = execSync("cd /home/pi/SpaghettiKart && git describe --tags --always 2>/dev/null || echo 'dev'", { env: { PATH: PATH_ENV }, timeout: 3000 });
    return out.toString().trim();
  } catch { return "dev"; }
}

const VERSION = getVersion();

// ── HTML ────────────────────────────────────────────────────────────────────

function renderPage(): string {
  const cfg = readConfig();
  const running = checkGameRunning();
  const controllers = getControllers();
  const profiles = loadProfiles();
  const prevSettings = loadPrevSettings();

  // Build current settings map + dirty detection
  const currentSettings: Record<string, any> = {};
  let isDirty = false;
  for (const s of SETTINGS) {
    const val = getCVar(cfg, s.key, s.default);
    currentSettings[s.key] = val;
    if (val !== s.default) isDirty = true;
  }

  // Controllers rendered client-side via polling

  const uptime = running && lastLaunchTime ? Math.floor((Date.now() - lastLaunchTime) / 1000) : 0;
  const uptimeStr = uptime > 0 ? `${Math.floor(uptime / 60)}m ${uptime % 60}s` : "";

  // Profile cards
  let profilesHtml = "";
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    const date = new Date(p.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    profilesHtml += `<div class="profile-card" onclick="applyProfile(${i})" title="Apply: ${escapeHtml(p.name)}"><div><div class="profile-name">${escapeHtml(p.name)}</div><div class="profile-date">${date}</div></div><button class="profile-delete" onclick="event.stopPropagation();deleteProfile(${i})" title="Delete">✕</button></div>`;
  }
  if (profiles.length < 5) {
    profilesHtml += '<div class="profile-add" onclick="saveProfile()">+ Save Profile</div>';
  }

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spaghetti Kart</title>
<link rel="icon" href="/favicon.ico" type="image/x-icon">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:16px;max-width:600px;margin:0 auto;padding-bottom:80px}
.header-row{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.header-logo{width:56px;height:56px;border-radius:12px;object-fit:contain}
h1{font-size:22px;font-weight:700;margin-bottom:2px}
.version{color:#555;font-size:12px;font-weight:400}
.status-bar{background:#1a1a1a;border:1px solid #282828;border-radius:10px;padding:16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
.status-dot{width:10px;height:10px;border-radius:50%;margin-right:10px;flex-shrink:0}
.status-dot.on{background:#4caf50;box-shadow:0 0 8px #4caf5088}
.status-dot.off{background:#555}
.status-left{display:flex;align-items:center}
.status-text{font-size:14px;font-weight:500}
.status-uptime{color:#666;font-size:12px;margin-left:8px}
.btn{border:none;border-radius:8px;padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s}
.btn-launch{background:#4a9eff;color:#fff}
.btn-launch:hover{background:#3a8eef}
.btn-launch:disabled{background:#333;color:#666;cursor:not-allowed}
.btn-stop{background:#e53935;color:#fff}
.btn-stop:hover{background:#c62828}
.btn-stop:disabled{background:#333;color:#666;cursor:not-allowed}
.section-title{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#666;font-weight:600;margin:20px 0 10px;display:flex;align-items:center;gap:8px}
.dirty-dot{width:6px;height:6px;border-radius:50%;background:#FF9800;display:none}
.dirty-dot.visible{display:inline-block}
.settings-grid{background:#1a1a1a;border:1px solid #282828;border-radius:10px;padding:4px 14px;margin-bottom:4px}
.setting-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1f1f1f}
.setting-row:last-child{border-bottom:none}
.setting-row.disabled{opacity:0.35;pointer-events:none}
.setting-label{font-size:13px;color:#ccc;flex:1}
.toggle{position:relative;width:42px;height:24px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle .knob{position:absolute;top:0;left:0;right:0;bottom:0;background:#333;border-radius:12px;cursor:pointer;transition:.2s}
.toggle .knob:before{content:"";position:absolute;width:18px;height:18px;left:3px;bottom:3px;background:#888;border-radius:50%;transition:.2s}
.toggle input:checked+.knob{background:#4a9eff}
.toggle input:checked+.knob:before{transform:translateX(18px);background:#fff}
.slider-group{display:flex;align-items:center;gap:8px;flex-shrink:0}
.slider-group input[type=range]{width:100px;accent-color:#4a9eff}
.slider-val{font-size:12px;color:#888;min-width:30px;text-align:right}
select{background:#282828;color:#e0e0e0;border:1px solid #333;border-radius:6px;padding:4px 8px;font-size:12px}
.snap-pills{display:flex;gap:4px;flex-wrap:wrap;flex-shrink:0}
.snap-pill{background:#282828;border:1px solid #333;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer;color:#888;transition:all .15s;white-space:nowrap}
.snap-pill.active{background:#4a9eff;border-color:#4a9eff;color:#fff}
.snap-pill:hover:not(.active){border-color:#4a9eff;color:#ccc}
.controller-card{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#1a1a1a;border:1px solid #282828;border-radius:8px;margin-bottom:6px}
.ctrl-icon{font-size:20px}
.ctrl-info{flex:1;min-width:0}
.ctrl-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ctrl-type{font-size:11px;color:#666}
.empty-state{text-align:center;color:#555;font-size:13px;padding:20px}
.note{color:#555;font-size:11px;margin-top:6px;line-height:1.4}
.home-btn{position:fixed;bottom:16px;left:16px;width:40px;height:40px;border-radius:50%;background:#1a1a1a;border:1px solid #282828;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:18px;color:#888;transition:all .15s;z-index:10}
.home-btn:hover{background:#282828;color:#fff}
.dropdown-section{margin-bottom:4px}
.dropdown-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#1a1a1a;border:1px solid #282828;border-radius:10px;cursor:pointer;transition:all .15s;user-select:none}
.dropdown-header:hover{border-color:#333}
.dropdown-header .chevron{color:#555;font-size:10px;transition:transform .2s}
.dropdown-header.open .chevron{transform:rotate(180deg)}
.dropdown-header.open{border-radius:10px 10px 0 0;border-bottom-color:transparent}
.dropdown-body{display:none;background:#1a1a1a;border:1px solid #282828;border-top:none;border-radius:0 0 10px 10px;padding:0 14px}
.dropdown-body.open{display:block}
.profiles-section{margin-top:4px;margin-bottom:20px}
.profiles-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.defaults-btn{background:none;border:1px solid #333;color:#888;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.defaults-btn:hover:not(:disabled){border-color:#f4433688;color:#f44336}
.defaults-btn:disabled{opacity:0.3;cursor:not-allowed}
.save-btn{background:#4a9eff;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;display:none}
.save-btn:hover{background:#3a8eef}
.save-btn.visible{display:inline-block}
.save-btn:disabled{background:#333;color:#666;cursor:not-allowed}
.revert-btn{background:transparent;color:#aaa;border:1px solid #333;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:500;cursor:pointer;transition:all .2s}
.revert-btn:hover{border-color:#FF9800;color:#FF9800}
.revert-btn:disabled{opacity:0.3;cursor:not-allowed;pointer-events:none}
.profiles-grid{display:flex;flex-wrap:wrap;gap:8px}
.profile-card{display:flex;align-items:center;gap:8px;background:#1a1a1a;border:1px solid #282828;border-radius:8px;padding:10px 12px;cursor:pointer;transition:all .15s;min-width:140px;max-width:200px;flex:1}
.profile-card:hover{border-color:#4a9eff;background:#1e1e1e}
.profile-card .profile-name{flex:1;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.profile-card .profile-date{font-size:10px;color:#555}
.profile-card .profile-delete{background:none;border:none;color:#444;cursor:pointer;font-size:14px;padding:0 2px;line-height:1;flex-shrink:0}
.profile-card .profile-delete:hover{color:#ff4444}
.profile-add{display:flex;align-items:center;justify-content:center;background:transparent;border:2px dashed #333;border-radius:8px;padding:10px 12px;cursor:pointer;transition:all .15s;min-width:140px;max-width:200px;flex:1;color:#555;font-size:13px;gap:6px}
.profile-add:hover{border-color:#4a9eff;color:#4a9eff}
.toast{position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 20px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s;z-index:100;pointer-events:none}
.toast.show{opacity:1}
.toast.error{background:#c62828}
@media(max-width:400px){.slider-group input[type=range]{width:70px}.profile-card,.profile-add{min-width:120px}}
</style></head><body>
<div class="header-row">
  <img src="/logo.png" class="header-logo" alt="SpaghettiKart">
  <div><h1>Spaghetti Kart</h1><div class="version">v${VERSION} · Mario Kart 64 PC Port</div></div>
</div>

<div class="status-bar">
  <div class="status-left">
    <div class="status-dot ${running ? "on" : "off"}"></div>
    <span class="status-text">${running ? "Running" : "Stopped"}</span>
    ${running && uptimeStr ? `<span class="status-uptime">${uptimeStr}</span>` : ""}
  </div>
  ${running
    ? '<button class="btn btn-stop" onclick="stopGame()">Stop</button>'
    : '<button class="btn btn-launch" onclick="launchGame()">Launch</button>'}
</div>

<div class="section-title">Controllers</div>
<div id="controllers"></div>
<div class="note">SDL2 auto-detects controllers (incl. virtual pads). All controllers default to P1 — assign to other ports via in-game controller settings.</div>

<div class="section-title" id="graphicsTitle">Graphics <span class="dirty-dot" id="dirtyDot"></span></div>
<div class="settings-grid" id="graphicsGrid"></div>

<div class="section-title">Audio</div>
<div class="settings-grid" id="audioGrid"></div>

<div class="section-title">Enhancements</div>
<div class="settings-grid" id="enhancementsGrid"></div>

<div class="section-title">Cheats & Rulesets</div>
<div class="dropdown-section">
  <div class="dropdown-header" id="cheatsHeader" onclick="toggleDropdown('cheats')">
    <span>Cheats</span><span class="chevron">▾</span>
  </div>
  <div class="dropdown-body" id="cheatsBody"></div>
</div>
<div class="dropdown-section" style="margin-top:6px">
  <div class="dropdown-header" id="rulesetsHeader" onclick="toggleDropdown('rulesets')">
    <span>Rulesets (Traffic)</span><span class="chevron">▾</span>
  </div>
  <div class="dropdown-body" id="rulesetsBody"></div>
</div>

<div class="section-title" style="justify-content:space-between"><span>Profiles</span><div style="display:flex;gap:8px;align-items:center"><button class="defaults-btn" id="defaultsBtn" onclick="resetDefaults()">Defaults</button><button class="save-btn" id="saveBtn" onclick="saveSettings()">Save Changes</button></div></div>
<div class="profiles-section">
  <div class="profiles-row">
    <button class="revert-btn" id="revertBtn" onclick="revertSettings()" ${prevSettings ? "" : "disabled"}>↩ Revert</button>
  </div>
  <div class="profiles-grid" id="profilesGrid">${profilesHtml}</div>
</div>

<div class="note">Changes are not saved until you press Save. Some settings require a game restart to take effect.</div>

<a href="http://${hostname()}/" class="home-btn">⌂</a>
<div class="toast" id="toast"></div>

<script>
const SETTINGS = ${JSON.stringify(SETTINGS)};
const DEFAULTS = ${JSON.stringify(DEFAULTS)};
let currentSettings = ${JSON.stringify(currentSettings)};
let profiles = ${JSON.stringify(profiles)};

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function $(id) { return document.getElementById(id); }

function showToast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type === 'error' ? ' error' : '');
  setTimeout(() => t.className = 'toast', 2500);
}

// ── Dirty detection ───────────────────────────────────────────────────────
let savedSettings = JSON.parse(JSON.stringify(currentSettings));
let hasUnsaved = false;

function checkDirty() {
  // Check for unsaved changes (differs from last saved state)
  hasUnsaved = false;
  for (const key in savedSettings) {
    if (currentSettings[key] !== savedSettings[key]) { hasUnsaved = true; break; }
  }
  const dot = $('dirtyDot');
  if (dot) dot.className = 'dirty-dot' + (hasUnsaved ? ' visible' : '');
  const btn = $('saveBtn');
  if (btn) btn.className = 'save-btn' + (hasUnsaved ? ' visible' : '');

  // Disable defaults button if all settings already match defaults
  let isDefault = true;
  for (const key in DEFAULTS) {
    if (currentSettings[key] !== undefined && currentSettings[key] !== DEFAULTS[key]) { isDefault = false; break; }
  }
  const defBtn = $('defaultsBtn');
  if (defBtn) defBtn.disabled = isDefault;
}

// ── Setting renderers ─────────────────────────────────────────────────────
function renderSettingRow(s) {
  const val = currentSettings[s.key] ?? s.default;
  const tip = s.tooltip ? ' title="' + escHtml(s.tooltip) + '"' : '';
  const disabledClass = s.disabledBy && currentSettings[s.disabledBy] ? ' disabled' : '';

  if (s.type === 'toggle') {
    return '<div class="setting-row' + disabledClass + '" data-key="' + s.key + '"' + tip + '>' +
      '<span class="setting-label">' + s.label + '</span>' +
      '<label class="toggle"><input type="checkbox" ' + (val ? 'checked' : '') + ' onchange="setSetting(\\'' + s.key + '\\',this.checked?1:0)"><span class="knob"></span></label></div>';
  }
  if (s.type === 'slider') {
    return '<div class="setting-row' + disabledClass + '" data-key="' + s.key + '"' + tip + '>' +
      '<span class="setting-label">' + s.label + '</span>' +
      '<div class="slider-group"><input type="range" min="' + s.min + '" max="' + s.max + '" step="' + (s.step||1) + '" value="' + val + '" oninput="this.nextElementSibling.textContent=this.value;setSetting(\\'' + s.key + '\\',+this.value)"><span class="slider-val">' + val + '</span></div></div>';
  }
  if (s.type === 'snap-slider') {
    const snaps = s.snaps || [];
    const pills = snaps.map(v => '<span class="snap-pill' + (v === val ? ' active' : '') + '" onclick="setSnap(\\'' + s.key + '\\',' + v + ')">' + v + '</span>').join('');
    return '<div class="setting-row' + disabledClass + '" data-key="' + s.key + '"' + tip + '>' +
      '<span class="setting-label">' + s.label + '</span>' +
      '<div class="snap-pills" data-snap-key="' + s.key + '">' + pills + '</div></div>';
  }
  if (s.type === 'select') {
    const opts = (s.options||[]).map(o => '<option value="' + o.value + '"' + (o.value == val ? ' selected' : '') + '>' + o.label + '</option>').join('');
    return '<div class="setting-row' + disabledClass + '" data-key="' + s.key + '"' + tip + '>' +
      '<span class="setting-label">' + s.label + '</span>' +
      '<select onchange="setSetting(\\'' + s.key + '\\',+this.value)">' + opts + '</select></div>';
  }
  return '';
}

function renderAllSettings() {
  const groups = { Graphics: 'graphicsGrid', Audio: 'audioGrid', Enhancements: 'enhancementsGrid', Cheats: 'cheatsBody', Rulesets: 'rulesetsBody' };
  for (const [section, gridId] of Object.entries(groups)) {
    const grid = $(gridId);
    if (!grid) continue;
    const items = SETTINGS.filter(s => s.section === section);
    grid.innerHTML = items.map(renderSettingRow).join('');
  }
  checkDirty();
}

function updateDisabledStates() {
  for (const s of SETTINGS) {
    if (!s.disabledBy) continue;
    const row = document.querySelector('[data-key="' + s.key + '"]');
    if (row) {
      const isDisabled = currentSettings[s.disabledBy] ? true : false;
      row.classList.toggle('disabled', isDisabled);
    }
  }
}

// ── Actions ───────────────────────────────────────────────────────────────
function setSetting(key, value) {
  currentSettings[key] = value;
  checkDirty();
  updateDisabledStates();
}

async function saveSettings() {
  const btn = $('saveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    const resp = await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ settings: currentSettings }) });
    const data = await resp.json();
    if (data.ok) {
      savedSettings = JSON.parse(JSON.stringify(currentSettings));
      checkDirty();
      showToast('Settings saved');
    } else showToast(data.error || 'Save failed', 'error');
  } catch { showToast('Save failed', 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
}

async function resetDefaults() {
  if (!confirm('Reset all settings to defaults? This will save immediately.')) return;
  try {
    const resp = await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ settings: JSON.parse(JSON.stringify(DEFAULTS)) }) });
    const data = await resp.json();
    if (data.ok) {
      currentSettings = JSON.parse(JSON.stringify(DEFAULTS));
      savedSettings = JSON.parse(JSON.stringify(DEFAULTS));
      renderAllSettings();
      showToast('Settings reset to defaults');
    } else showToast(data.error || 'Reset failed', 'error');
  } catch { showToast('Reset failed', 'error'); }
}

function setSnap(key, value) {
  setSetting(key, value);
  const container = document.querySelector('[data-snap-key="' + key + '"]');
  if (container) {
    container.querySelectorAll('.snap-pill').forEach(p => p.classList.toggle('active', +p.textContent === value));
  }
}

function toggleDropdown(id) {
  const header = $(id + 'Header');
  const body = $(id + 'Body');
  if (!header || !body) return;
  const isOpen = header.classList.toggle('open');
  body.classList.toggle('open', isOpen);
}

async function launchGame() {
  const btn = document.querySelector('.btn-launch');
  if (btn) { btn.disabled = true; btn.textContent = 'Launching...'; }
  const r = await fetch('/api/launch', { method: 'POST' });
  const d = await r.json();
  if (d.ok) { showToast('Launching...'); setTimeout(() => location.reload(), 2000); }
  else { showToast(d.error || 'Launch failed', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Launch'; } }
}

async function stopGame() {
  const btn = document.querySelector('.btn-stop');
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping...'; }
  await fetch('/api/stop', { method: 'POST' });
  showToast('Stopping...');
  setTimeout(() => location.reload(), 4000);
}

// ── Profiles ──────────────────────────────────────────────────────────────
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
  const resp = await fetch('/api/profiles/save', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
  const data = await resp.json();
  if (data.ok) { profiles = data.profiles; renderProfiles(); showToast('Saved: ' + name); }
  else showToast(data.error || 'Failed', 'error');
}

async function applyProfile(index) {
  const p = profiles[index];
  if (!confirm('Apply profile "' + p.name + '"? Current settings will be backed up for revert.')) return;
  const resp = await fetch('/api/profiles/apply', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ index }) });
  const data = await resp.json();
  if (data.ok) {
    currentSettings = data.settings;
    renderAllSettings();
    $('revertBtn').disabled = false;
    showToast('Applied: ' + p.name);
  } else showToast(data.error || 'Failed', 'error');
}

async function deleteProfile(index) {
  if (!confirm('Delete profile "' + profiles[index].name + '"?')) return;
  const resp = await fetch('/api/profiles/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ index }) });
  const data = await resp.json();
  if (data.ok) { profiles = data.profiles; renderProfiles(); showToast('Deleted'); }
  else showToast(data.error || 'Failed', 'error');
}

async function revertSettings() {
  if (!confirm('Revert to previous settings? This is a one-shot revert.')) return;
  const resp = await fetch('/api/profiles/revert', { method: 'POST' });
  const data = await resp.json();
  if (data.ok) {
    currentSettings = data.settings;
    renderAllSettings();
    $('revertBtn').disabled = true;
    showToast('Reverted to previous settings');
  } else showToast(data.error || 'Nothing to revert', 'error');
}

// ── Controllers polling ───────────────────────────────────────────────────
const TYPE_ICONS = { Xbox: '🟢', PlayStation: '🔵', Nintendo: '🔴', GameSir: '🟠', Virtual: '🟣', Gamepad: '⚪', Unknown: '⚪' };
let lastControllersJson = '';

async function pollControllers() {
  try {
    const resp = await fetch('/api/controllers');
    const ctrls = await resp.json();
    const json = JSON.stringify(ctrls);
    if (json === lastControllersJson) return;
    lastControllersJson = json;
    const container = $('controllers');
    if (!container) return;
    if (!ctrls.length) {
      container.innerHTML = '<div class="empty-state">No controllers detected</div>';
      return;
    }
    container.innerHTML = ctrls.map((c, i) => {
      const icon = TYPE_ICONS[c.type] || '⚪';
      const slot = 'P' + (i + 1);
      const badge = c.type === 'Virtual' ? ' <span style="color:#666;font-size:10px">(virtual)</span>' : '';
      return '<div class="controller-card"><span class="ctrl-icon">' + icon + '</span><div class="ctrl-info"><div class="ctrl-name"><span style="color:#4a9eff;font-size:11px;margin-right:6px">' + slot + '</span>' + c.name + badge + '</div><div class="ctrl-type">' + c.type + (c.address ? ' · ' + c.address : '') + '</div></div></div>';
    }).join('');
  } catch {}
}

pollControllers();
setInterval(pollControllers, 2000);

// Fetch display refresh rate and update Match Refresh Rate label
fetch('http://' + location.hostname + '/api/display').then(r => r.json()).then(d => {
  if (d.currentHz) {
    const row = document.querySelector('[data-key="gMatchRefreshRate"]');
    if (row) {
      const label = row.querySelector('.setting-label');
      if (label) label.textContent = 'Match Refresh Rate (' + d.currentHz + ' Hz)';
    }
  }
}).catch(() => {});

// ── Init ──────────────────────────────────────────────────────────────────
renderAllSettings();

// Auto-refresh status
setInterval(async () => {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    if (dot) dot.className = 'status-dot ' + (d.running ? 'on' : 'off');
    if (text) text.textContent = d.running ? 'Running' : 'Stopped';
  } catch {}
}, 5000);

// Reset unsaved changes on bfcache restore or page reload
window.addEventListener('pageshow', async (e) => {
  if (e.persisted) {
    try {
      const r = await fetch('/api/settings');
      const saved = await r.json();
      currentSettings = saved;
      savedSettings = JSON.parse(JSON.stringify(saved));
      renderAllSettings();
    } catch {}
  }
});
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Server ──────────────────────────────────────────────────────────────────

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/api/status") {
      const running = checkGameRunning();
      return Response.json({
        running,
        pid: gamePid,
        uptime: running && lastLaunchTime ? Math.floor((Date.now() - lastLaunchTime) / 1000) : 0,
        version: VERSION,
      });
    }

    if (url.pathname === "/api/controllers") {
      const ctrls = getControllers();
      // Hardware first, virtual last
      ctrls.sort((a, b) => {
        const aVirt = a.type === "Virtual" ? 1 : 0;
        const bVirt = b.type === "Virtual" ? 1 : 0;
        return aVirt - bVirt;
      });
      return Response.json(ctrls);
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const cfg = readConfig();
      const settings: Record<string, any> = {};
      for (const s of SETTINGS) settings[s.key] = getCVar(cfg, s.key, s.default);
      return Response.json(settings);
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        // Bulk save: { settings: { key: value, ... } }
        if (body.settings && typeof body.settings === "object") {
          const cfg = readConfig();
          for (const [key, value] of Object.entries(body.settings)) {
            const valid = SETTINGS.find(s => s.key === key);
            if (valid) setCVar(cfg, key, value);
          }
          writeConfig(cfg);
          return Response.json({ ok: true });
        }
        // Single setting (legacy/compat)
        const { key, value } = body;
        const valid = SETTINGS.find(s => s.key === key);
        if (!valid) return Response.json({ ok: false, error: "Unknown setting" }, { status: 400 });
        const cfg = readConfig();
        setCVar(cfg, key, value);
        writeConfig(cfg);
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/launch" && req.method === "POST") {
      const result = await launchGame();
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      const result = stopGame();
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    // Profiles
    if (url.pathname === "/api/profiles" && req.method === "GET") {
      return Response.json(loadProfiles());
    }

    if (url.pathname === "/api/profiles/save" && req.method === "POST") {
      try {
        const { name } = await req.json() as { name: string };
        const profiles = loadProfiles();
        if (profiles.length >= 5) return Response.json({ ok: false, error: "Max 5 profiles" }, { status: 400 });
        const snap = getCurrentSettingsSnapshot();
        profiles.push({ name, createdAt: Date.now(), settings: snap });
        saveProfiles(profiles);
        return Response.json({ ok: true, profiles });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/profiles/apply" && req.method === "POST") {
      try {
        const { index } = await req.json() as { index: number };
        const profiles = loadProfiles();
        if (index < 0 || index >= profiles.length) return Response.json({ ok: false, error: "Invalid index" }, { status: 400 });

        // Save current as revert point
        savePrevSettings(getCurrentSettingsSnapshot());

        // Apply profile
        const cfg = readConfig();
        for (const [key, value] of Object.entries(profiles[index].settings)) {
          setCVar(cfg, key, value);
        }
        writeConfig(cfg);

        const settings: Record<string, any> = {};
        for (const s of SETTINGS) settings[s.key] = getCVar(cfg, s.key, s.default);
        return Response.json({ ok: true, settings });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/profiles/delete" && req.method === "POST") {
      try {
        const { index } = await req.json() as { index: number };
        const profiles = loadProfiles();
        if (index < 0 || index >= profiles.length) return Response.json({ ok: false, error: "Invalid index" }, { status: 400 });
        profiles.splice(index, 1);
        saveProfiles(profiles);
        return Response.json({ ok: true, profiles });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/profiles/revert" && req.method === "POST") {
      try {
        const prev = loadPrevSettings();
        if (!prev) return Response.json({ ok: false, error: "Nothing to revert" }, { status: 400 });

        // Save current as new revert point before reverting? No — destructive one-shot.
        const cfg = readConfig();
        for (const [key, value] of Object.entries(prev)) {
          setCVar(cfg, key, value);
        }
        writeConfig(cfg);
        deletePrevSettings();

        const settings: Record<string, any> = {};
        for (const s of SETTINGS) settings[s.key] = getCVar(cfg, s.key, s.default);
        return Response.json({ ok: true, settings });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // Static assets
    const STATIC_FILES: Record<string, { path: string; type: string }> = {
      "/logo.png": { path: join(BASE_DIR, "logo.png"), type: "image/png" },
      "/icon.png": { path: join(BASE_DIR, "icon.png"), type: "image/png" },
      "/favicon.ico": { path: join(BASE_DIR, "favicon.ico"), type: "image/x-icon" },
    };
    if (STATIC_FILES[url.pathname]) {
      const { path, type } = STATIC_FILES[url.pathname];
      if (existsSync(path)) {
        return new Response(Bun.file(path), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" } });
      }
    }

    // Serve main page
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(renderPage(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`🍝 SpaghettiKart Manager running on http://localhost:${PORT}`);
