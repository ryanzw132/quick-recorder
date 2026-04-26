// Quick Recorder — camera iframe.
// Loaded from the extension origin so the user grants camera permission ONCE
// (via permissions.html) and the camera works on every website without
// per-site prompts.

const v = document.getElementById('v');
let stream = null;

async function start(deviceId) {
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
        : { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    v.srcObject = stream;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ id: d.deviceId, label: d.label || 'Camera' }));
    const track = stream.getVideoTracks()[0];
    const activeId = track?.getSettings?.().deviceId || deviceId || null;
    parent.postMessage({ qr: 'cam-ready', cams, activeId }, '*');
  } catch (e) {
    parent.postMessage({ qr: 'cam-error', message: e?.message || String(e) }, '*');
  }
}

function stop() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  v.srcObject = null;
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || !m.qr) return;
  if (m.qr === 'cam-start') start(m.deviceId);
  else if (m.qr === 'cam-stop') stop();
});

start();
