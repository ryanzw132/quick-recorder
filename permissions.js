const grantBtn = document.getElementById('grant');
const status = document.getElementById('status');

grantBtn.addEventListener('click', async () => {
  grantBtn.disabled = true;
  status.className = '';
  status.textContent = 'Requesting permission…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Immediately stop — we just needed the grant.
    stream.getTracks().forEach((t) => t.stop());
    status.className = 'ok';
    status.textContent = '✓ Microphone enabled. Closing this tab…';
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    status.className = 'err';
    status.textContent = 'Failed: ' + (e.message || String(e)) + '. If you clicked Block, open chrome://settings/content/microphone and remove this extension from the Block list, then try again.';
    grantBtn.disabled = false;
  }
});
