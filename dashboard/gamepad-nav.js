/**
 * gamepad-nav.js — Controller navigation for kiosk web UIs
 * 
 * Connects to virtual-pad WebSocket (/ws/view) for normalized input from
 * ALL controller types (hardware, Bluetooth, virtual). No Gamepad API needed.
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
  if (window.GamepadNav) return;

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

  // ── Button bitmask (matches virtual-pad protocol) ─────────────────────
  const BTN = {
    A: 0, B: 1, X: 2, Y: 3,
    L1: 4, R1: 5, L2: 6, R2: 7,
    SELECT: 8, START: 9,
    L3: 10, R3: 11,
    UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
    HOME: 16,
  };

  // ── State ─────────────────────────────────────────────────────────────
  let cursorX = 0, cursorY = 0, cursorInited = false;
  let cursorVisible = false;
  let cursorHideTimer = null;
  let focusedEl = null;
  let prevButtons = 0;
  let prevAxes = [128, 128, 128, 128, 0, 0]; // LX, LY, RX, RY, L2, R2
  let dpadRepeatTimers = {};
  let oskOpen = false;
  let oskFocusRow = 1, oskFocusCol = 4;
  let lastFrameTime = 0;
  let gamepadActive = false;
  let disabled = false;
  let ws = null;
  let wsReconnectTimer = null;
  let latestControllers = []; // for getState() API

  // ── Detect if we should disable ───────────────────────────────────────
  function shouldDisable() {
    if (window.EJS_emulator && window.EJS_emulator.game && window.EJS_emulator.game.canvas) return true;
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
  }

  async function saveSettings(s) {
    settings = { ...settings, ...s };
    try {
      await fetch('http://127.0.0.1/api/gamepad/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
    } catch {}
  }

  // ── WebSocket to virtual-pad ──────────────────────────────────────────
  function connectWS() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try {
      // Use wss for port 3461
      ws = new WebSocket('wss://127.0.0.1:3461/ws/view');
      ws.onopen = () => {
        gamepadActive = true;
        console.log('[gamepad-nav] Connected to virtual-pad');
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          handleMessage(msg);
        } catch {}
      };
      ws.onclose = () => {
        gamepadActive = false;
        scheduleReconnect();
      };
      ws.onerror = () => {
        scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connectWS();
    }, 3000);
  }

  // ── Handle messages from virtual-pad ──────────────────────────────────
  function handleMessage(msg) {
    if (disabled || shouldDisable()) return;

    if (msg.type === 'full') {
      latestControllers = [...(msg.players || []), ...(msg.hw || [])];
      // Process first controller with state
      const first = latestControllers.find(c => c.state);
      if (first) processState(first.state);
    } else if (msg.type === 'player' && msg.state) {
      updateControllerList(msg);
      processState(msg.state);
    } else if (msg.type === 'hw' && msg.state) {
      updateControllerList(msg);
      processState(msg.state);
    } else if (msg.type === 'connect' || msg.type === 'disconnect') {
      // Just update list, no state to process
    }
  }

  function updateControllerList(msg) {
    // Keep a running list for getState() API
    const key = msg.slot ? 'p' + msg.slot : msg.eventPath;
    const idx = latestControllers.findIndex(c => (c.slot ? 'p' + c.slot : c.eventPath) === key);
    if (idx >= 0) latestControllers[idx] = msg;
    else latestControllers.push(msg);
  }

  // ── Process normalized state (10-12 byte array) ───────────────────────
  function processState(state) {
    if (!state || state.length < 10) return;

    const now = performance.now();
    const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0.016;
    lastFrameTime = now;

    // Decode
    const buttons = state[0] | (state[1] << 8) | (state[2] << 16) | (state[3] << 24);
    const axes = [state[4], state[5], state[6], state[7], state[8], state[9]];

    // ── Button edge detection ───────────────────────────────────────
    function justPressed(bit) { return (buttons & (1 << bit)) && !(prevButtons & (1 << bit)); }
    function justReleased(bit) { return !(buttons & (1 << bit)) && (prevButtons & (1 << bit)); }

    // ── Custom confirm dialog navigation ────────────────────────────
    if (isConfirmOpen()) {
      if (justPressed(BTN.LEFT) || justPressed(BTN.RIGHT)) {
        confirmFocus = confirmFocus === 0 ? 1 : 0;
        updateConfirmFocus();
      }
      if (justPressed(BTN.A)) resolveConfirm(confirmFocus === 1);
      if (justPressed(BTN.B)) resolveConfirm(false);
      prevButtons = buttons;
      prevAxes = axes;
      return; // Don't process other inputs while confirm is open
    }

    // A = click
    if (justPressed(BTN.A)) {
      if (oskOpen) {
        pressOSKKey(oskFocusRow, oskFocusCol);
      } else {
        activateFocused();
      }
    }

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
      { bit: BTN.UP, dir: 'up' },
      { bit: BTN.DOWN, dir: 'down' },
      { bit: BTN.LEFT, dir: 'left' },
      { bit: BTN.RIGHT, dir: 'right' },
    ];
    for (const { bit, dir } of dirs) {
      if (justPressed(bit)) {
        let action;
        if (oskOpen) {
          action = () => oskNav(dir);
        } else if (focusedEl && focusedEl.tagName === 'INPUT' && focusedEl.type === 'range' && (dir === 'left' || dir === 'right')) {
          // Adjust slider value with d-pad left/right
          action = () => {
            const step = parseFloat(focusedEl.step) || 1;
            const delta = dir === 'right' ? step : -step;
            focusedEl.value = String(Math.min(parseFloat(focusedEl.max), Math.max(parseFloat(focusedEl.min), parseFloat(focusedEl.value) + delta)));
            focusedEl.dispatchEvent(new Event('input', { bubbles: true }));
            focusedEl.dispatchEvent(new Event('change', { bubbles: true }));
          };
        } else if (focusedEl && focusedEl.tagName === 'SELECT' && (dir === 'up' || dir === 'down')) {
          // Cycle select options with d-pad up/down
          action = () => {
            const delta = dir === 'down' ? 1 : -1;
            focusedEl.selectedIndex = Math.max(0, Math.min(focusedEl.options.length - 1, focusedEl.selectedIndex + delta));
            focusedEl.dispatchEvent(new Event('change', { bubbles: true }));
          };
        } else {
          action = () => spatialNav(dir);
        }
        startRepeat(dir, action);
      }
      if (justReleased(bit)) {
        stopRepeat(dir);
      }
    }

    // ── Left stick → cursor ─────────────────────────────────────────
    if (settings.stickCursorEnabled) {
      const lx = (axes[0] - 128) / 128; // -1 to 1
      const ly = (axes[1] - 128) / 128;
      const alx = Math.abs(lx) > settings.deadZone ? lx : 0;
      const aly = Math.abs(ly) > settings.deadZone ? ly : 0;
      if (alx !== 0 || aly !== 0) {
        moveCursor(alx * settings.cursorSpeed * dt, aly * settings.cursorSpeed * dt);
      }
    }

    // ── Right stick → scroll ────────────────────────────────────────
    const rx = (axes[2] - 128) / 128;
    const ry = (axes[3] - 128) / 128;
    const arx = Math.abs(rx) > settings.deadZone ? rx : 0;
    const ary = Math.abs(ry) > settings.deadZone ? ry : 0;
    if (arx !== 0 || ary !== 0) {
      scrollPage(arx * settings.scrollSpeed * dt, ary * settings.scrollSpeed * dt);
      syncFocusRing();
    }

    prevButtons = buttons;
    prevAxes = axes;
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
    cursorEl.style.width = settings.cursorSize + 'px';
    cursorEl.style.height = settings.cursorSize + 'px';
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
    if (!cursorInited) {
      cursorX = window.innerWidth / 2;
      cursorY = window.innerHeight / 2;
      cursorInited = true;
    }
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
    if (!el) { focusRingEl.style.opacity = '0'; return; }
    // Instant scroll to keep up with rapid d-pad
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const pad = 3;
    focusRingEl.style.left = (rect.left - pad) + 'px';
    focusRingEl.style.top = (rect.top - pad) + 'px';
    focusRingEl.style.width = (rect.width + pad * 2) + 'px';
    focusRingEl.style.height = (rect.height + pad * 2) + 'px';
    focusRingEl.style.opacity = '1';
  }

  // ── Focusable Elements ────────────────────────────────────────────────
  function getNavigableElements() {
    const custom = window.GAMEPAD_NAV && window.GAMEPAD_NAV.focusSelector;
    const selector = custom || 'button, a[href], [onclick], input, select, textarea, .app-card, .game-card, .setting-row, .remote-btn, .remote-half, h1, [data-nav]';
    const all = Array.from(document.querySelectorAll(selector));
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) all.push(...Array.from(el.shadowRoot.querySelectorAll(selector)));
    });
    return all.filter(el => {
      if (el.offsetParent === null && el.style.position !== 'fixed') return false;
      if (el.disabled) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
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

    let best = null, bestDist = Infinity;

    for (const el of elements) {
      if (el === focusedEl) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx, dy = ey - cy;

      let valid = false;
      switch (direction) {
        case 'up':    valid = dy < -10; break;
        case 'down':  valid = dy > 10; break;
        case 'left':  valid = dx < -10; break;
        case 'right': valid = dx > 10; break;
      }
      if (!valid) continue;

      const primaryDist = (direction === 'up' || direction === 'down') ? Math.abs(dy) : Math.abs(dx);
      const crossDist = (direction === 'up' || direction === 'down') ? Math.abs(dx) : Math.abs(dy);
      if (crossDist > primaryDist * 2.5) continue;

      const dist = primaryDist + crossDist * 0.5;
      if (dist < bestDist) { bestDist = dist; best = el; }
    }

    if (best) { focusedEl = best; updateFocusRing(focusedEl); }
  }

  // ── Click ─────────────────────────────────────────────────────────────
  function simulateClick(el, x, y) {
    // Dispatch full mouse event sequence at coordinates
    const opts = { bubbles: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function clickElement(el, fromCursor) {
    if (!el) return;
    // For <select>, cycle to next option on A press
    if (el.tagName === 'SELECT') {
      el.focus();
      const idx = el.selectedIndex;
      el.selectedIndex = (idx + 1) % el.options.length;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // For canvas/interactive elements, use full mouse event sequence with coordinates
    if (fromCursor) {
      simulateClick(el, cursorX, cursorY);
    } else {
      el.click();
    }
    if (el.focus) el.focus();
    if (settings.oskAutoOpen && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'checkbox' && el.type !== 'radio'))) {
      if (!oskOpen) toggleOSK();
    }
  }

  function activateFocused() {
    if (cursorVisible && settings.stickCursorEnabled) {
      const el = document.elementFromPoint(cursorX, cursorY);
      if (el) { clickElement(el, true); return; }
    }
    if (focusedEl) clickElement(focusedEl, false);
  }

  // ── Back / Close ──────────────────────────────────────────────────────
  function goBack() {
    if (oskOpen) { toggleOSK(); return; }
    const overlay = document.querySelector('.qr-overlay.open, .modal-overlay.open');
    if (overlay) {
      const closeBtn = overlay.querySelector('.modal-close, .qr-close, [onclick*="close"]');
      if (closeBtn) { closeBtn.click(); return; }
    }
    history.back();
  }

  // ── Scroll ────────────────────────────────────────────────────────────
  function scrollPage(dx, dy) {
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

  let oskShift = false, oskEl = null;

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
    oskEl.style.background = 'rgba(15,15,15,' + settings.oskOpacity + ')';
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
    oskEl.querySelectorAll('[data-osk-r]').forEach(el => {
      el.addEventListener('click', () => {
        oskFocusRow = parseInt(el.dataset.oskR);
        oskFocusCol = parseInt(el.dataset.oskC);
        pressOSKKey(oskFocusRow, oskFocusCol);
        renderOSK();
      });
    });
  }

  function pressOSKKey(r, c) {
    const rows = oskShift ? OSK_ROWS_SHIFT : OSK_ROWS;
    if (r >= rows.length || c >= rows[r].length) return;
    const key = rows[r][c];
    if (!key) return;
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
        if (active.form) active.form.dispatchEvent(new Event('submit', { bubbles: true }));
      }
      toggleOSK();
    } else if (key === '⇧') {
      oskShift = !oskShift;
      renderOSK();
    } else if (key === '←') {
      if (isInput) active.selectionStart = active.selectionEnd = Math.max(0, (active.selectionStart || 0) - 1);
    } else if (key === '→') {
      if (isInput) active.selectionStart = active.selectionEnd = Math.min(active.value.length, (active.selectionStart || 0) + 1);
    } else if (key === 'Space') {
      if (isInput) {
        const start = active.selectionStart || 0;
        active.value = active.value.slice(0, start) + ' ' + active.value.slice(start);
        active.selectionStart = active.selectionEnd = start + 1;
        active.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      if (isInput) {
        const start = active.selectionStart || 0;
        active.value = active.value.slice(0, start) + key + active.value.slice(start);
        active.selectionStart = active.selectionEnd = start + 1;
        active.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (oskShift && key !== '⇧') { oskShift = false; renderOSK(); }
    }
  }

  function oskNav(direction) {
    const rows = oskShift ? OSK_ROWS_SHIFT : OSK_ROWS;
    switch (direction) {
      case 'up': oskFocusRow = Math.max(0, oskFocusRow - 1); break;
      case 'down': oskFocusRow = Math.min(rows.length - 1, oskFocusRow + 1); break;
      case 'left':
        do { oskFocusCol = Math.max(0, oskFocusCol - 1); }
        while (oskFocusCol > 0 && rows[oskFocusRow][oskFocusCol] === '');
        break;
      case 'right':
        do { oskFocusCol = Math.min(rows[oskFocusRow].length - 1, oskFocusCol + 1); }
        while (oskFocusCol < rows[oskFocusRow].length - 1 && rows[oskFocusRow][oskFocusCol] === '');
        break;
    }
    if (oskFocusCol >= rows[oskFocusRow].length) oskFocusCol = rows[oskFocusRow].length - 1;
    while (oskFocusCol >= 0 && rows[oskFocusRow][oskFocusCol] === '') oskFocusCol--;
    if (oskFocusCol < 0) oskFocusCol = 0;
    renderOSK();
  }

  function toggleOSK() {
    createOSK();
    oskOpen = !oskOpen;
    oskEl.style.display = oskOpen ? 'flex' : 'none';
    if (oskOpen) { oskFocusRow = 1; oskFocusCol = 4; renderOSK(); }
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

  // ── Focus ring position sync (keeps ring aligned after scroll) ─────
  function syncFocusRing() {
    if (!focusRingEl || !focusedEl) return;
    if (focusRingEl.style.opacity === '0') return;
    const rect = focusedEl.getBoundingClientRect();
    // Element scrolled off-screen or hidden
    if (rect.width === 0 || rect.height === 0) { focusRingEl.style.opacity = '0'; return; }
    const pad = 3;
    focusRingEl.style.left = (rect.left - pad) + 'px';
    focusRingEl.style.top = (rect.top - pad) + 'px';
    focusRingEl.style.width = (rect.width + pad * 2) + 'px';
    focusRingEl.style.height = (rect.height + pad * 2) + 'px';
  }

  // ── Auto-hide mouse cursor ─────────────────────────────────────────
  let mouseHideTimer = null;
  function initMouseAutoHide() {
    function showMouse() {
      document.body.classList.remove('hide-cursor');
      clearTimeout(mouseHideTimer);
      mouseHideTimer = setTimeout(() => {
        document.body.classList.add('hide-cursor');
      }, 5000);
    }
    document.addEventListener('mousemove', showMouse);
    document.addEventListener('mousedown', showMouse);
    // Start hidden after 5s
    mouseHideTimer = setTimeout(() => {
      document.body.classList.add('hide-cursor');
    }, 5000);
  }

  // ── CSS ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('gamepad-nav-styles')) return;
    const style = document.createElement('style');
    style.id = 'gamepad-nav-styles';
    style.textContent = '#gamepad-cursor{will-change:left,top,opacity}#gamepad-focus-ring{will-change:left,top,width,height,opacity}#gamepad-osk *{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}body.hide-cursor,body.hide-cursor *{cursor:none!important}';
    document.head.appendChild(style);
  }

  // ── Custom Confirm Dialog (gamepad-navigable) ─────────────────────────
  let confirmEl = null;
  let confirmResolve = null;
  let confirmFocus = 0; // 0=cancel, 1=ok

  function createConfirmEl() {
    if (confirmEl) return;
    confirmEl = document.createElement('div');
    confirmEl.id = 'gamepad-confirm';
    confirmEl.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.7);display:none;align-items:center;justify-content:center;';
    confirmEl.innerHTML = '<div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:24px;max-width:360px;width:90%;text-align:center">' +
      '<div id="gp-confirm-msg" style="color:#e0e0e0;font-size:14px;margin-bottom:20px;white-space:pre-wrap;font-family:-apple-system,system-ui,sans-serif"></div>' +
      '<div style="display:flex;gap:10px;justify-content:center">' +
      '<button id="gp-confirm-cancel" style="flex:1;padding:10px;background:#333;border:2px solid #444;border-radius:8px;color:#aaa;font-size:13px;font-weight:600;cursor:pointer">Cancel</button>' +
      '<button id="gp-confirm-ok" style="flex:1;padding:10px;background:rgba(74,158,255,0.15);border:2px solid #4a9eff;border-radius:8px;color:#4a9eff;font-size:13px;font-weight:600;cursor:pointer">OK</button>' +
      '</div></div>';
    document.body.appendChild(confirmEl);
    confirmEl.querySelector('#gp-confirm-cancel').onclick = () => resolveConfirm(false);
    confirmEl.querySelector('#gp-confirm-ok').onclick = () => resolveConfirm(true);
  }

  function resolveConfirm(result) {
    if (confirmEl) confirmEl.style.display = 'none';
    if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
  }

  function gamepadConfirm(message) {
    createConfirmEl();
    confirmEl.querySelector('#gp-confirm-msg').textContent = message;
    confirmEl.style.display = 'flex';
    confirmFocus = 1; // default to OK
    updateConfirmFocus();
    return new Promise(resolve => { confirmResolve = resolve; });
  }

  function updateConfirmFocus() {
    if (!confirmEl) return;
    const cancel = confirmEl.querySelector('#gp-confirm-cancel');
    const ok = confirmEl.querySelector('#gp-confirm-ok');
    cancel.style.borderColor = confirmFocus === 0 ? '#4a9eff' : '#444';
    cancel.style.boxShadow = confirmFocus === 0 ? '0 0 8px rgba(74,158,255,0.4)' : 'none';
    ok.style.borderColor = confirmFocus === 1 ? '#4a9eff' : '#4a9eff';
    ok.style.boxShadow = confirmFocus === 1 ? '0 0 8px rgba(74,158,255,0.4)' : 'none';
    ok.style.opacity = confirmFocus === 1 ? '1' : '0.5';
    cancel.style.opacity = confirmFocus === 0 ? '1' : '0.5';
  }

  function isConfirmOpen() {
    return confirmEl && confirmEl.style.display === 'flex';
  }

  // Expose gamepadConfirm globally for app-specific usage
  window.gamepadConfirm = gamepadConfirm;

  // ── Public API ────────────────────────────────────────────────────────
  window.GamepadNav = {
    getSettings: () => ({ ...settings }),
    setSettings: (patch) => { settings = { ...settings, ...patch }; updateCursorStyle(); updateOSKStyle(); saveSettings(settings); },
    resetSettings: () => { settings = { ...DEFAULTS }; updateCursorStyle(); updateOSKStyle(); saveSettings(settings); },
    getState: () => latestControllers,
    isActive: () => gamepadActive,
    disable: () => { disabled = true; },
    enable: () => { disabled = false; },
    toggleOSK,
  };

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    loadSettings();
    connectWS();
    initMouseAutoHide();
    // Keep focus ring aligned during any scroll
    window.addEventListener('scroll', syncFocusRing, { passive: true });
    document.addEventListener('scroll', syncFocusRing, { passive: true, capture: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
