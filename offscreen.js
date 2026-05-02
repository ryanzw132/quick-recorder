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

// Offscreen documents don't have chrome.notifications — route through SW.
function notify(title, message) {
  send({ type: 'notify', title, message });
}

// Sort mics by priority: USB → Bluetooth (incl. AirPods) → built-in → other.
// Heuristic on label strings since the browser doesn't expose connection bus.
function micPriorityRank(label) {
  const l = (label || '').toLowerCase();
  if (/usb/.test(l)) return 0;
  if (/airpod|bluetooth|wireless|headphone|headset|earbud/.test(l)) return 1;
  if (/built-?in|macbook|internal|default/.test(l)) return 3;
  return 2;
}

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices
      .filter((d) => d.kind === 'audioinput')
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
    mics.sort((a, b) => micPriorityRank(a.label) - micPriorityRank(b.label));
    return mics;
  } catch {
    return [];
  }
}

// Verify a mic track is healthy enough to record with. Checks track.muted
// and readyState — gives the track up to 500ms to clear an initial muted
// state (Bluetooth devices can start momentarily muted while the link comes
// up). We DO NOT do RMS sampling: a legitimately quiet room produces near-
// zero samples on a working mic, and that would false-negative reject it
// while a noisy device (AirPods hiss) would always pass. The audio meter
// running during recording catches actual silence over time.
async function verifyMicTrackHealthy(track) {
  if (!track) return false;
  if (track.readyState !== 'live') return false;
  if (track.muted) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      const onUnmute = () => { clearTimeout(timer); resolve(); };
      track.addEventListener('unmute', onUnmute, { once: true });
    });
  }
  return track.readyState === 'live' && !track.muted;
}

// Wire up mic-track lifecycle events. If the mic mutes (Bluetooth flap, OS
// suspend) or ends mid-recording, surface a notification so the user knows
// the recording will be silent until they recover the device.
function attachMicTrackLifecycleHandlers(stream) {
  if (!stream) return;
  const t = stream.getAudioTracks()[0];
  if (!t) return;
  t.addEventListener('mute', () => {
    console.warn('[QR offscreen] mic track MUTED (track.id=' + t.id + ')');
    notify(
      'Microphone went silent',
      "Your mic just muted itself — usually a Bluetooth disconnect or sleep transition. The recording is still rolling but won't have voice until you fix it. Click ↻ Retry on the bar after fixing."
    );
  });
  t.addEventListener('unmute', () => {
    console.log('[QR offscreen] mic track UNMUTED (track.id=' + t.id + ')');
  });
  t.addEventListener('ended', () => {
    console.warn('[QR offscreen] mic track ENDED (track.id=' + t.id + ')');
    notify(
      'Microphone disconnected',
      "Your mic was disconnected mid-recording. The rest of the recording will be silent. Click ↻ Retry on the bar to start over with a working mic."
    );
  });
}

// AudioContext suspends after macOS sleep/wake. Resume it automatically.
function attachAudioContextRecovery(ctx) {
  if (!ctx) return;
  ctx.addEventListener('statechange', () => {
    console.log('[QR offscreen] AudioContext state:', ctx.state);
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        console.log('[QR offscreen] AudioContext resumed automatically');
      }).catch((e) => {
        console.warn('[QR offscreen] AudioContext resume failed', e);
      });
    }
  });
}

// Notify content (and SW) when the mic device list changes so the bar menu
// can refresh. macOS fires devicechange in bursts (5+ times in 200ms when
// AirPods connect) — debounce so we only emit once per actual change.
let deviceChangeListenerAttached = false;
let deviceChangeDebounce = null;
function attachDeviceChangeListener() {
  if (deviceChangeListenerAttached) return;
  deviceChangeListenerAttached = true;
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (deviceChangeDebounce) clearTimeout(deviceChangeDebounce);
    deviceChangeDebounce = setTimeout(async () => {
      console.log('[QR offscreen] devicechange (debounced) — refreshing mic list');
      try {
        const mics = await listMics();
        send({ type: 'micsChanged', mics });
      } catch (e) { console.warn('[QR offscreen] listMics on devicechange failed', e); }
    }, 250);
  });
}

