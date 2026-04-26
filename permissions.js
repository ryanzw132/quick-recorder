const grantBtn = document.getElementById('grant');
const status = document.getElementById('status');

grantBtn.addEventListener('click', async () => {
  grantBtn.disabled = true;
  status.className = '';
  status.textContent = 'Requesting permissions…';

  let micOk = false, camOk = false;
  let micErr = '', camErr = '';

  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    micOk = true;
  } catch (e) { micErr = e?.message || String(e); }

  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    camOk = true;
  } catch (e) { camErr = e?.message || String(e); }

  if (micOk && camOk) {
    status.className = 'ok';
    status.textContent = '✓ Mic + camera enabled. Closing this tab…';
    setTimeout(() => window.close(), 1200);
  } else if (micOk || camOk) {
    status.className = 'err';
    const missing = !micOk ? 'Microphone' : 'Camera';
    const reason = !micOk ? micErr : camErr;
    status.textContent = `Partial: ${missing} not granted (${reason}). Recording will work but the missing source will be silent/disabled. Open chrome://settings/content and remove this extension from the Block list, then click again.`;
    grantBtn.disabled = false;
  } else {
    status.className = 'err';
    status.textContent = `Failed: ${micErr || camErr}. If you clicked Block, open chrome://settings/content and remove this extension from the Block list, then try again.`;
    grantBtn.disabled = false;
  }
});
