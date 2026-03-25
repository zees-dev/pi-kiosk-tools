/**
 * gamepad-nav.js — Controller navigation for kiosk web UIs
 * 
 * Features:
 *   - D-pad spatial navigation between focusable elements
 *   - Left stick free cursor (virtual mouse)
 *   - Right stick scroll
 *   - A=click, B=back/close, L1=back, R1=forward, Start=OSK toggle
 *   - On-screen keyboard with gamepad navigation
 *   - Settings persisted via server API
 * 
 * Usage: <script src="http://127.0.0.1/gamepad-nav.js"></script>
 */
(function() {
  'use strict';
  if (window.GamepadNav) return; // Already loaded

  // ── Defaults ──────────────────────────────────────────────────────────
  const DEFAULTS = {
    cursorSpeed: 800,
    deadZone: 0.3,
    repeatInitial: 250,
    repeatRate: 100,
    scrollSpeed: 600,
    cursorSize: 20,
    cursorOpacity: 0.8,
    oskOpacity: 0.7,
    stickCursorEnabled: true,
    oskAutoOpen: true,
  };

  let settings = { ...DEFAULTS };
  let settingsLoaded = false;

  // ── Button indices (Standard Gamepad) ─────────────────────────────────
  const BTN = {
    A: 0, B: 1, X: 2, Y: 3,
    L1: 4, R1: 5, L2: 6, R2: 7,
    SELECT: 8, START: 9,
    L3: 10, R3: 11,
    UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
    HOME: 16,
  };

  // ── State ─────────────────────────────────────────────────────────────
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let cursorVisible = false;
  let cursorHideTimer = null;
  let focusedEl = null;
  let prevButtons = new Array(17).fill(false);
  let dpadRepeatTimers = {};
  let oskOpen = false;
  let oskFocusRow = 1;
  let oskFocusCol = 4;
  let lastTimestamp = 0;
  let gamepadActive = false;
  let disabled = false;

  // ── Detect if we should disable (e.g. EmulatorJS running) ─────────────
  function shouldDisable() {
    // EmulatorJS active
    if (window.EJS_emulator && window.EJS_emulator.game && window.EJS_emulator.game.canvas) return true;
    // Check for data attribute
    if (document.body && document.body.dataset.gamepadNavDisable === 'true') return true;
    return false;
  }

  // ── Settings API ──────────────────────────────────────────────────────
  async function loadSettings() {
    try {
      const resp = await fetch('http://127.0.0.1/api/gamepad/config', { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const saved = await resp.json();
        settings = { ...DEFAULTS, ...saved };
      }
    } catch {}
    settingsLoaded = true;
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    try {
      await fetch('http://127.0.0.1/api/gamepad/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
    } catch {}
  }

  // ── Cursor Element ────────────────────────────────────────────────────
  let cursorEl = null;
  function ensureCursor() {
    if (cursorEl) return;
    cursorEl = document.createElement('div');
    cursorEl.id = 'gamepad-cursor';
    cursorEl.style.cssText = 'position:fixed;z-index:99998;pointer-events:none;border-radius:50%;' +
      'background:rgba(74,158,255,0.8);border:2px solid #fff;' +
      'box-shadow:0 0 12px rgba(74,158,255,0.5);transition:opacity 0.3s;opacity:0;' +
      'transform:translate(-50%,-50%);';
    updateCursorStyle();
    document.body.appendChild(cursorEl);
  }

  function updateCursorStyle() {
    if (!cursorEl) return;
    const s = settings.cursorSize;
    cursorEl.style.width = s + 'px';
    cursorEl.style.height = s + 'px';
  }

  function showCursor() {
    ensureCursor();
    cursorEl.style.opacity = String(settings.cursorOpacity);
    cursorVisible = true;
    clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => {
      if (cursorEl) cursorEl.style.opacity = '0';
      cursorVisible = false;
    }, 3000);
  }

  function moveCursor(dx, dy) {
    cursorX = Math.max(0, Math.min(window.innerWidth, cursorX + dx));
    cursorY = Math.max(0, Math.min(window.innerHeight, cursorY + dy));
    if (cursorEl) {
      cursorEl.style.left = cursorX + 'px';
      cursorEl.style.top = cursorY + 'px';
    }
    showCursor();
  }

  // ── Focus Ring ────────────────────────────────────────────────────────
  let focusRingEl = null;
  function ensureFocusRing() {
    if (focusRingEl) return;
    focusRingEl = document.createElement('div');
    focusRingEl.id = 'gamepad-focus-ring';
    focusRingEl.style.cssText = 'position:fixed;z-index:99997;pointer-events:none;' +
      'border:2px solid #4a9eff;border-radius:8px;box-shadow:0 0 8px rgba(74,158,255,0.4);' +
      'transition:all 0.15s ease-out;opacity:0;';
    document.body.appendChild(focusRingEl);
  }

  function updateFocusRing(el) {
    ensureFocusRing();
    if (!el) {
      focusRingEl.style.opacity = '0';
      return;
    }
    const rect = el.getBoundingClientRect();
    const pad = 3;
    focusRingEl.style.left = (rect.left - pad) + 'px';
    focusRingEl.style.top = (rect.top - pad) + 'px';
    focusRingEl.style.width = (rect.width + pad * 2) + 'px';
    focusRingEl.style.height = (rect.height + pad * 2) + 'px';
    focusRingEl.style.opacity = '1';
    // Scroll into view
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── Focusable Elements ────────────────────────────────────────────────
  function getNavigableElements() {
    const custom = window.GAMEPAD_NAV && window.GAMEPAD_NAV.focusSelector;
    const selector = custom || 'button, a[href], [onclick], input, select, textarea, .app-card, .game-card, .setting-row, [data-nav]';
    const all = Array.from(document.querySelectorAll(selector));
    // Also check shadow DOMs
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        all.push(...Array.from(el.shadowRoot.querySelectorAll(selector)));
      }
    });
    return all.filter(el => {
      if (el.offsetParent === null && el.style.display !== 'fixed') return false; // hidden
      if (el.disabled) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return true;
    });
  }

  // ── Spatial Navigation ────────────────────────────────────────────────
  function spatialNav(direction) {
    const elements = getNavigableElements();
    if (!elements.length) return;

    if (!focusedEl || !elements.includes(focusedEl)) {
      focusedEl = elements[0];
      updateFocusRing(focusedEl);
      return;
    }

    const rect = focusedEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    let best = null;
    let bestDist = Infinity;

    for (const el of elements) {
      if (el === focusedEl) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;

      // Direction filter
      let valid = false;
      switch (direction) {
        case 'up':    valid = dy < -10; break;
        case 'down':  valid = dy > 10; break;
        case 'left':  valid = dx < -10; break;
        case 'right': valid = dx > 10; break;
      }
      if (!valid) continue;

      // Prefer elements in a cone (primary axis weighted more)
      const primaryDist = (direction === 'up' || direction === 'down') ? Math.abs(dy) : Math.abs(dx);
      const crossDist = (direction === 'up' || direction === 'down') ? Math.abs(dx) : Math.abs(dy);
      
      // Skip if too far off-axis (cone filter: cross < 2x primary)
      if (crossDist > primaryDist * 2.5) continue;

      const dist = primaryDist + crossDist * 0.5;
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }

    if (best) {
      focusedEl = best;
      updateFocusRing(focusedEl);
    }
  }

  // ── Click ─────────────────────────────────────────────────────────────
  function activateFocused() {
    if (cursorVisible && settings.stickCursorEnabled) {
      // Click under cursor
      const el = document.elementFromPoint(cursorX, cursorY);
      if (el) {
        el.click();
        el.focus && el.focus();
        // Auto-open OSK for inputs
        if (settings.oskAutoOpen && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
          if (!oskOpen) toggleOSK();
        }
        return;
      }
    }
    if (focusedEl) {
      focusedEl.click();
      focusedEl.focus && focusedEl.focus();
      // Auto-open OSK for inputs
      if (settings.oskAutoOpen && (focusedEl.tagName === 'INPUT' || focusedEl.tagName === 'TEXTAREA' || focusedEl.tagName === 'SELECT')) {
        if (!oskOpen) toggleOSK();
      }
    }
  }

  // ── Back / Close ──────────────────────────────────────────────────────
  function goBack() {
    // Try closing any open modal/overlay first
    const overlay = document.querySelector('.qr-overlay.open, [style*="display: block"][style*="position: absolute"], .modal.open');
    if (overlay) {
      const closeBtn = overlay.querySelector('[onclick*="close"], .close-btn, button:last-child');
      if (closeBtn) { closeBtn.click(); return; }
    }
    if (oskOpen) { toggleOSK(); return; }
    history.back();
  }

  // ── Scroll ────────────────────────────────────────────────────────────
  function scrollPage(dx, dy) {
    // Find nearest scrollable container
    let target = document.elementFromPoint(cursorX || window.innerWidth / 2, cursorY || window.innerHeight / 2);
    while (target && target !== document.body) {
      if (target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth) {
        target.scrollBy({ left: dx, top: dy });
        return;
      }
      target = target.parentElement;
    }
    window.scrollBy({ left: dx, top: dy });
  }

  // ── On-Screen Keyboard ────────────────────────────────────────────────
  const OSK_ROWS = [
    ['1','2','3','4','5','6','7','8','9','0','⌫'],
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l','↵'],
    ['⇧','z','x','c','v','b','n','m','.',','],
    ['','','Space','','←','→'],
  ];
  const OSK_ROWS_SHIFT = [
    ['!','@','#','$','%','^','&','*','(',')', '⌫'],
    ['Q','W','E','R','T','Y','U','I','O','P'],
    ['A','S','D','F','G','H','J','K','L','↵'],
    ['⇧','Z','X','C','V','B','N','M','?','/'],
    ['','','Space','','←','→'],
  ];

  let oskShift = false;
  let oskEl = null;

  function createOSK() {
    if (oskEl) return;
    oskEl = document.createElement('div');
    oskEl.id = 'gamepad-osk';
    oskEl.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;' +
      'padding:12px 8px;display:none;flex-direction:column;align-items:center;gap:6px;' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);';
    updateOSKStyle();
    document.body.appendChild(oskEl);
    renderOSK();
  }

  function updateOSKStyle() {
    if (!oskEl) return;
    const a = settings.oskOpacity;
    oskEl.style.background = 'rgba(15,15,15,' + a + ')';
  }

  function renderOSK() {
    if (!oskEl) return;
    const rows = oskShift ? OSK_ROWS_SHIFT : OSK_ROWS;
    let html = '';
    for (let r = 0; r < rows.length; r++) {
      html += '<div style="display:flex;gap:4px;justify-content:center">';
      for (let c = 0; c < rows[r].length; c++) {
        const key = rows[r][c];
        if (key === '') continue;
        const isSpace = key === 'Space';
        const isFocused = r === oskFocusRow && c === oskFocusCol;
        const w = isSpace ? '200px' : '36px';
        const bg = isFocused ? 'rgba(74,158,255,0.5)' : 'rgba(255,255,255,0.1)';
        const border = isFocused ? '2px solid #4a9eff' : '2px solid transparent';
        const label = isSpace ? '␣' : key;
        html += '<div data-osk-r="' + r + '" data-osk-c="' + c + '" style="' +
          'width:' + w + ';height:36px;display:flex;align-items:center;justify-content:center;' +
          'background:' + bg + ';border:' + border + ';border-radius:6px;' +
          'color:#e0e0e0;font-size:14px;font-weight:500;cursor:pointer;user-select:none;' +
          'transition:background 0.1s">' + label + '</div>';
      }
      html += '</div>';
    }
    oskEl.innerHTML = html;
    // Click handlers
    oskEl.querySelectorAll('[data-osk-r]').forEach(el => {
      el.addEventListener('click', () => {
        const r = parseInt(el.dataset.oskR);
        const c = parseInt(el.dataset.oskC);
        oskFocusRow = r;
        oskFocusCol = c;
        pressOSKKey(r, c);
        renderOSK();
      });
    });
  }

  function pressOSKKey(r, c) {
    const rows = oskShift ? OSK_ROWS_SHIFT : OSK_ROWS;
    if (r >= rows.length || c >= rows[r].length) return;
    const key = rows[r][c];
    if (key === '' || !key) return;
    
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');

    if (key === '⌫') {
      if (isInput) {
        const start = active.selectionStart || 0;
        if (start > 0) {
          active.value = active.value.slice(0, start - 1) + active.value.slice(start);
          active.selectionStart = active.selectionEnd = start - 1;
          active.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } else if (key === '↵') {
      if (isInput && active.tagName === 'INPUT') {
        active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        active.form && active.form.dispatchEvent(new Event('submit', { bubbles: true }));
      }
      toggleOSK();
    } else if (key === '⇧') {
      oskShift = !oskShift;
      renderOSK();
    } else if (key === '←') {
      if (isInput) {
        const pos = active.selectionStart || 0;
        active.selectionStart = active.selectionEnd = Math.max(0, pos - 1);
      }
    } else if (key === '→') {
      if (isInput) {
        const pos = active.selectionStart || 0;
        active.selectionStart = active.selectionEnd = Math.min(active.value.length, pos + 1);
      }
    } else if (key === 'Space') {
      if (isInput) {
        const start = active.selectionStart || 0;
        active.value = active.value.slice(0, start) + ' ' + active.value.slice(start);
        active.selectionStart = active.selectionEnd = start + 1;
        active.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      // Regular character
      if (isInput) {
        const start = active.selectionStart || 0;
        active.value = active.value.slice(0, start) + key + active.value.slice(start);
        active.selectionStart = active.selectionEnd = start + 1;
        active.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // Auto-unshift after typing
      if (oskShift && key !== '⇧') {
        oskShift = false;
        renderOSK();
      }
    }
  }

  function oskNav(direction) {
    const rows = oskShift ? OSK_ROWS_SHIFT : OSK_ROWS;
    switch (direction) {
      case 'up':
        oskFocusRow = Math.max(0, oskFocusRow - 1);
        break;
      case 'down':
        oskFocusRow = Math.min(rows.length - 1, oskFocusRow + 1);
        break;
      case 'left':
        // Skip empty keys
        do { oskFocusCol = Math.max(0, oskFocusCol - 1); }
        while (oskFocusCol > 0 && rows[oskFocusRow][oskFocusCol] === '');
        break;
      case 'right':
        do { oskFocusCol = Math.min(rows[oskFocusRow].length - 1, oskFocusCol + 1); }
        while (oskFocusCol < rows[oskFocusRow].length - 1 && rows[oskFocusRow][oskFocusCol] === '');
        break;
    }
    // Clamp col to row length
    if (oskFocusCol >= rows[oskFocusRow].length) oskFocusCol = rows[oskFocusRow].length - 1;
    // Skip empty
    while (oskFocusCol >= 0 && rows[oskFocusRow][oskFocusCol] === '') oskFocusCol--;
    if (oskFocusCol < 0) oskFocusCol = 0;
    renderOSK();
  }

  function toggleOSK() {
    createOSK();
    oskOpen = !oskOpen;
    oskEl.style.display = oskOpen ? 'flex' : 'none';
    if (oskOpen) {
      oskFocusRow = 1;
      oskFocusCol = 4;
      renderOSK();
    }
  }

  // ── D-pad Repeat ──────────────────────────────────────────────────────
  function startRepeat(direction, action) {
    stopRepeat(direction);
    action();
    dpadRepeatTimers[direction] = setTimeout(function repeat() {
      action();
      dpadRepeatTimers[direction] = setTimeout(repeat, settings.repeatRate);
    }, settings.repeatInitial);
  }

  function stopRepeat(direction) {
    if (dpadRepeatTimers[direction]) {
      clearTimeout(dpadRepeatTimers[direction]);
      delete dpadRepeatTimers[direction];
    }
  }

  // ── Main Loop ─────────────────────────────────────────────────────────
  function gameLoop(timestamp) {
    requestAnimationFrame(gameLoop);

    if (disabled || shouldDisable()) return;

    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const g of gamepads) {
      if (g && g.connected && g.buttons.length > 0) { gp = g; break; }
    }
    if (!gp) {
      if (gamepadActive) {
        gamepadActive = false;
        updateFocusRing(null);
      }
      return;
    }

    gamepadActive = true;
    const dt = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : 0.016;
    lastTimestamp = timestamp;

    const buttons = gp.buttons.map(b => b.pressed);
    const axes = gp.axes;

    // ── Button events (edge detection) ──────────────────────────────
    function justPressed(idx) {
      return idx < buttons.length && buttons[idx] && (idx >= prevButtons.length || !prevButtons[idx]);
    }
    function justReleased(idx) {
      return idx < prevButtons.length && prevButtons[idx] && (idx >= buttons.length || !buttons[idx]);
    }

    // A = click
    if (justPressed(BTN.A)) activateFocused();

    // B = back/close
    if (justPressed(BTN.B)) goBack();

    // L1 = browser back
    if (justPressed(BTN.L1)) history.back();

    // R1 = browser forward
    if (justPressed(BTN.R1)) history.forward();

    // Start = toggle OSK
    if (justPressed(BTN.START)) toggleOSK();

    // ── D-pad with repeat ───────────────────────────────────────────
    const dirs = [
      { btn: BTN.UP, dir: 'up' },
      { btn: BTN.DOWN, dir: 'down' },
      { btn: BTN.LEFT, dir: 'left' },
      { btn: BTN.RIGHT, dir: 'right' },
    ];
    for (const { btn, dir } of dirs) {
      if (justPressed(btn)) {
        const action = oskOpen ? () => oskNav(dir) : () => spatialNav(dir);
        startRepeat(dir, action);
      }
      if (justReleased(btn)) {
        stopRepeat(dir);
      }
    }

    // D-pad A on OSK
    if (oskOpen && justPressed(BTN.A)) {
      pressOSKKey(oskFocusRow, oskFocusCol);
    }

    // ── Left stick → cursor ─────────────────────────────────────────
    if (settings.stickCursorEnabled && axes.length >= 2) {
      const lx = Math.abs(axes[0]) > settings.deadZone ? axes[0] : 0;
      const ly = Math.abs(axes[1]) > settings.deadZone ? axes[1] : 0;
      if (lx !== 0 || ly !== 0) {
        moveCursor(lx * settings.cursorSpeed * dt, ly * settings.cursorSpeed * dt);
      }
    }

    // ── Right stick → scroll ────────────────────────────────────────
    if (axes.length >= 4) {
      const rx = Math.abs(axes[2]) > settings.deadZone ? axes[2] : 0;
      const ry = Math.abs(axes[3]) > settings.deadZone ? axes[3] : 0;
      if (rx !== 0 || ry !== 0) {
        scrollPage(rx * settings.scrollSpeed * dt, ry * settings.scrollSpeed * dt);
      }
    }

    // Save previous state
    prevButtons = buttons.slice();
  }

  // ── CSS Injection ─────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('gamepad-nav-styles')) return;
    const style = document.createElement('style');
    style.id = 'gamepad-nav-styles';
    style.textContent = `
      #gamepad-cursor { will-change: left, top, opacity; }
      #gamepad-focus-ring { will-change: left, top, width, height, opacity; }
      #gamepad-osk * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }
    `;
    document.head.appendChild(style);
  }

  // ── Public API ────────────────────────────────────────────────────────
  window.GamepadNav = {
    getSettings: () => ({ ...settings }),
    setSettings: (patch) => { settings = { ...settings, ...patch }; updateCursorStyle(); updateOSKStyle(); saveSettings(settings); },
    resetSettings: () => { settings = { ...DEFAULTS }; updateCursorStyle(); updateOSKStyle(); saveSettings(settings); },
    getState: () => {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      const result = [];
      for (const gp of gamepads) {
        if (!gp || !gp.connected) continue;
        result.push({
          id: gp.id,
          index: gp.index,
          buttons: gp.buttons.map(b => ({ pressed: b.pressed, value: b.value })),
          axes: Array.from(gp.axes),
        });
      }
      return result;
    },
    isActive: () => gamepadActive,
    disable: () => { disabled = true; },
    enable: () => { disabled = false; },
    toggleOSK: () => toggleOSK(),
  };

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    loadSettings();
    requestAnimationFrame(gameLoop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