// Robust mic acquisition. Trusts the OS-level default — if the user picked
// a mic in System Settings (or Chrome's site settings), we use it. Only when
// the default is genuinely broken (NotFoundError, muted track, etc.) do we
// fall back to other devices. Returns a verified MediaStream or null.
async function acquireMicWithVerification() {
  let permissionDenied = false;

  const tryDevice = async (deviceId) => {
    try {
      const constraints = {
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false
        },
        video: false
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getAudioTracks()[0];
      const ok = await verifyMicTrackHealthy(track);
      if (ok) return stream;
      console.warn('[QR offscreen] mic unhealthy:', deviceId || '(default)', 'label:', track?.label);
      stream.getTracks().forEach((t) => t.stop());
      return null;
    } catch (e) {
      // NotAllowedError = permission denied (or revoked). Distinguish from
      // hardware/device errors (NotFoundError, OverconstrainedError, etc.)
      // because the recovery action for the user is different.
      if (e?.name === 'NotAllowedError') permissionDenied = true;
      console.warn('[QR offscreen] mic acquisition failed:', deviceId || '(default)', e?.name, e?.message || e);
      return null;
    }
  };

  // 1. Try the OS-level default. The user has already expressed intent here
  //    via System Settings or Chrome's input device picker — respect it.
  let stream = await tryDevice(null);
  if (stream) {
    console.log('[QR offscreen] mic acquired (default), label:', stream.getAudioTracks()[0]?.label);
    return stream;
  }

  // 2. Default failed. If it was a permission denial, we can't recover by
  //    trying another device — every getUserMedia call will fail the same way.
  if (permissionDenied) {
    send({ type: 'micPermissionMissing' });
    notify(
      'Recording without microphone',
      'Mic permission was revoked or never granted. Opening the permissions page now — grant it, then start a new recording.'
    );
    return null;
  }

  // 3. Default device is broken (muted, busy, just-disconnected). Try other
  //    devices in priority order until one verifies healthy.
  console.warn('[QR offscreen] default mic unhealthy — trying alternatives');
  const mics = await listMics();
  for (const candidate of mics) {
    console.log('[QR offscreen] trying fallback mic:', candidate.label);
    const better = await tryDevice(candidate.id);
    if (better) {
      console.log('[QR offscreen] using fallback mic:', candidate.label);
      return better;
    }
  }

  // 4. Nothing worked. Could be hardware issue, all devices muted, etc.
  console.warn('[QR offscreen] no healthy mic available');
  notify(
    'Microphone unavailable',
    "Couldn't get a working mic — every device tried was muted or silent. Common causes: System Settings → Privacy → Microphone is blocked, the device is busy in another app, or a Bluetooth device just disconnected. Recording continues without voice. Fix the mic and click ↻ Retry."
  );
  return null;
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

  // 2. Mic — OPTIONAL with priority selection. Always prefer USB → Bluetooth
  //    → built-in. Offscreen documents are hidden, so Chrome can't anchor a
  //    permission prompt to them; if not pre-granted, we record without mic.
  micStream = await acquireMicWithVerification();
  if (micStream) attachMicTrackLifecycleHandlers(micStream);

  // 3. Build the audio track for recording.
  //    - If only one source (mic OR tab audio), use it raw — no AudioContext.
  //    - If both, mix via AudioContext. If the context can't be resumed in
  //      this hidden offscreen doc, fall back to mic-only.
  const sysTracks = screenStream.getAudioTracks();
  let audioTrack = null;

  if (micStream && sysTracks.length > 0) {
    try {
      audioCtx = new AudioContext();
      attachAudioContextRecovery(audioCtx);
      console.log('[QR offscreen] AudioContext initial state:', audioCtx.state);
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
        console.log('[QR offscreen] AudioContext after resume:', audioCtx.state);
      }
      if (audioCtx.state !== 'running') {
        throw new Error('AudioContext refused to run (state=' + audioCtx.state + ')');
      }
      destNode = audioCtx.createMediaStreamDestination();
      micSrc = audioCtx.createMediaStreamSource(micStream);
      micGain = audioCtx.createGain();
      micGain.gain.value = 1.0;
      micSrc.connect(micGain).connect(destNode);
      const sysOnly = new MediaStream([sysTracks[0]]);
      sysSrc = audioCtx.createMediaStreamSource(sysOnly);
      sysGain = audioCtx.createGain();
      sysGain.gain.value = 1.0;
      sysSrc.connect(sysGain).connect(destNode);
      audioTrack = destNode.stream.getAudioTracks()[0];
      console.log('[QR offscreen] mixed audio via AudioContext (mic + tab)');
    } catch (e) {
      console.warn('[QR offscreen] AudioContext mix failed, falling back to mic-only:', e?.message || e);
      try { audioCtx && audioCtx.close(); } catch {}
      audioCtx = null;
      audioTrack = micStream.getAudioTracks()[0];
    }
  } else if (micStream) {
    audioTrack = micStream.getAudioTracks()[0];
    console.log('[QR offscreen] using mic-only audio (no tab audio)');
  } else if (sysTracks.length > 0) {
    audioTrack = sysTracks[0];
    console.log('[QR offscreen] using tab-audio-only (no mic)');
  } else {
    console.warn('[QR offscreen] no audio sources — recording video only');
  }

  // 4. Final stream: screen video + (audio if any).
  const videoTrack = screenStream.getVideoTracks()[0];
  const tracks = [videoTrack];
  if (audioTrack) tracks.push(audioTrack);
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

  // Diagnostic dump of every track in the stream we're about to record.
  console.log('[QR offscreen] === recorder.start tracks ===');
  console.log('[QR offscreen] mime:', chosenMime || '(default)');
  mixedStream.getTracks().forEach((t) => {
    let settings = {};
    try { settings = t.getSettings ? t.getSettings() : {}; } catch {}
    console.log('[QR offscreen]   track:', {
      kind: t.kind,
      id: t.id,
      label: t.label,
      enabled: t.enabled,
      muted: t.muted,
      readyState: t.readyState,
      deviceId: settings.deviceId,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount
    });
  });

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
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recMime || 'video/webm' });
    const durationMs = Date.now() - recorderStartedAt;
    chunks = [];
    try {
      // Detect whether the final stream had any audio track at all (mic + tab
      // audio could have both failed). The editor uses this to skip [0:a] in
      // the filter graph for video-only files.
      const hadAudio = mixedStream && mixedStream.getAudioTracks().length > 0;
      const id = await QRDB.save({
        blob,
        mime: recMime || 'video/webm',
        ext: recExt,
        title: pendingTitle,
        durationMs,
        hasAudio: hadAudio
      });
      console.log('[QR offscreen] saved recording id=', id, 'size=', blob.size);
      send({ type: 'recordingEnded', recordingId: id, ext: recExt, sizeBytes: blob.size, durationMs });
    } catch (e) {
      console.error('[QR offscreen] failed to save recording', e);
      send({ type: 'error', error: 'Failed to save recording: ' + (e.message || e) });
    }
    cleanup();
  };
  recorder.start(2000); // 2-second timeslice
  recorderStartedAt = Date.now();
  phase = 'recording';

  // Live audio level meter — samples the destNode (or raw mic) every second
  // and logs RMS energy. Helps confirm whether silent recordings are due to
  // the source being silent or the pipeline being silent.
  startAudioMeter();
}

