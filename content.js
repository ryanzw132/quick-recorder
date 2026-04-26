// Quick Recorder — content script
// Owns: countdown, control bar, draggable camera bubble (DOM, captured by the
// screen recording itself). No streams routed through SW.
//
// All UI lives inside a closed-styled Shadow DOM so hostile page CSS can't
// affect it (e.g. `body { all: initial }`, page `*` selectors with !important,
// CSS resets, etc.).

(() => {
  if (window.__qrInjected) return;
  window.__qrInjected = true;

  const STORAGE_KEY_CAM = 'qr.cameraTransform';
  const COUNTDOWN_SECONDS = 3;

  // ── Inlined styles (kept here, not in content.css, so Shadow DOM owns them)
  const STYLE = `
    :host, :host * {
      box-sizing: border-box !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    }
    @media print { :host { display: none !important; } }

    .qr-countdown {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
    }
    .qr-countdown-num {
      color: white !important;
      font-size: 220px !important;
      font-weight: 700 !important;
      text-shadow: 0 6px 24px rgba(0,0,0,0.6);
      animation: qr-pop 1s ease-out forwards;
    }
    @keyframes qr-pop {
      0% { transform: scale(0.6); opacity: 0; }
      20% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }

    .qr-bar {
      position: absolute;
      left: 16px; bottom: 16px;
      display: flex !important; align-items: center; gap: 6px;
      padding: 6px 10px;
      background: rgba(20,20,22,0.92) !important;
      backdrop-filter: blur(10px);
      border-radius: 999px !important;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      pointer-events: auto !important;
      color: white !important;
      font-size: 13px !important;
      user-select: none;
    }
    .qr-rec-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #ef4444 !important;
      animation: qr-blink 1.2s infinite;
      margin-right: 4px;
    }
    @keyframes qr-blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0.25; }
    }
    .qr-timer {
      font-variant-numeric: tabular-nums;
      font-weight: 600 !important;
      min-width: 56px;
      letter-spacing: 0.5px;
    }
    .qr-btn {
      background: transparent !important;
      border: none !important;
      color: white !important;
      padding: 6px 10px !important;
      border-radius: 999px !important;
      cursor: pointer !important;
      font-size: 13px !important;
      display: inline-flex; align-items: center; gap: 6px;
      transition: background 120ms;
    }
    .qr-btn:hover { background: rgba(255,255,255,0.12) !important; }
    .qr-btn:active { background: rgba(255,255,255,0.2) !important; }
    .qr-btn.qr-stop { background: #ef4444 !important; }
    .qr-btn.qr-stop:hover { background: #dc2626 !important; }
    .qr-btn.qr-off { opacity: 0.4; }
    .qr-divider {
      width: 1px; height: 20px;
      background: rgba(255,255,255,0.18);
      margin: 0 2px;
    }

    .qr-icon-btn {
      width: 32px; height: 32px;
      border-radius: 50% !important;
      background: rgba(255,255,255,0.08) !important;
      border: none !important;
      color: white !important;
      cursor: pointer !important;
      font-size: 15px !important;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0 !important;
      line-height: 1 !important;
      transition: background 120ms;
    }
    .qr-icon-btn:hover { background: rgba(255,255,255,0.18) !important; }
    .qr-icon-btn.qr-off { opacity: 0.4; }

    .qr-menu-wrap { position: relative; display: inline-flex; }
    .qr-menu {
      position: absolute;
      bottom: calc(100% + 8px);
      left: 0;
      min-width: 220px;
      max-width: 320px;
      background: rgba(20,20,22,0.96) !important;
      border-radius: 12px !important;
      padding: 4px !important;
      box-shadow: 0 12px 40px rgba(0,0,0,0.55);
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .qr-menu[hidden] { display: none !important; }
    .qr-menu-item {
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px !important;
      color: white !important;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .qr-menu-item:hover { background: rgba(255,255,255,0.1) !important; }
    .qr-menu-item.qr-active { background: rgba(34,197,94,0.18) !important; }
    .qr-menu-item-check {
      width: 14px;
      display: inline-block;
      color: #4ade80;
    }
    .qr-menu-divider {
      height: 1px;
      background: rgba(255,255,255,0.1);
      margin: 4px 0;
    }

    .qr-cam {
      position: absolute;
      border-radius: 18px !important;
      overflow: hidden !important;
      pointer-events: auto !important;
      cursor: grab;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45), 0 0 0 2px rgba(255,255,255,0.08);
      background: #000 !important;
      will-change: transform;
    }
    .qr-cam.qr-dragging { cursor: grabbing; }
    .qr-cam.qr-hidden { display: none !important; }
    .qr-cam video {
      width: 100% !important; height: 100% !important;
      object-fit: cover !important;
      display: block !important;
      transform: scaleX(-1) !important;
      pointer-events: none !important;
    }
    .qr-cam-resize {
      position: absolute;
      right: 0; bottom: 0;
      width: 22px; height: 22px;
      cursor: nwse-resize;
      background:
        linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0.55) 60%,
        transparent 60%, transparent 70%, rgba(255,255,255,0.55) 70%, rgba(255,255,255,0.55) 80%, transparent 80%);
    }
  `;

  function defaultCam() {
    // Top-right by default — avoids overlap with Chrome's permission prompt
    // anchored to the address bar (top-left).
    const W = window.innerWidth, H = window.innerHeight;
    const w = 240, h = 180;
    return { x: Math.max(24, W - w - 24), y: 24, w, h };
  }

  let host = null;
  let shadow = null;
  let bar = null;
  let timerEl = null;
  let camEl = null;
  let camVideo = null;
  let cameraStream = null;
  let cameraOn = true;
  let timerInterval = null;
  let mics = [];
  let cams = [];
  let currentCamId = null;
  let currentMicId = null;
  let initialised = false;
  let initGen = 0;

  // ── Shadow root scaffolding ───────────────────────────────────────────────
  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'qr-host';
    // Inline (high-specificity) host styles in case the page tries to override
    // via element selectors. Shadow root protects content; host needs this.
    host.style.cssText = `
      position: fixed !important;
      inset: 0 !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
      transform: none !important;
      filter: none !important;
      opacity: 1 !important;
      visibility: visible !important;
    `;
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);
    // Append to documentElement so we survive body replacement.
    document.documentElement.appendChild(host);
  }

  function teardown() {
    initGen++;
    stopTimer();
    stopCamera();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = shadow = bar = timerEl = camEl = camVideo = null;
    initialised = false;
  }

  // ── Countdown ─────────────────────────────────────────────────────────────
  async function runCountdown() {
    ensureHost();
    const wrap = document.createElement('div');
    wrap.className = 'qr-countdown';
    shadow.appendChild(wrap);
    for (let n = COUNTDOWN_SECONDS; n >= 1; n--) {
      wrap.innerHTML = `<div class="qr-countdown-num">${n}</div>`;
      await new Promise((r) => setTimeout(r, 900));
    }
    wrap.remove();
  }

  // ── Camera ────────────────────────────────────────────────────────────────
  function clampTransform(t) {
    const W = window.innerWidth, H = window.innerHeight;
    t.w = Math.max(120, Math.min(900, Math.min(t.w, W)));
    t.h = Math.max(90, Math.min(700, Math.min(t.h, H)));
    t.x = Math.max(0, Math.min(W - t.w, t.x));
    t.y = Math.max(0, Math.min(H - t.h, t.y));
    return t;
  }
  async function loadCamTransform() {
    const r = await chrome.storage.local.get(STORAGE_KEY_CAM);
    return clampTransform(r[STORAGE_KEY_CAM] || defaultCam());
  }
  async function saveCamTransform(t) {
    await chrome.storage.local.set({ [STORAGE_KEY_CAM]: t });
  }

  async function buildCamera() {
    const t = await loadCamTransform();
    camEl = document.createElement('div');
    camEl.className = 'qr-cam';
    camEl.style.left = t.x + 'px';
    camEl.style.top = t.y + 'px';
    camEl.style.width = t.w + 'px';
    camEl.style.height = t.h + 'px';
    camVideo = document.createElement('video');
    camVideo.autoplay = true;
    camVideo.playsInline = true;
    camVideo.muted = true;
    camEl.appendChild(camVideo);
    const handle = document.createElement('div');
    handle.className = 'qr-cam-resize';
    camEl.appendChild(handle);
    shadow.appendChild(camEl);
    attachDrag(camEl, handle, t);
    await startCamera();
  }

  async function startCamera(deviceId) {
    try {
      stopCamera();
      const constraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
          : { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      };
      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      camVideo.srcObject = cameraStream;
      camEl?.classList.remove('qr-hidden');
      // Recover gracefully if the camera disappears (USB unplug, etc.)
      const vt = cameraStream.getVideoTracks()[0];
      if (vt) {
        vt.addEventListener('ended', () => {
          if (camEl) camEl.classList.add('qr-hidden');
        });
      }
      await refreshDevices();
      if (vt && vt.getSettings) {
        currentCamId = vt.getSettings().deviceId || currentCamId;
      }
      updateBarSelects();
    } catch (e) {
      console.warn('[QR] camera unavailable', e);
      cameraOn = false;
      if (camEl) camEl.classList.add('qr-hidden');
      const btn = bar?.querySelector('[data-qr="cam-toggle"]');
      if (btn) {
        btn.classList.add('qr-off');
        btn.title = 'Camera unavailable on this site (permission denied or blocked)';
      }
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    if (camVideo) camVideo.srcObject = null;
  }

  async function refreshDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cams = devices.filter((d) => d.kind === 'videoinput')
        .map((d) => ({ id: d.deviceId, label: d.label || 'Camera' }));
      const newMics = devices.filter((d) => d.kind === 'audioinput')
        .map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
      // Keep server-side mics list authoritative if richer (offscreen has labels).
      if (newMics.length && newMics[0].label) mics = newMics;
    } catch {}
  }

  // ── Camera drag/resize ────────────────────────────────────────────────────
  function attachDrag(target, handle, transform) {
    let mode = null;
    let startX = 0, startY = 0;
    let origX = 0, origY = 0, origW = 0, origH = 0;

    target.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      mode = handle.contains(e.target) ? 'resize' : 'drag';
      startX = e.clientX; startY = e.clientY;
      const rect = target.getBoundingClientRect();
      origX = rect.left; origY = rect.top;
      origW = rect.width; origH = rect.height;
      target.classList.add('qr-dragging');
      e.preventDefault();
      e.stopPropagation();
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });

    function onMove(e) {
      if (!mode) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (mode === 'drag') {
        const x = Math.max(0, Math.min(window.innerWidth - origW, origX + dx));
        const y = Math.max(0, Math.min(window.innerHeight - origH, origY + dy));
        target.style.left = x + 'px';
        target.style.top = y + 'px';
        transform.x = x; transform.y = y;
      } else {
        const w = Math.max(120, Math.min(900, origW + dx));
        const h = Math.max(90, Math.min(700, origH + dy));
        target.style.width = w + 'px';
        target.style.height = h + 'px';
        transform.w = w; transform.h = h;
      }
      e.preventDefault();
    }
    function onUp(e) {
      mode = null;
      target.classList.remove('qr-dragging');
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      saveCamTransform(transform).catch(() => {});
    }
  }

  // ── Control bar (compact: icon-buttons with popover menus) ────────────────
  function buildBar() {
    bar = document.createElement('div');
    bar.className = 'qr-bar';
    bar.innerHTML = `
      <div class="qr-rec-dot"></div>
      <div class="qr-timer" data-qr="timer">00:00</div>
      <div class="qr-divider"></div>
      <div class="qr-menu-wrap">
        <button class="qr-icon-btn" data-qr="cam-btn" title="Camera">📷</button>
        <div class="qr-menu" data-qr="cam-menu" hidden></div>
      </div>
      <div class="qr-menu-wrap">
        <button class="qr-icon-btn" data-qr="mic-btn" title="Microphone">🎤</button>
        <div class="qr-menu" data-qr="mic-menu" hidden></div>
      </div>
      <div class="qr-divider"></div>
      <button class="qr-icon-btn" data-qr="retry" title="Discard and start over">↻</button>
      <button class="qr-btn qr-stop" data-qr="stop" title="Stop and save">■ Stop</button>
    `;
    shadow.appendChild(bar);
    timerEl = bar.querySelector('[data-qr="timer"]');

    const camBtn = bar.querySelector('[data-qr="cam-btn"]');
    const micBtn = bar.querySelector('[data-qr="mic-btn"]');
    const camMenu = bar.querySelector('[data-qr="cam-menu"]');
    const micMenu = bar.querySelector('[data-qr="mic-menu"]');

    camBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(camMenu, micMenu); });
    micBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(micMenu, camMenu); });
    bar.querySelector('[data-qr="retry"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'retry' }).catch(() => {});
    });
    bar.querySelector('[data-qr="stop"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
    });
    // Close any open menu on outside click.
    document.addEventListener('mousedown', (e) => {
      if (!shadow) return;
      // shadow root contains the menu — events outside the host close menus.
      if (!host || !host.contains(e.target)) {
        camMenu.hidden = true;
        micMenu.hidden = true;
      }
    }, true);
  }

  function toggleMenu(target, other) {
    other.hidden = true;
    target.hidden = !target.hidden;
  }

  function updateBarSelects() {
    if (!bar) return;
    const camMenu = bar.querySelector('[data-qr="cam-menu"]');
    const micMenu = bar.querySelector('[data-qr="mic-menu"]');
    const camBtn = bar.querySelector('[data-qr="cam-btn"]');
    if (camMenu) {
      const items = [];
      items.push(menuItem('Camera off', !cameraOn, () => {
        if (cameraOn) toggleCamera();
        camMenu.hidden = true;
      }));
      if (cams.length) items.push(divider());
      cams.forEach((c) => {
        items.push(menuItem(c.label, cameraOn && c.id === currentCamId, () => {
          if (!cameraOn) toggleCamera(); // turn on
          currentCamId = c.id;
          startCamera(c.id);
          camMenu.hidden = true;
        }));
      });
      camMenu.replaceChildren(...items);
    }
    if (camBtn) camBtn.classList.toggle('qr-off', !cameraOn);
    if (micMenu) {
      const items = [];
      if (!mics.length) {
        items.push(menuItemStatic('No microphones found'));
        items.push(divider());
        items.push(menuItem('Enable mic permission…', false, () => {
          chrome.runtime.sendMessage({ target: 'sw', type: 'openMicPermission' }).catch(() => {});
          micMenu.hidden = true;
        }));
      } else {
        mics.forEach((m) => {
          items.push(menuItem(m.label, m.id === currentMicId, () => {
            currentMicId = m.id;
            chrome.runtime.sendMessage({ target: 'offscreen', type: 'micChange', deviceId: m.id }).catch(() => {});
            micMenu.hidden = true;
          }));
        });
      }
      micMenu.replaceChildren(...items);
    }
  }

  function menuItem(label, active, onClick) {
    const el = document.createElement('div');
    el.className = 'qr-menu-item' + (active ? ' qr-active' : '');
    el.innerHTML = `<span class="qr-menu-item-check">${active ? '✓' : ''}</span><span>${esc(label)}</span>`;
    el.addEventListener('click', onClick);
    return el;
  }
  function menuItemStatic(label) {
    const el = document.createElement('div');
    el.className = 'qr-menu-item';
    el.style.opacity = '0.6';
    el.textContent = label;
    return el;
  }
  function divider() {
    const el = document.createElement('div');
    el.className = 'qr-menu-divider';
    return el;
  }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function toggleCamera() {
    cameraOn = !cameraOn;
    if (camEl) camEl.classList.toggle('qr-hidden', !cameraOn);
    const btn = bar?.querySelector('[data-qr="cam-btn"]');
    if (btn) btn.classList.toggle('qr-off', !cameraOn);
    if (cameraOn && !cameraStream) startCamera(currentCamId);
    else if (!cameraOn) stopCamera();
  }

  async function waitForCameraReady() {
    if (!camVideo) return;
    if (camVideo.readyState >= 3 /* HAVE_FUTURE_DATA */ && !camVideo.paused) return;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      camVideo.addEventListener('playing', fin, { once: true });
      camVideo.addEventListener('loadeddata', fin, { once: true });
      setTimeout(fin, 1500); // safety
    });
  }

  // ── Timer ─────────────────────────────────────────────────────────────────
  function startTimer(at) {
    stopTimer();
    const tick = () => {
      if (!timerEl) return;
      const ms = Date.now() - at;
      const totalS = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(totalS / 3600);
      const m = Math.floor((totalS % 3600) / 60);
      const s = totalS % 60;
      timerEl.textContent = h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    tick();
    timerInterval = setInterval(tick, 500);
  }
  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  }

  // ── Init/cleanup hooked to messages from SW ───────────────────────────────
  async function init(msg) {
    if (initialised) {
      if (msg.startedAt) startTimer(msg.startedAt);
      if (msg.mics?.length) { mics = msg.mics; updateBarSelects(); }
      return;
    }
    initialised = true;
    const gen = ++initGen;
    if (Array.isArray(msg.mics)) mics = msg.mics;
    const alreadyRunning = !!msg.startedAt;
    ensureHost();
    if (!alreadyRunning) {
      // Build camera FIRST so it's already streaming when the recorder starts;
      // otherwise the first ~1s of the recording shows a black bubble.
      await buildCamera();
      if (gen !== initGen) return;
      await waitForCameraReady();
      if (gen !== initGen) return;
      await runCountdown();
      if (gen !== initGen) return;
      const startedAt = Date.now();
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'beginRecord' }).catch(() => {});
      chrome.runtime.sendMessage({ target: 'sw', type: 'recordingBegan', startedAt }).catch(() => {});
      buildBar();
      updateBarSelects();
      startTimer(startedAt);
    } else {
      buildBar();
      await buildCamera();
      if (gen !== initGen) return;
      await waitForCameraReady();
      updateBarSelects();
      startTimer(msg.startedAt);
    }
  }

  function onRestarted(msg) {
    startTimer(msg.startedAt || Date.now());
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'content') return false;
    console.log('[QR content] msg:', msg.type);
    switch (msg.type) {
      case 'init': init(msg); break;
      case 'restarted': onRestarted(msg); break;
      case 'cleanup': teardown(); break;
    }
    return false;
  });

  console.log('[QR content] injected at', location.href);
  chrome.runtime.sendMessage({ target: 'sw', type: 'requestRehydrate' }).catch(() => {});
})();
