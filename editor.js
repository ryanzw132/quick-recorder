// Quick Recorder — Editor
// Loads a recording from IndexedDB, exposes a minimal timeline (trim handles
// + cut regions), exports via ffmpeg.wasm at a chosen target file size.

(() => {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  const QUALITY_PRESETS = [
    { sizeMB: 5,   label: '5 MB' },
    { sizeMB: 10,  label: '10 MB' },
    { sizeMB: 20,  label: '20 MB' },
    { sizeMB: 25,  label: '25 MB' },
    { sizeMB: 50,  label: '50 MB' },
    { sizeMB: 100, label: '100 MB' },
    { sizeMB: 250, label: '250 MB' },
    { sizeMB: null, label: 'Original' }
  ];
  const DEFAULT_QUALITY_INDEX = 2; // 20 MB

  const $ = (sel) => document.querySelector(`[data-qr="${sel}"]`);

  let recordingId = null;
  let recording = null;        // { id, blob, mime, ext, title, durationMs, ... }
  let videoUrl = null;
  let durationSec = 0;
  // ── Segment model ────────────────────────────────────────────────────────
  // Splits is a sorted array including 0 and durationSec at the ends. The
  // sections between consecutive splits are "segments". segmentDeleted[i]
  // indicates whether segment i (between splits[i] and splits[i+1]) is
  // excluded from playback / export.
  let splits = [0, 0];
  let segmentDeleted = [false];
  let selectedSegment = -1;
  let qualityIndex = DEFAULT_QUALITY_INDEX;
  let activeDrag = null;       // { type: 'split'|'playhead', splitIndex? }
  let playInterval = null;
  // Undo/redo
  let history = [];
  let historyIndex = -1;

  // ── DOM ──────────────────────────────────────────────────────────────────
  const videoEl = $('video');
  const titleEl = $('title');
  const timelineCanvas = $('timeline');
  const ctx = timelineCanvas.getContext('2d');
  const playBtn = $('play');
  const setTrimStartBtn = $('set-trim-start');
  const setTrimEndBtn = $('set-trim-end');
  const addCutBtn = $('add-cut');
  const deleteCutBtn = $('delete-region');
  const resetBtn = $('reset');
  const qualitySlider = $('quality-slider');
  const qualityTarget = $('quality-target');
  const qualityDetail = $('quality-detail');
  const exportBtn = $('export');
  const timeCurrent = $('time-current');
  const timeDuration = $('time-duration');
  const sidebarList = $('library');
  const overlay = $('overlay');
  const overlayTitle = $('overlay-title');
  const overlayMsg = $('overlay-msg');
  const overlayProgress = $('overlay-progress');

  // ── URL params ───────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const isLibraryMode = params.get('library') === '1';
  recordingId = params.get('id');
  if (recordingId) recordingId = parseInt(recordingId, 10);

  // ── Helpers ──────────────────────────────────────────────────────────────
  function fmtTime(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
    if (bytes < 1024*1024*1024) return (bytes/(1024*1024)).toFixed(1) + ' MB';
    return (bytes/(1024*1024*1024)).toFixed(2) + ' GB';
  }
  function showOverlay(title, msg, progress) {
    overlay.hidden = false;
    overlayTitle.textContent = title;
    overlayMsg.textContent = msg;
    overlayProgress.style.width = (progress != null ? progress : 0) + '%';
  }
  function hideOverlay() { overlay.hidden = true; }
  function setOverlayProgress(percent) { overlayProgress.style.width = percent + '%'; }

  // ── Library ──────────────────────────────────────────────────────────────
  async function renderLibrary() {
    const items = await QRDB.listEditing();
    sidebarList.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = 'No unfinished projects.';
      sidebarList.appendChild(empty);
      return;
    }
    items.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'sidebar-item' + (it.id === recordingId ? ' active' : '');
      el.innerHTML = `
        <div class="sidebar-item-title"></div>
        <div class="sidebar-item-meta"></div>
      `;
      el.querySelector('.sidebar-item-title').textContent = it.title || `Recording #${it.id}`;
      const dt = new Date(it.createdAt).toLocaleString();
      el.querySelector('.sidebar-item-meta').textContent = `${fmtSize(it.sizeBytes)} · ${dt}`;
      el.addEventListener('click', () => {
        if (it.id === recordingId) return;
        location.search = `?id=${it.id}`;
      });
      sidebarList.appendChild(el);
    });
  }

  // ── Load recording ───────────────────────────────────────────────────────
  async function loadRecording() {
    if (isLibraryMode || !recordingId) {
      // Library-only mode, or missing id: don't load a video; just show library.
      titleEl.textContent = 'Library';
      videoEl.style.display = 'none';
      timelineCanvas.style.display = 'none';
      [playBtn, setTrimStartBtn, setTrimEndBtn, addCutBtn, deleteCutBtn, resetBtn,
       qualitySlider, exportBtn].forEach((el) => el && (el.disabled = true));
      // Auto-redirect to first available project if any
      const items = await QRDB.listEditing();
      if (items.length) {
        location.search = `?id=${items[0].id}`;
        return;
      }
      return;
    }

    recording = await QRDB.get(recordingId);
    if (!recording) {
      showOverlay('Recording not found', 'This recording is no longer available.', 0);
      return;
    }
    titleEl.textContent = recording.title || `Recording #${recording.id}`;
    document.title = `Editor — ${titleEl.textContent}`;
    videoUrl = URL.createObjectURL(recording.blob);
    videoEl.src = videoUrl;
    const fallbackDur = (recording.durationMs || 0) / 1000;
    videoEl.addEventListener('loadedmetadata', () => {
      const finalize = () => {
        durationSec = Number.isFinite(videoEl.duration) ? videoEl.duration : fallbackDur;
        if (durationSec <= 0) durationSec = fallbackDur || 0.1;
        // Initialize segment model: a single non-deleted segment from 0 to end.
        splits = [0, durationSec];
        segmentDeleted = [false];
        selectedSegment = -1;
        history = [];
        historyIndex = -1;
        snapshot();
        timeDuration.textContent = fmtTime(durationSec);
        // Default volume + force unmuted
        videoEl.volume = 1.0;
        videoEl.muted = false;
        updateQualityLabel();
        drawTimeline();
      };
      if (!Number.isFinite(videoEl.duration)) {
        videoEl.currentTime = 1e9;
        videoEl.addEventListener('seeked', function once() {
          videoEl.removeEventListener('seeked', once);
          videoEl.currentTime = 0;
          finalize();
        }, { once: true });
        // Belt-and-suspenders: if the seek trick stalls (some browsers), use
        // the recorded fallback after 1.5s.
        setTimeout(() => {
          if (durationSec === 0) finalize();
        }, 1500);
      } else {
        finalize();
      }
    });
  }

  // ── Timeline canvas ──────────────────────────────────────────────────────
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = timelineCanvas.clientWidth;
    timelineCanvas.width = Math.floor(w * dpr);
    timelineCanvas.height = Math.floor(80 * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function timeToX(t) {
    return (t / Math.max(durationSec, 0.001)) * timelineCanvas.clientWidth;
  }
  function xToTime(x) {
    const t = (x / timelineCanvas.clientWidth) * durationSec;
    return Math.max(0, Math.min(durationSec, t));
  }

  function drawTimeline() {
    const w = timelineCanvas.clientWidth;
    const h = 80;
    ctx.clearRect(0, 0, w, h);

    // Background bar (full duration)
    ctx.fillStyle = '#1d2138';
    ctx.fillRect(0, 22, w, 36);

    // Each segment: blue if kept, red-hatched if deleted, brighter if selected.
    for (let i = 0; i < segmentDeleted.length; i++) {
      const x1 = timeToX(splits[i]);
      const x2 = timeToX(splits[i + 1]);
      const sw = x2 - x1;
      const isSelected = i === selectedSegment;
      if (segmentDeleted[i]) {
        ctx.fillStyle = isSelected ? 'rgba(239,68,68,0.65)' : 'rgba(239,68,68,0.4)';
        ctx.fillRect(x1, 22, sw, 36);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(x1 + 0.5, 22.5, Math.max(0, sw - 1), 35);
      } else {
        ctx.fillStyle = isSelected ? 'rgba(37,99,235,0.45)' : 'rgba(37,99,235,0.22)';
        ctx.fillRect(x1, 22, sw, 36);
        if (isSelected) {
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2;
          ctx.strokeRect(x1 + 0.5, 22.5, Math.max(0, sw - 1), 35);
        }
      }
    }

    // Split markers (interior split points only — endpoints aren't draggable)
    for (let i = 1; i < splits.length - 1; i++) {
      const x = timeToX(splits[i]);
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(x - 2, 18, 4, 44);
    }

    // Time ticks on top
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px -apple-system';
    const tickCount = 8;
    for (let i = 0; i <= tickCount; i++) {
      const t = (durationSec * i) / tickCount;
      const x = timeToX(t);
      ctx.fillRect(x, 12, 1, 6);
      const label = fmtTime(t);
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, Math.min(w - tw, Math.max(0, x - tw/2)), 8);
    }

    // Playhead
    const px = timeToX(videoEl.currentTime || 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(px - 1, 18, 2, 44);
    ctx.beginPath();
    ctx.moveTo(px - 6, 12);
    ctx.lineTo(px + 6, 12);
    ctx.lineTo(px, 22);
    ctx.closePath();
    ctx.fill();
  }

  function segmentAtTime(t) {
    for (let i = 0; i < segmentDeleted.length; i++) {
      if (t >= splits[i] && t < splits[i + 1]) return i;
    }
    if (t >= splits[splits.length - 1]) return segmentDeleted.length - 1;
    return -1;
  }

  // Hit-test: prefer dragging a near split marker; else select segment.
  function hitTest(x) {
    const TOL = 8;
    // Only interior splits are draggable
    for (let i = 1; i < splits.length - 1; i++) {
      if (Math.abs(x - timeToX(splits[i])) < TOL) {
        return { type: 'split', splitIndex: i };
      }
    }
    return { type: 'segment', segmentIndex: segmentAtTime(xToTime(x)) };
  }

  timelineCanvas.addEventListener('mousedown', (e) => {
    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hit = hitTest(x);
    if (hit.type === 'split') {
      activeDrag = hit;
      document.addEventListener('mousemove', onCanvasMove);
      document.addEventListener('mouseup', onCanvasUp);
    } else if (hit.type === 'segment') {
      // First click: select the segment; second click on same area moves the
      // playhead. To keep things simple: shift-click selects, plain click
      // both selects AND moves playhead.
      selectedSegment = hit.segmentIndex;
      videoEl.currentTime = xToTime(x);
      drawTimeline();
    }
  });

  function onCanvasMove(e) {
    if (!activeDrag) return;
    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = xToTime(x);
    if (activeDrag.type === 'split') {
      const i = activeDrag.splitIndex;
      const lo = splits[i - 1] + 0.05;
      const hi = splits[i + 1] - 0.05;
      splits[i] = Math.max(lo, Math.min(hi, t));
      videoEl.currentTime = splits[i];
      drawTimeline();
      updateQualityLabel();
    }
  }

  function onCanvasUp() {
    if (activeDrag && activeDrag.type === 'split') {
      snapshot(); // Record drag result for undo.
    }
    activeDrag = null;
    document.removeEventListener('mousemove', onCanvasMove);
    document.removeEventListener('mouseup', onCanvasUp);
    drawTimeline();
  }

  // ── Operations on the segment model ──────────────────────────────────────
  function makeCutAtPlayhead() {
    const t = videoEl.currentTime;
    if (t <= splits[0] + 0.05 || t >= splits[splits.length - 1] - 0.05) return;
    // Find the segment that contains t.
    let i = segmentAtTime(t);
    if (i < 0) return;
    // Don't cut if t is too close to an existing split.
    if (Math.abs(splits[i] - t) <= 0.05 || Math.abs(splits[i + 1] - t) <= 0.05) return;
    splits.splice(i + 1, 0, t);
    // The new segment inherits the deleted state of its parent.
    segmentDeleted.splice(i + 1, 0, segmentDeleted[i]);
    selectedSegment = i + 1;
    snapshot();
    drawTimeline();
    updateQualityLabel();
  }

  function deleteSelectedSegment() {
    if (selectedSegment < 0 || selectedSegment >= segmentDeleted.length) return;
    segmentDeleted[selectedSegment] = true;
    snapshot();
    drawTimeline();
    updateQualityLabel();
  }

  // ── Player loop (skip deleted segments during playback) ──────────────────
  function ensurePlaybackInsideKept() {
    const t = videoEl.currentTime;
    // If we're in a deleted segment, jump to the start of the next kept one.
    const i = segmentAtTime(t);
    if (i < 0) return;
    if (segmentDeleted[i]) {
      // Skip forward through any consecutive deleted segments.
      let j = i;
      while (j < segmentDeleted.length && segmentDeleted[j]) j++;
      if (j >= segmentDeleted.length) {
        videoEl.pause();
        // Park at the end of the last kept segment.
        let last = segmentDeleted.length - 1;
        while (last >= 0 && segmentDeleted[last]) last--;
        videoEl.currentTime = last >= 0 ? splits[last + 1] : 0;
      } else {
        videoEl.currentTime = splits[j];
      }
    }
  }

  function startPlayLoop() {
    stopPlayLoop();
    playInterval = setInterval(() => {
      ensurePlaybackInsideKept();
      timeCurrent.textContent = fmtTime(videoEl.currentTime);
      drawTimeline();
    }, 50);
  }
  function stopPlayLoop() {
    if (playInterval) { clearInterval(playInterval); playInterval = null; }
  }

  videoEl.addEventListener('play', () => {
    playBtn.textContent = '⏸';
    startPlayLoop();
  });
  videoEl.addEventListener('pause', () => {
    playBtn.textContent = '▶';
    stopPlayLoop();
    drawTimeline();
  });
  videoEl.addEventListener('timeupdate', () => {
    timeCurrent.textContent = fmtTime(videoEl.currentTime);
    drawTimeline();
  });

  // ── Toolbar ──────────────────────────────────────────────────────────────
  playBtn.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play().catch(() => {});
    else videoEl.pause();
  });
  if (setTrimStartBtn) setTrimStartBtn.addEventListener('click', () => {
    // "Set start" = cut at the playhead, then mark everything before as deleted.
    makeCutAtPlayhead();
    const i = segmentAtTime(videoEl.currentTime);
    for (let k = 0; k < i; k++) segmentDeleted[k] = true;
    snapshot();
    drawTimeline(); updateQualityLabel();
  });
  if (setTrimEndBtn) setTrimEndBtn.addEventListener('click', () => {
    // "Set end" = cut at the playhead, then mark everything after as deleted.
    makeCutAtPlayhead();
    const i = segmentAtTime(videoEl.currentTime - 0.001);
    for (let k = i + 1; k < segmentDeleted.length; k++) segmentDeleted[k] = true;
    snapshot();
    drawTimeline(); updateQualityLabel();
  });
  addCutBtn.addEventListener('click', makeCutAtPlayhead);
  deleteCutBtn.addEventListener('click', deleteSelectedSegment);
  resetBtn.addEventListener('click', () => {
    splits = [0, durationSec];
    segmentDeleted = [false];
    selectedSegment = -1;
    snapshot();
    drawTimeline(); updateQualityLabel();
  });

  // ── Undo / redo ───────────────────────────────────────────────────────────
  function snapshot() {
    history = history.slice(0, historyIndex + 1);
    history.push({
      splits: splits.slice(),
      segmentDeleted: segmentDeleted.slice(),
      selectedSegment
    });
    historyIndex = history.length - 1;
    if (history.length > 100) {
      history.shift();
      historyIndex--;
    }
  }
  function applySnapshot(s) {
    splits = s.splits.slice();
    segmentDeleted = s.segmentDeleted.slice();
    selectedSegment = s.selectedSegment;
    drawTimeline();
    updateQualityLabel();
  }
  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    applySnapshot(history[historyIndex]);
  }
  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    applySnapshot(history[historyIndex]);
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    // Only suppress shortcuts inside text-entry fields. Range sliders, buttons,
    // and contenteditable need to be evaluated separately so Cmd-Z/Cmd-B keep
    // working after the user touches the volume / quality sliders.
    const el = e.target;
    const tag = el && el.tagName;
    const type = el && 'type' in el ? String(el.type).toLowerCase() : '';
    const isTextEntry =
      tag === 'TEXTAREA' ||
      (tag === 'INPUT' && !['range', 'button', 'checkbox', 'radio', 'submit'].includes(type)) ||
      (el && el.isContentEditable);
    if (isTextEntry) return;
    const isMeta = e.metaKey || e.ctrlKey;
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedSegment >= 0) {
      e.preventDefault();
      deleteSelectedSegment();
    } else if (isMeta && e.code === 'KeyB') {
      e.preventDefault();
      makeCutAtPlayhead();
    } else if (isMeta && e.shiftKey && e.code === 'KeyZ') {
      e.preventDefault();
      redo();
    } else if (isMeta && !e.shiftKey && e.code === 'KeyZ') {
      e.preventDefault();
      undo();
    }
  });

  // ── Quality slider ────────────────────────────────────────────────────────
  function effectiveDuration() {
    let d = 0;
    for (let i = 0; i < segmentDeleted.length; i++) {
      if (!segmentDeleted[i]) d += splits[i + 1] - splits[i];
    }
    return Math.max(0.1, d);
  }

  // Pick resolution + per-track bitrate from a target file size in MB.
  function planExport(targetSizeMB) {
    const dur = effectiveDuration();
    if (targetSizeMB == null) {
      // Original quality — keep source resolution, high CRF.
      return { mode: 'crf', crf: 18, scale: null, audioKbps: 128 };
    }
    const totalKbps = (targetSizeMB * 8 * 1024) / dur;       // bits per second / 1000
    const audioKbps = 96;
    const videoKbps = Math.max(120, Math.floor(totalKbps - audioKbps));
    let scale;
    if (videoKbps >= 4000) scale = '1920:-2';        // 1080p
    else if (videoKbps >= 1500) scale = '1280:-2';   // 720p
    else if (videoKbps >= 700) scale = '854:-2';     // 480p
    else scale = '640:-2';                            // 360p (very low target)
    return { mode: 'cbr', videoKbps, audioKbps, scale };
  }

  function planLabel(plan, targetSizeMB) {
    if (plan.mode === 'crf') {
      return 'Original quality · re-encode';
    }
    const res = plan.scale.startsWith('1920') ? '1080p' :
                plan.scale.startsWith('1280') ? '720p' :
                plan.scale.startsWith('854') ? '480p' : '360p';
    return `${res} · ${Math.round(plan.videoKbps)} kbps · est. ${targetSizeMB} MB`;
  }

  function updateQualityLabel() {
    const preset = QUALITY_PRESETS[qualityIndex];
    qualityTarget.textContent = preset.label;
    const plan = planExport(preset.sizeMB);
    qualityDetail.textContent = planLabel(plan, preset.sizeMB);
  }

  qualitySlider.addEventListener('input', (e) => {
    qualityIndex = parseInt(e.target.value, 10);
    updateQualityLabel();
  });

  // ── Export via ffmpeg.wasm ───────────────────────────────────────────────
  let ffmpeg = null;
  let ffmpegLoading = null;
  async function loadFfmpeg() {
    if (ffmpeg) return ffmpeg;
    if (ffmpegLoading) return ffmpegLoading;
    showOverlay('Loading editor engine', 'Loading ffmpeg (~30 MB, one-time)…', 5);
    ffmpegLoading = (async () => {
      // Load UMD ffmpeg.js — exposes window.FFmpegWASM
      await injectScript(chrome.runtime.getURL('lib/ffmpeg/ffmpeg.js'));
      const { FFmpeg } = window.FFmpegWASM;
      const inst = new FFmpeg();
      inst.on('progress', ({ progress }) => {
        if (progress >= 0 && progress <= 1) {
          setOverlayProgress(15 + Math.round(progress * 85));
        }
      });
      await inst.load({
        coreURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm')
      });
      ffmpeg = inst;
      return inst;
    })().catch((err) => {
      // Reset so the next attempt can try again instead of being stuck on
      // the rejected promise forever.
      ffmpegLoading = null;
      throw err;
    });
    return ffmpegLoading;
  }

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Probe whether the input file has an audio stream. Returns true/false.
  async function detectInputHasAudio(ff, inName) {
    try {
      await ff.exec(['-v', 'error', '-i', inName, '-map', '0:a:0', '-f', 'null', '-']);
      return true;
    } catch {
      return false;
    }
  }

  // Build the kept time ranges by merging consecutive non-deleted segments.
  function buildKeptSegments() {
    const out = [];
    let cur = null;
    for (let i = 0; i < segmentDeleted.length; i++) {
      if (segmentDeleted[i]) { cur = null; continue; }
      if (!cur) { cur = { start: splits[i], end: splits[i + 1] }; out.push(cur); }
      else cur.end = splits[i + 1];
    }
    return out.filter((s) => s.end - s.start > 0.05);
  }

  function buildFilterComplex(segs, hasAudio) {
    // Build a filter_complex chain that trims each kept segment from the input
    // and concats them. Audio-track presence is conditional.
    const v = [];
    const a = [];
    const labels = [];
    segs.forEach((s, i) => {
      v.push(`[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      if (hasAudio) {
        a.push(`[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
        labels.push(`[v${i}][a${i}]`);
      } else {
        labels.push(`[v${i}]`);
      }
    });
    const concat = hasAudio
      ? `${labels.join('')}concat=n=${segs.length}:v=1:a=1[outv][outa]`
      : `${labels.join('')}concat=n=${segs.length}:v=1:a=0[outv]`;
    return [...v, ...a, concat].join(';');
  }

  async function runExport() {
    const segs = buildKeptSegments();
    if (!segs.length) {
      alert('Nothing to export — all content is trimmed or cut out.');
      return;
    }
    const preset = QUALITY_PRESETS[qualityIndex];
    const plan = planExport(preset.sizeMB);

    // Fast path: no edits + Original quality + already MP4 → just download blob.
    const noEdits = segs.length === 1 && Math.abs(segs[0].start) < 0.01 && Math.abs(segs[0].end - durationSec) < 0.01;
    if (noEdits && preset.sizeMB == null) {
      downloadBlob(recording.blob, recording.title, recording.ext);
      // Brief overlay so user sees the export happened.
      showOverlay('Exported', 'File downloaded.', 100);
      setTimeout(hideOverlay, 1200);
      await markExported();
      return;
    }

    // ffmpeg path
    try {
      const ff = await loadFfmpeg();
      showOverlay('Exporting', 'Encoding…', 0);

      const inName = 'in.' + (recording.ext || 'mp4');
      const outName = 'out.mp4';

      // Write the source blob into the wasm FS.
      showOverlay('Exporting', 'Loading source…', 5);
      const srcBuf = new Uint8Array(await recording.blob.arrayBuffer());
      await ff.writeFile(inName, srcBuf);

      // hasAudio detection: prefer the metadata flag saved with the recording,
      // but fall back to probing the input file (legacy recordings from
      // pre-v2.1 don't have hasAudio set).
      let hasAudio;
      if (recording.hasAudio == null) {
        hasAudio = await detectInputHasAudio(ff, inName);
      } else {
        hasAudio = recording.hasAudio !== false;
      }
      let filter = buildFilterComplex(segs, hasAudio);
      // If we need to scale, append a scale step after concat.
      if (plan.mode === 'cbr' && plan.scale) {
        const concatTokenAudio = `concat=n=${segs.length}:v=1:a=1[outv][outa]`;
        const concatTokenVideo = `concat=n=${segs.length}:v=1:a=0[outv]`;
        if (hasAudio) {
          filter = filter.replace(concatTokenAudio,
            `concat=n=${segs.length}:v=1:a=1[concv][outa];[concv]scale=${plan.scale}[outv]`);
        } else {
          filter = filter.replace(concatTokenVideo,
            `concat=n=${segs.length}:v=1:a=0[concv];[concv]scale=${plan.scale}[outv]`);
        }
      }
      const args = [
        '-i', inName,
        '-filter_complex', filter,
        '-map', '[outv]'
      ];
      if (hasAudio) args.push('-map', '[outa]');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
      if (plan.mode === 'crf') {
        args.push('-crf', String(plan.crf));
      } else {
        args.push('-b:v', plan.videoKbps + 'k');
      }
      if (hasAudio) args.push('-c:a', 'aac', '-b:a', plan.audioKbps + 'k');
      else args.push('-an');
      args.push(outName);

      showOverlay('Exporting', `Encoding ${preset.label}…`, 10);
      await ff.exec(args);
      showOverlay('Exporting', 'Reading output…', 95);
      const data = await ff.readFile(outName);
      // Pass the Uint8Array view directly so any byteOffset/byteLength is
      // respected. `data.buffer` would include unrelated bytes if it ever
      // had an offset.
      const outBlob = new Blob([data], { type: 'video/mp4' });
      downloadBlob(outBlob, recording.title, 'mp4');
      // Cleanup wasm FS so the next export starts fresh.
      try { await ff.deleteFile(inName); } catch {}
      try { await ff.deleteFile(outName); } catch {}
      showOverlay('Exported', `Saved as ${preset.label}. The editor stays open in case you want to re-edit.`, 100);
      setTimeout(hideOverlay, 1800);
      await markExported();
    } catch (e) {
      console.error('[QR editor] export failed', e);
      hideOverlay();
      alert('Export failed: ' + (e.message || e));
    }
  }

  function downloadBlob(blob, title, ext) {
    const safe = (title || 'recording').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'recording';
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `${safe}.${ext || 'mp4'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function markExported() {
    if (!recordingId) return;
    try {
      // Per spec: the library is for "edited but not exported" recordings.
      // After export, remove from IDB entirely so it doesn't accumulate.
      await QRDB.remove(recordingId);
    } catch {}
    await renderLibrary();
  }

  exportBtn.addEventListener('click', runExport);

  // ── Undo / redo buttons ───────────────────────────────────────────────────
  const undoBtn = $('undo');
  const redoBtn = $('redo');
  if (undoBtn) undoBtn.addEventListener('click', undo);
  if (redoBtn) redoBtn.addEventListener('click', redo);

  // ── Volume ────────────────────────────────────────────────────────────────
  const volumeSlider = $('volume');
  const volumeIcon = $('volume-icon');
  function setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    videoEl.volume = v;
    videoEl.muted = v === 0;
    if (volumeIcon) volumeIcon.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔈' : '🔊';
  }
  if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => setVolume(parseInt(e.target.value, 10) / 100));
    setVolume(1);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => { resizeCanvas(); drawTimeline(); });
  resizeCanvas();
  qualitySlider.value = String(qualityIndex);
  loadRecording().then(renderLibrary).then(updateQualityLabel);
})();