function startAudioMeter() {
  stopAudioMeter();
  if (!mixedStream || mixedStream.getAudioTracks().length === 0) {
    console.log('[QR offscreen] no audio track — meter disabled');
    notify(
      'Recording will be silent',
      'No audio source captured. Make sure mic is granted (click the recorder icon, you should see a permissions page) or that the tab you\'re recording is playing audio.'
    );
    return;
  }
  // CRITICAL: meter the MIC TRACK directly, not the mixed output. If we metered
  // the mixed track, tab audio could mask a dead mic — the meter would show
  // healthy levels while the mic produced silence. Splitting the meters means
  // we can tell the user "your mic specifically went dead" vs "everything is
  // silent". When there's no mic, we fall back to metering the final track.
  try {
    audioMeterCtx = new AudioContext();
    if (audioMeterCtx.state === 'suspended') audioMeterCtx.resume().catch(() => {});

    const startWatcher = (track, label, dbfsThreshold = -55, silentSecondsBeforeWarn = 6) => {
      if (!track) return null;
      const analyser = audioMeterCtx.createAnalyser();
      analyser.fftSize = 1024;
      const src = audioMeterCtx.createMediaStreamSource(new MediaStream([track]));
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let silentSeconds = 0;
      let warned = false;
      return setInterval(() => {
        // If track went away, stop quietly — lifecycle handler will warn user.
        if (track.readyState !== 'live') return;
        if (track.muted) {
          // Don't double-warn here — the mute event handler already did.
          silentSeconds = 0; // reset so we don't fire AGAIN when it unmutes
          return;
        }
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
        console.log(`[QR offscreen] ${label} RMS=${rms.toFixed(4)} dBFS=${dbfs.toFixed(1)}`);
        if (dbfs < dbfsThreshold) silentSeconds++;
        else silentSeconds = 0;
        if (!warned && silentSeconds >= silentSecondsBeforeWarn) {
          warned = true;
          if (label === 'mic') {
            notify(
              'Mic appears silent',
              `The mic has been silent for ${silentSecondsBeforeWarn}s. If you're talking, your mic may be muted at the OS level (System Settings → Privacy → Microphone) or routed to the wrong device. Click ↻ Retry on the bar to re-acquire.`
            );
          } else {
            notify(
              'No audio detected',
              `The recording has been silent for ${silentSecondsBeforeWarn}s. Check that the tab you're recording is playing audio and your mic isn't muted.`
            );
          }
        }
      }, 1000);
    };

    const micTrack = micStream && micStream.getAudioTracks()[0];
    if (micTrack) {
      audioMeterMicInterval = startWatcher(micTrack, 'mic');
    } else {
      // No mic; meter the final track so we still catch silent recordings.
      audioMeterFinalInterval = startWatcher(mixedStream.getAudioTracks()[0], 'final');
    }
  } catch (e) {
    console.warn('[QR offscreen] audio meter failed', e);
  }
}

