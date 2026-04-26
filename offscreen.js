// Quick Recorder — offscreen document
// Owns: getDisplayMedia, getUserMedia(mic), Web Audio mix, MediaRecorder, blob.
// Camera is handled in the content script (DOM bubble) — captured by the screen
// recorder via the OS-level display capture, not composited here.

let screenStream = null;
let micStream = null;
let mixedStream = null; // = screen video track + mixed audio track
let audioCtx = null;
let micSrc = null, sysSrc = null;
let micGain = null, sysGain = null;
let destNode = null;

let recorder = null;
let chunks = [];
let chosenMime = '';
let chosenExt = 'mp4';
// 'idle' | 'starting' | 'awaiting-begin' | 'recording'
let phase = 'idle';
// Increments every start cycle; stale awaits/timeouts compare against this.
let startGen = 0;

const MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01F,mp4a.40.2"',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

function pickMime() {
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) {
      chosenMime = m;
      chosenExt = m.startsWith('video/mp4') ? 'mp4' : 'webm';
      return m;
    }
  }
  chosenMime = '';
  chosenExt = 'webm';
  return '';
}

function send(msg) {
  chrome.runtime.sendMessage({ target: 'sw', ...msg }).catch(() => {});
}

const NOTIF_ICON = chrome.runtime.getURL('icons/icon128.png');

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: NOTIF_ICON,
      title,
      message,
      priority: 1
    }, () => void chrome.runtime.lastError);
  } catch (e) {
    console.warn('[QR] notify failed', e);
  }
}

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
  } catch {
    return [];
  }
}

async function acquireStreams(streamId) {
  // 1. Tab capture (no picker). Both video and audio of the captured tab are
  //    requested via the chromium-specific `chromeMediaSource: 'tab'` form.
  //    1080p / 30fps cap keeps file size manageable.
  console.log('[QR offscreen] requesting tab capture for streamId', streamId);
  screenStream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    },
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });
  console.log('[QR offscreen] got tab stream, audio tracks:', screenStream.getAudioTracks().length);
  // Tab capture hijacks playback in the captured tab — re-route audio so the
  // user can still hear what's playing.
  try {
    const audioTrack = screenStream.getAudioTracks()[0];
    if (audioTrack) {
      const sysOnly = new MediaStream([audioTrack]);
      const playbackEl = new Audio();
      playbackEl.srcObject = sysOnly;
      playbackEl.play().catch(() => {});
    }
  } catch (e) { console.warn('[QR offscreen] passthrough audio failed', e); }

  // 2. Mic — OPTIONAL. Offscreen documents are hidden, so Chrome can't anchor
  //    a permission prompt to them. If the user hasn't pre-granted mic to the
  //    extension via the permissions.html page, this throws — we keep
  //    recording without mic instead of failing the whole session.
  micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      },
      video: false
    });
    console.log('[QR offscreen] mic acquired');
  } catch (e) {
    console.warn('[QR offscreen] mic unavailable, continuing without mic:', e?.message || e);
    send({ type: 'micPermissionMissing' });
    notify(
      'Recording without microphone',
      'Microphone permission has not been granted to the extension. Opening the permissions page so you can fix it for next time.'
    );
  }

  // 3. Mix mic + system audio (whatever we got)
  audioCtx = new AudioContext();
  destNode = audioCtx.createMediaStreamDestination();

  if (micStream) {
    micSrc = audioCtx.createMediaStreamSource(micStream);
    micGain = audioCtx.createGain();
    micGain.gain.value = 1.0;
    micSrc.connect(micGain).connect(destNode);
  }

  const sysTracks = screenStream.getAudioTracks();
  if (sysTracks.length > 0) {
    const sysOnly = new MediaStream([sysTracks[0]]);
    sysSrc = audioCtx.createMediaStreamSource(sysOnly);
    sysGain = audioCtx.createGain();
    sysGain.gain.value = 1.0;
    sysSrc.connect(sysGain).connect(destNode);
  }

  // 4. Final stream: screen video + (mixed audio iff any source exists)
  const videoTrack = screenStream.getVideoTracks()[0];
  const tracks = [videoTrack];
  if (micStream || sysTracks.length > 0) {
    tracks.push(destNode.stream.getAudioTracks()[0]);
  } else {
    console.warn('[QR offscreen] no audio sources — recording video only');
  }
  mixedStream = new MediaStream(tracks);

  // If user stops sharing via the browser toolbar, finalize gracefully.
  videoTrack.addEventListener('ended', () => {
    if (recorder && recorder.state !== 'inactive') {
      stopRecording();
    } else {
      // No active recorder yet (still in startup or already torn down).
      // Notify SW so badge/state get cleared, then clean up.
      send({ type: 'error', error: 'Screen sharing ended.' });
      cleanup();
    }
  });
}

