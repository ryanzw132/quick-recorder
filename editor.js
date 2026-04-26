// Quick Recorder — Editor
// Loads a recording from IndexedDB, exposes a minimal timeline (trim handles
// + cut regions), exports via ffmpeg.wasm at a chosen target file size.

(() => {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  const QUALITY_PRESETS = [
    { sizeMB: 5,   label: '5 MB' },
    { sizeMB: 10,  label: '10 MB' },
    { sizeMB: 25,  label: '25 MB' },
    { sizeMB: 50,  label: '50 MB' },
    { sizeMB: 100, label: '100 MB' },
    { sizeMB: 250, label: '250 MB' },
    { sizeMB: null, label: 'Original' }
  ];

  const $ = (sel) => document.querySelector(`[data-qr="${sel}"]`);

  let recordingId = null;
  let recording = null;        // { id, blob, mime, ext, title, durationMs, ... }
  let videoUrl = null;
  let durationSec = 0;
  let trimStart = 0;
  let trimEnd = 0;
  let cuts = [];               // [{ start, end }] — sorted by start
  let qualityIndex = 4;        // 100 MB default
  let activeDrag = null;       // { type: 'trim-start'|'trim-end'|'cut-start'|'cut-end'|'playhead', cutIndex? }
  let selectedCutIndex = -1;
  let playInterval = null;

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
        trimEnd = durationSec;
        timeDuration.textContent = fmtTime(durationSec);
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

    // Background bar (full duration in muted)
    ctx.fillStyle = '#1d2138';
    ctx.fillRect(0, 22, w, 36);

    // Trim region (kept area, blue)
    ctx.fillStyle = 'rgba(37,99,235,0.18)';
    ctx.fillRect(timeToX(trimStart), 22, timeToX(trimEnd) - timeToX(trimStart), 36);

    // Greyed-out region BEFORE trimStart and AFTER trimEnd (excluded)
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 22, timeToX(trimStart), 36);
    ctx.fillRect(timeToX(trimEnd), 22, w - timeToX(trimEnd), 36);

    // Cut regions (red overlay inside trim)
    cuts.forEach((c, i) => {
      const x1 = timeToX(c.start);
      const x2 = timeToX(c.end);
      ctx.fillStyle = i === selectedCutIndex ? 'rgba(239,68,68,0.65)' : 'rgba(239,68,68,0.4)';
      ctx.fillRect(x1, 22, x2 - x1, 36);
      // hatched outline
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = i === selectedCutIndex ? 2 : 1;
      ctx.strokeRect(x1 + 0.5, 22.5, Math.max(0, x2 - x1 - 1), 35);
    });

    // Trim handles
    drawHandle(timeToX(trimStart), '#2563eb', 'L');
    drawHandle(timeToX(trimEnd), '#2563eb', 'R');

    // Cut handles
    cuts.forEach((c) => {
      drawHandle(timeToX(c.start), '#ef4444', 'L', 4);
      drawHandle(timeToX(c.end), '#ef4444', 'R', 4);
    });

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

  function drawHandle(x, color, side, narrow = 6) {
    ctx.fillStyle = color;
    const w = narrow;
    ctx.fillRect(x - w/2, 18, w, 44);
  }

  // Hit-test the timeline. Returns drag descriptor or null.
  function hitTest(x) {
    const TOL = 8;
    if (Math.abs(x - timeToX(trimStart)) < TOL) return { type: 'trim-start' };
    if (Math.abs(x - timeToX(trimEnd)) < TOL) return { type: 'trim-end' };
    for (let i = 0; i < cuts.length; i++) {
      if (Math.abs(x - timeToX(cuts[i].start)) < TOL) return { type: 'cut-start', cutIndex: i };
      if (Math.abs(x - timeToX(cuts[i].end)) < TOL) return { type: 'cut-end', cutIndex: i };
    }
    // Inside a cut region — select it
    for (let i = 0; i < cuts.length; i++) {
      const x1 = timeToX(cuts[i].start), x2 = timeToX(cuts[i].end);
      if (x >= x1 && x <= x2) return { type: 'select-cut', cutIndex: i };
    }
    return { type: 'playhead' };
  }

  timelineCanvas.addEventListener('mousedown', (e) => {
    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hit = hitTest(x);
    if (hit.type === 'select-cut') {
      selectedCutIndex = hit.cutIndex;
      drawTimeline();
      return;
    }
    activeDrag = hit;
    if (hit.type === 'playhead') {
      videoEl.currentTime = xToTime(x);
    }
    selectedCutIndex = -1;
    document.addEventListener('mousemove', onCanvasMove);
    document.addEventListener('mouseup', onCanvasUp);
    drawTimeline();
  });

  function onCanvasMove(e) {
    if (!activeDrag) return;
    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = xToTime(x);
    const d = activeDrag;
    if (d.type === 'trim-start') {
      trimStart = Math.max(0, Math.min(trimEnd - 0.1, t));
      videoEl.currentTime = trimStart;
    } else if (d.type === 'trim-end') {
      trimEnd = Math.max(trimStart + 0.1, Math.min(durationSec, t));
      videoEl.currentTime = trimEnd;
    } else if (d.type === 'cut-start') {
      const c = cuts[d.cutIndex];
      c.start = Math.max(trimStart, Math.min(c.end - 0.05, t));
      videoEl.currentTime = c.start;
    } else if (d.type === 'cut-end') {
      const c = cuts[d.cutIndex];
      c.end = Math.max(c.start + 0.05, Math.min(trimEnd, t));
      videoEl.currentTime = c.end;
    } else if (d.type === 'playhead') {
      videoEl.currentTime = t;
    }
    drawTimeline();
    updateQualityLabel();
  }

  function onCanvasUp() {
    activeDrag = null;
    document.removeEventListener('mousemove', onCanvasMove);
    document.removeEventListener('mouseup', onCanvasUp);
    // Sort cuts by start, merge overlaps
    cuts.sort((a, b) => a.start - b.start);
    for (let i = cuts.length - 2; i >= 0; i--) {
      if (cuts[i].end >= cuts[i+1].start) {
        cuts[i].end = Math.max(cuts[i].end, cuts[i+1].end);
        cuts.splice(i + 1, 1);
      }
    }
    drawTimeline();
  }

  // ── Player loop (skip cut regions during playback) ───────────────────────
  function ensurePlaybackInsideKept() {
    const t = videoEl.currentTime;
    // Hard clamp to trim
    if (t < trimStart) { videoEl.currentTime = trimStart; return; }
    if (t >= trimEnd) {
      videoEl.pause();
      videoEl.currentTime = trimEnd;
      return;
    }
    // Skip over cut regions
    for (const c of cuts) {
      if (t >= c.start && t < c.end) {
        videoEl.currentTime = c.end;
        return;
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
  setTrimStartBtn.addEventListener('click', () => {
    trimStart = Math.min(videoEl.currentTime, trimEnd - 0.1);
    drawTimeline(); updateQualityLabel();
  });
  setTrimEndBtn.addEventListener('click', () => {
    trimEnd = Math.max(videoEl.currentTime, trimStart + 0.1);
    drawTimeline(); updateQualityLabel();
  });
  addCutBtn.addEventListener('click', () => {
    const t = videoEl.currentTime;
    const len = Math.min(2, (trimEnd - t) / 2);
    if (len < 0.1) return;
    const c = { start: t, end: t + len };
    cuts.push(c);
    cuts.sort((a, b) => a.start - b.start);
    selectedCutIndex = cuts.indexOf(c);
    drawTimeline(); updateQualityLabel();
  });
  deleteCutBtn.addEventListener('click', () => {
    if (selectedCutIndex < 0 || selectedCutIndex >= cuts.length) return;
    cuts.splice(selectedCutIndex, 1);
    selectedCutIndex = -1;
    drawTimeline(); updateQualityLabel();
  });
  resetBtn.addEventListener('click', () => {
    trimStart = 0;
    trimEnd = durationSec;
    cuts = [];
    selectedCutIndex = -1;
    drawTimeline(); updateQualityLabel();
  });

  // Spacebar = play/pause
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedCutIndex >= 0) {
        e.preventDefault();
        deleteCutBtn.click();
      }
    }
  });

  // ── Quality slider ────────────────────────────────────────────────────────
  function effectiveDuration() {
    let d = trimEnd - trimStart;
    for (const c of cuts) {
      const overlap = Math.max(0, Math.min(c.end, trimEnd) - Math.max(c.start, trimStart));
      d -= overlap;
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

  // Build the kept time ranges (segments).
  function buildKeptSegments() {
    let segs = [{ start: trimStart, end: trimEnd }];
    for (const c of cuts) {
      const next = [];
      for (const s of segs) {
        if (c.end <= s.start || c.start >= s.end) { next.push(s); continue; }
        if (c.start > s.start) next.push({ start: s.start, end: c.start });
        if (c.end < s.end) next.push({ start: c.end, end: s.end });
      }
      segs = next;
    }
    return segs.filter((s) => s.end - s.start > 0.05);
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

      const hasAudio = recording.hasAudio !== false;
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

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => { resizeCanvas(); drawTimeline(); });
  resizeCanvas();
  qualitySlider.value = String(qualityIndex);
  loadRecording().then(renderLibrary).then(updateQualityLabel);
})();