let audioMeterCtx = null;
let audioMeterMicInterval = null;
let audioMeterFinalInterval = null;
function stopAudioMeter() {
  if (audioMeterMicInterval) { clearInterval(audioMeterMicInterval); audioMeterMicInterval = null; }
  if (audioMeterFinalInterval) { clearInterval(audioMeterFinalInterval); audioMeterFinalInterval = null; }
  if (audioMeterCtx) { try { audioMeterCtx.close(); } catch {} audioMeterCtx = null; }
}

// Title hint passed from SW so the saved recording remembers the source tab.
let pendingTitle = '';

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
  attachDeviceChangeListener();
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

let retryInFlight = false;
async function retry() {
  // Re-acquire the MIC and rebuild the audio graph, then start a fresh
  // recorder. This is the recovery path for a dead/muted mic — without
  // re-acquisition, retry would just record silence again.
  if (retryInFlight) {
    console.log('[QR offscreen] retry() ignored — already in flight');
    return;
  }
  if (!recorder && phase !== 'recording' && phase !== 'awaiting-begin') return;
  retryInFlight = true;
  console.log('[QR offscreen] retry() — re-acquiring mic');
  const old = recorder;
  recorder = null; // detach handlers' "save" branch
  if (old) {
    old.onstop = null;
    old.ondataavailable = null;
    old.onerror = null;
    try { old.stop(); } catch {}
  }
  chunks = [];
  stopAudioMeter();

  // Tear down the old mic-side of the audio graph (keep tab audio + screen
  // video — those are still valid).
  if (micSrc) { try { micSrc.disconnect(); } catch {} }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  micSrc = null;

  // Re-acquire mic with health verification. May return null if all mics fail.
  const newMicStream = await acquireMicWithVerification();
  if (newMicStream) attachMicTrackLifecycleHandlers(newMicStream);
  micStream = newMicStream;

  // Rebuild audio track. If we have an audioCtx (mixed mode), reattach the
  // new mic source to the existing destNode. Otherwise rebuild mixedStream
  // from raw tracks.
  const sysTracks = screenStream ? screenStream.getAudioTracks() : [];
  let audioTrack = null;
  if (audioCtx && destNode && micStream) {
    if (!micGain) {
      micGain = audioCtx.createGain();
      micGain.gain.value = 1.0;
      micGain.connect(destNode);
    }
    micSrc = audioCtx.createMediaStreamSource(micStream);
    micSrc.connect(micGain);
    audioTrack = destNode.stream.getAudioTracks()[0];
  } else if (micStream && sysTracks.length > 0) {
    // No prior mixer — build one now so both sources end up in the recording.
    try {
      audioCtx = new AudioContext();
      attachAudioContextRecovery(audioCtx);
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      destNode = audioCtx.createMediaStreamDestination();
      micGain = audioCtx.createGain(); micGain.gain.value = 1.0; micGain.connect(destNode);
      micSrc = audioCtx.createMediaStreamSource(micStream); micSrc.connect(micGain);
      const sysOnly = new MediaStream([sysTracks[0]]);
      sysSrc = audioCtx.createMediaStreamSource(sysOnly);
      sysGain = audioCtx.createGain(); sysGain.gain.value = 1.0;
      sysSrc.connect(sysGain).connect(destNode);
      audioTrack = destNode.stream.getAudioTracks()[0];
    } catch (e) {
      console.warn('[QR offscreen] retry: AudioContext rebuild failed, mic-only', e);
      audioTrack = micStream.getAudioTracks()[0];
    }
  } else if (micStream) {
    audioTrack = micStream.getAudioTracks()[0];
  } else if (sysTracks.length > 0) {
    audioTrack = sysTracks[0];
  }

  const videoTrack = screenStream ? screenStream.getVideoTracks()[0] : null;
  if (!videoTrack) {
    notify('Retry failed', 'Screen capture was lost. Click the recorder icon again to start fresh.');
    send({ type: 'error', error: 'Retry failed: no screen stream.' });
    cleanup();
    retryInFlight = false;
    return;
  }
  const tracks = [videoTrack];
  if (audioTrack) tracks.push(audioTrack);
  mixedStream = new MediaStream(tracks);

  startRecorder();
  send({ type: 'recordingRestarted' });
  retryInFlight = false;
}