function startRecorder() {
  pickMime();
  chunks = [];
  // Aggressive bitrate to keep file size small. 1.5 Mbps + 96 kbps audio
  // ≈ 1.6 Mbps total ≈ 12 MB/min. ~25 MB ≈ 2 minutes at 1080p30 — screen
  // content compresses very well at this rate.
  const opts = {
    videoBitsPerSecond: 1_500_000,
    audioBitsPerSecond: 96_000
  };
  if (chosenMime) opts.mimeType = chosenMime;

  recorder = new MediaRecorder(mixedStream, opts);
  // Capture the mime/ext that this specific recorder used, so a later mime
  // change (e.g. after retry probe) doesn't taint the saved file extension.
  const recMime = chosenMime;
  const recExt = chosenExt;
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onerror = (e) => {
    send({ type: 'error', error: 'MediaRecorder error: ' + (e.error?.message || e.error || 'unknown') });
    cleanup();
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recMime || 'video/webm' });
    const url = URL.createObjectURL(blob);
    liveBlobUrls.add(url);
    send({ type: 'recordingEnded', blobUrl: url, ext: recExt });
    chunks = [];
    cleanup();
  };
  recorder.start(2000); // 2-second timeslice
  phase = 'recording';
}

function stopRecorder() {
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
}

async function start(streamId, tabId) {
  if (phase !== 'idle') return;
  phase = 'starting';
  const myGen = ++startGen;
  console.log('[QR offscreen] start() phase=starting gen=' + myGen);
  try {
    await acquireStreams(streamId);
    if (phase !== 'starting' || startGen !== myGen) { cleanup(); return; }
    const mics = await listMics();
    if (phase !== 'starting' || startGen !== myGen) { cleanup(); return; }
    phase = 'awaiting-begin';
    console.log('[QR offscreen] streams ready, awaiting beginRecord');
    send({ type: 'streamsReady', mics });
    setTimeout(() => {
      if (phase === 'awaiting-begin' && startGen === myGen) {
        console.warn('[QR offscreen] beginRecord timeout — bailing');
        notify('Recording failed to start', 'The countdown handshake did not arrive within 15 seconds.');
        send({ type: 'error', error: 'Recorder start timed out — try again.' });
        cleanup();
      }
    }, 15000);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.error('[QR offscreen] start() failed:', msg);
    notify('Recording error', msg);
    send({ type: 'error', error: msg });
    cleanup();
  }
}

function beginRecord() {
  if (phase !== 'awaiting-begin') return;
  startRecorder();
}

function stopRecording() {
  if (phase === 'starting' || phase === 'awaiting-begin') {
    cleanup(); // bumps phase to 'idle'; in-flight start() awaits will bail
    // Mimic an "ended" so SW resets state/badge.
    send({ type: 'error', error: 'Recording cancelled.' });
    return;
  }
  stopRecorder();
}

function retry() {
  // Discard current chunks, stop recorder without firing onstop's "save" path,
  // then start a new recorder over the same streams.
  if (!recorder) return;
  const old = recorder;
  recorder = null; // detach handlers' "save" branch
  old.onstop = null;
  old.ondataavailable = null;
  old.onerror = null;
  try { old.stop(); } catch {}
  chunks = [];
  // Start a fresh recorder
  startRecorder();
  send({ type: 'recordingRestarted' });
}

async function changeMic(deviceId) {
  if (!audioCtx || !destNode) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      }
    });
    // Disconnect old source
    if (micSrc) { try { micSrc.disconnect(); } catch {} }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = newStream;
    // micGain may not exist if the original mic acquisition failed — create
    // the audio graph node lazily on first successful mic.
    if (!micGain) {
      micGain = audioCtx.createGain();
      micGain.gain.value = 1.0;
      micGain.connect(destNode);
    }
    micSrc = audioCtx.createMediaStreamSource(micStream);
    micSrc.connect(micGain);
  } catch (e) {
    console.warn('[QR offscreen] mic switch failed', e);
    notify('Mic switch failed', e.message || String(e));
  }
}

function cleanup() {
  try { stopRecorder(); } catch {}
  recorder = null;
  if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  micStream = null;
  mixedStream = null;
  try { audioCtx && audioCtx.close(); } catch {}
  audioCtx = null;
  micSrc = sysSrc = micGain = sysGain = destNode = null;
  phase = 'idle';
}

// Track URLs we've created so we can revoke after download completes.
const liveBlobUrls = new Set();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'startTabCapture': start(msg.streamId, msg.tabId); break;
    case 'beginRecord': beginRecord(); break;
    case 'stop': stopRecording(); break;
    case 'retry': retry(); break;
    case 'micChange': changeMic(msg.deviceId); break;
    case 'toggle': {
      // Toggle is only used to STOP from the SW now (start path uses
      // startTabCapture). If somehow toggled while idle, no-op.
      if (phase !== 'idle') stopRecording();
      break;
    }
    case 'revokeBlob': {
      try { URL.revokeObjectURL(msg.url); } catch {}
      liveBlobUrls.delete(msg.url);
      break;
    }
  }
  return false;
});
