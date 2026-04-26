const grantBtn = document.getElementById('grant');
const status = document.getElementById('status');

grantBtn.addEventListener('click', async () => {
  grantBtn.disabled = true;
  status.className = '';
  status.textContent = 'Requesting permission…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    // Persist a flag the SW reads — this lets the next recording skip the
    // permissions check entirely.
    await chrome.storage.local.set({ micGranted: true });
    status.className = 'ok';
    status.textContent = '✓ Microphone enabled. Closing this tab…';
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    await chrome.storage.local.set({ micGranted: false });
    status.className = 'err';
    status.textContent = 'Failed: ' + (e.message || String(e)) + '. If you clicked Block, open chrome://settings/content/microphone and remove this extension from the Block list, then try again.';
    grantBtn.disabled = false;
  }
});