async function changeMic(deviceId) {
  if (!audioCtx || !destNode) {
    notify('Mic switch unavailable', "This recording started without a mic in the audio mixer. Click ↻ Retry on the bar to start over and pick this mic from the start.");
    return;
  }
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      }
    });
    const newTrack = newStream.getAudioTracks()[0];
    const ok = await verifyMicTrackHealthy(newTrack);
    if (!ok) {
      newStream.getTracks().forEach((t) => t.stop());
      notify('Mic switch failed', 'The selected mic returned silence (Bluetooth flap or device busy). Keeping the previous mic.');
      return;
    }
    // Disconnect old source
    if (micSrc) { try { micSrc.disconnect(); } catch {} }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = newStream;
    if (!micGain) {
      micGain = audioCtx.createGain();
      micGain.gain.value = 1.0;
      micGain.connect(destNode);
    }
    micSrc = audioCtx.createMediaStreamSource(micStream);
    micSrc.connect(micGain);
    attachMicTrackLifecycleHandlers(micStream);
    // Restart meter so we're now watching the new mic.
    startAudioMeter();
  } catch (e) {
    console.warn('[QR offscreen] mic switch failed', e);
    notify('Mic switch failed', e.message || String(e));
  }
}

function cleanup() {
  try { stopRecorder(); } catch {}
  try { stopAudioMeter(); } catch {}
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

// Track recording start time so onstop can compute duration.
let recorderStartedAt = 0;

// Live blob URLs — kept so SW can ask us to revoke after a download finishes.
const liveBlobUrls = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'startTabCapture': pendingTitle = msg.tabTitle || ''; start(msg.streamId, msg.tabId); return false;
    case 'beginRecord': beginRecord(); return false;
    case 'stop': stopRecording(); return false;
    case 'retry': retry(); return false;
    case 'micChange': changeMic(msg.deviceId); return false;
    case 'toggle': {
      if (phase !== 'idle') stopRecording();
      return false;
    }
    case 'prepareBlobUrl': {
      // SW can't call URL.createObjectURL in MV3; do it here and send the URL
      // back. Same-origin blob URLs work across all extension contexts.
      (async () => {
        try {
          const rec = await QRDB.get(msg.id);
          if (!rec) { sendResponse({ ok: false, error: 'Recording not found in IDB' }); return; }
          if (!rec.blob || !rec.blob.size) { sendResponse({ ok: false, error: 'Recording blob is empty' }); return; }
          const url = URL.createObjectURL(rec.blob);
          liveBlobUrls.add(url);
          sendResponse({
            ok: true, url,
            mime: rec.mime, ext: rec.ext, title: rec.title, createdAt: rec.createdAt
          });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true; // keep channel open for async sendResponse
    }
    case 'revokeBlob': {
      try { URL.revokeObjectURL(msg.url); } catch {}
      liveBlobUrls.delete(msg.url);
      return false;
    }
    case 'forceCleanup': {
      // SW asks us to release any held streams (e.g. after a "tab already
      // captured" error from a stale prior attempt).
      cleanup();
      return false;
    }
  }
  return false;
});
