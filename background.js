// Quick Recorder — service worker (orchestrator)
// Owns: action click, offscreen lifecycle, content-script injection, downloads.
// Never owns streams.

// Pull in shared IndexedDB helper. db.js exposes self.QRDB.
try { importScripts('lib/db.js'); } catch (e) { console.warn('[QR sw] importScripts(db.js) failed', e); }

const OFFSCREEN_PATH = 'offscreen.html';

// In-memory state. SW dies, but offscreen doc keeps SW alive during recording.
// `startedAt > 0` means recording has truly begun (post-countdown). During the
// startup window (picker + countdown), startedAt stays 0.
let state = { startedAt: 0, tabId: null, windowId: null, tabTitle: '', mics: [], uiTabs: [] };

// On cold start, the offscreen doc keeps the SW alive while recording, so if
// the SW just woke up and NO offscreen doc exists, no recording can be in
// flight — any persisted state is stale (e.g. from a crashed prior session).
// Wipe it so the next click takes the start path, not the stale toggle-stop
// branch (which silently no-ops when offscreen.phase is 'idle').
chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(async (ctxs) => {
  if (ctxs.length === 0) {
    await chrome.storage.session.remove('state').catch(() => {});
    return;
  }
  // Offscreen doc exists — restore state only if our in-memory copy is pristine.
  const s = await chrome.storage.session.get('state');
  if (!s.state) return;
  const pristine = state.startedAt === 0 && state.tabId === null &&
    (!state.uiTabs || state.uiTabs.length === 0) &&
    (!state.mics || state.mics.length === 0);
  if (pristine) state = { ...state, ...s.state, uiTabs: s.state.uiTabs || [] };
});

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

// Singleton creating-promise to prevent the documented race where two callers
// both pass hasOffscreen() and both try to create.
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'BLOBS'],
        justification: 'Record screen, camera, and microphone'
      })
      .catch(async (e) => {
        // Don't gate on the error message text (Chromium changes it). Re-check
        // existence: if some other caller already created the doc, we're fine.
        if (await hasOffscreen()) return;
        throw e;
      })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function injectUI(tabId) {
  if (!tabId) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    if (!state.uiTabs.includes(tabId)) state.uiTabs.push(tabId);
    persist().catch(() => {});
    return true;
  } catch (e) {
    // Most failures here are restricted URLs (chrome://, Web Store, PDFs).
    // Anything else, log so we notice.
    const m = String(e?.message || '');
    if (!/chrome:\/\/|chrome-extension:\/\/|chromewebstore|cannot access|extensions gallery|edge:\/\/|view-source:/i.test(m)) {
      console.warn('[QR] injectUI failed', e);
    }
    return false;
  }
}

function setBadge(active) {
  chrome.action.setBadgeText({ text: active ? 'REC' : '' });
  if (active) chrome.action.setBadgeBackgroundColor({ color: '#d22' });
}

const NOTIF_ICON = chrome.runtime.getURL('icons/icon128.png');
function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic', iconUrl: NOTIF_ICON, title, message, priority: 1
    }, () => void chrome.runtime.lastError);
  } catch {}
}

async function persist() {
  await chrome.storage.session.set({ state });
}

function broadcastCleanup() {
  for (const tabId of state.uiTabs) {
    chrome.tabs.sendMessage(tabId, { target: 'content', type: 'cleanup' }).catch(() => {});
  }
  state.uiTabs = [];
}

function resetState() {
  broadcastCleanup();
  state = { startedAt: 0, tabId: null, windowId: null, tabTitle: '', mics: [], uiTabs: [] };
  persist().catch(() => {});
  setBadge(false);
}

// Sanitize a tab title into a safe filename — strip illegal filesystem chars,
// collapse whitespace, cap length. Falls back to '' if nothing usable remains.
function sanitizeFilename(title) {
  if (!title) return '';
  const cleaned = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // illegal on macOS / Windows / both
    .replace(/[-]/g, '')       // control chars
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')         // no leading/trailing dots or spaces
    .trim()
    .slice(0, 100);
  return cleaned;
}

// ── Action click ──────────────────────────────────────────────────────────────
// Toggle pattern: SW always relays a single 'toggle' message to offscreen, which
// decides start vs. stop based on its own phase. This avoids the cold-start
// race where SW's in-memory state isn't yet restored from storage.
// CRITICAL: only awaited call before sendMessage is offscreen.createDocument —
// its await preserves user activation.
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[QR sw] action.onClicked tab=', tab.id, 'url=', tab.url);

  // If a recording is in progress, click toggles stop. But verify offscreen
  // doc actually exists — otherwise startedAt is stale (from a previously
  // crashed/aborted session) and we should fall through to start fresh.
  if (state.startedAt > 0) {
    if (await hasOffscreen()) {
      chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'toggle' })
        .catch((e) => { console.warn('[QR sw] toggle stop failed', e); resetState(); });
      return;
    }
    console.log('[QR sw] stale startedAt with no offscreen doc — resetting and starting fresh');
    resetState();
  }

  // Block restricted URLs — tabCapture and content scripts both fail on them.
  if (tab.url && /^(chrome|chrome-extension|edge|about|view-source|chrome-search|chrome-untrusted|devtools|file):/i.test(tab.url)) {
    notify(
      'Open a regular web page first',
      'Quick Recorder only works on regular web pages (https://...). Switch to a normal page like google.com, then click the icon.'
    );
    return;
  }

  // No-picker auto-record: get a tabCapture stream id for the active tab.
  // This must be called from a user gesture, no awaits before it.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    console.error('[QR sw] tabCapture failed', e);
    notify('Cannot start recording', 'Tab capture failed: ' + (e.message || e));
    return;
  }

  await ensureOffscreen();
  state.tabId = tab.id;
  state.windowId = tab.windowId;
  // Capture the title at click time — this is the tab the recording is starting
  // on, even if the tab later navigates to a different page.
  state.tabTitle = tab.title || '';
  chrome.runtime
    .sendMessage({
      target: 'offscreen',
      type: 'startTabCapture',
      streamId,
      tabId: tab.id,
      tabTitle: tab.title || ''
    })
    .catch((e) => {
      console.warn('[QR sw] startTabCapture send failed', e);
      resetState();
    });
  persist().catch(() => {});
});

// First-time install — open the mic permission page so the offscreen doc can
// successfully grab the mic later (offscreen is hidden so it can't show the
// prompt itself).
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
  }
  // Recreate context menu items (idempotent: remove all then add).
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'qr-open-library',
      title: 'Open Quick Recorder library',
      contexts: ['action']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'qr-open-library') {
    const windowId = tab?.windowId;
    chrome.tabs.create({
      url: chrome.runtime.getURL('editor.html?library=1'),
      ...(windowId ? { windowId } : {})
    });
  }
});

// ── Message routing ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.target) return false;

  if (msg.target === 'sw') {
    handleSW(msg, sender);
    return false;
  }
  if (msg.target === 'offscreen') {
    // Offscreen doc receives the same broadcast directly — no relay needed.
    return false;
  }
  if (msg.target === 'content' && state.tabId) {
    chrome.tabs.sendMessage(state.tabId, msg).catch(() => {});
    return false;
  }
  return false;
});

async function handleSW(msg, sender) {
  switch (msg.type) {
    case 'streamsReady': {
      console.log('[QR sw] streamsReady, injecting UI into tab', state.tabId);
      state.mics = Array.isArray(msg.mics) ? msg.mics : [];
      await persist();
      const ok = await injectUI(state.tabId);
      if (!ok) {
        notify(
          'Cannot show recording UI on this page',
          'This tab is a Chrome internal page (chrome://, Web Store, PDF, etc.). Switch to a regular web page (e.g. google.com) BEFORE clicking the extension icon. Stopping recording.'
        );
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
        break;
      }
      setTimeout(() => {
        if (state.tabId === null) return;
        chrome.tabs.sendMessage(state.tabId, {
          target: 'content', type: 'init', startedAt: 0, mics: state.mics
        }).catch((e) => console.warn('[QR sw] init send failed', e));
      }, 150);
      break;
    }
    case 'recordingEnded': {
      // v2: recording is now saved to IDB by offscreen. Show the post-record
      // popup in the recording tab; user picks Download or Edit. Do NOT
      // auto-download immediately.
      const recordingId = msg.recordingId;
      const tabId = state.tabId;
      const windowId = state.windowId;
      // Stop the bar/timer in the tab, but keep tabId/windowId in state until
      // the popup resolves (Download / Edit / 30s auto).
      setBadge(false);
      state.startedAt = 0;
      await persist();
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          target: 'content',
          type: 'showPostRecord',
          recordingId,
          windowId
        }).catch(() => {});
      }
      break;
    }
    case 'postRecordResolved': {
      // Content popup was clicked or timed out. Fully reset SW state.
      resetState();
      break;
    }
    case 'openEditor': {
      try {
        await QRDB.setStatus(msg.recordingId, 'editing');
      } catch (e) { console.warn('[QR sw] setStatus editing failed', e); }
      const url = chrome.runtime.getURL(`editor.html?id=${encodeURIComponent(msg.recordingId)}`);
      try {
        if (msg.windowId) {
          await chrome.tabs.create({ url, windowId: msg.windowId });
        } else {
          await chrome.tabs.create({ url });
        }
      } catch (e) {
        console.warn('[QR sw] open editor (windowed) failed, retrying without windowId', e);
        try { await chrome.tabs.create({ url }); }
        catch (e2) { console.error('[QR sw] open editor failed entirely', e2); }
      }
      break;
    }
    case 'requestDownload': {
      // SW reads blob from IDB, creates URL, triggers download. Doing this
      // here (not in offscreen) avoids relying on content→offscreen messaging
      // which is unreliable — content→SW always works.
      await handleDownloadRecording(msg.id, msg.deleteAfter !== false);
      break;
    }
    case 'stopRequest': {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
      break;
    }
    case 'retryRequest': {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'retry' }).catch(() => {});
      break;
    }
    case 'micChangeRequest': {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'micChange', deviceId: msg.deviceId }).catch(() => {});
      break;
    }
    case 'recordingRestarted': {
      // Retry: bump startedAt, tell UI to reset timer.
      state.startedAt = Date.now();
      await persist();
      for (const tabId of state.uiTabs) {
        chrome.tabs.sendMessage(tabId, {
          target: 'content',
          type: 'restarted',
          startedAt: state.startedAt
        }).catch(() => {});
      }
      break;
    }
    case 'recordingBegan': {
      // Content has finished countdown; offscreen is now actually recording.
      // Guard against stale messages (cancelled session, second injection).
      if (state.startedAt) break;
      state.startedAt = msg.startedAt || Date.now();
      setBadge(true);
      await persist();
      break;
    }
    case 'error': {
      console.error('[QR sw] offscreen error:', msg.error);
      resetState();
      break;
    }
    case 'micPermissionMissing': {
      // Offscreen tried mic but it failed. Open the grant page once so the
      // user can grant it without hunting through chrome://settings.
      const r = await chrome.storage.local.get('micPromptShown');
      if (!r.micPromptShown) {
        chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
        await chrome.storage.local.set({ micPromptShown: true });
      }
      break;
    }
    case 'openMicPermission': {
      chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
      break;
    }
    case 'requestRehydrate': {
      // Content asking to re-init after re-injection. Only respond if
      // recording is truly running (startedAt > 0); during startup window we
      // suppress to avoid double countdowns across tabs.
      if (state.startedAt > 0 && sender.tab) {
        if (!state.uiTabs.includes(sender.tab.id)) state.uiTabs.push(sender.tab.id);
        chrome.tabs.sendMessage(sender.tab.id, {
          target: 'content',
          type: 'init',
          startedAt: state.startedAt,
          mics: state.mics
        }).catch(() => {});
      }
      break;
    }
  }
}

// ── Re-inject UI on tab switches DURING recording (not during startup) ────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (state.startedAt === 0) return; // not recording yet (countdown phase) or idle
  state.tabId = tabId;
  await persist();
  const ok = await injectUI(tabId);
  if (!ok) return;
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, {
      target: 'content',
      type: 'init',
      startedAt: state.startedAt,
      mics: state.mics
    }).catch(() => {});
  }, 150);
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (state.startedAt === 0) return;
  if (!state.uiTabs.includes(tabId) && tabId !== state.tabId) return;
  if (info.status !== 'complete') return;
  const ok = await injectUI(tabId);
  if (!ok) return;
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, {
      target: 'content',
      type: 'init',
      startedAt: state.startedAt,
      mics: state.mics
    }).catch(() => {});
  }, 150);
});

// Drop closed tabs from uiTabs so we don't leak.
chrome.tabs.onRemoved.addListener((tabId) => {
  state.uiTabs = state.uiTabs.filter((id) => id !== tabId);
  persist().catch(() => {});
});

// ── Download flow (SW-owned, doesn't depend on offscreen messaging) ──────────
const pendingDownloads = new Map(); // downloadId -> { url, recordingId, deleteAfter }

async function handleDownloadRecording(id, deleteAfter) {
  try {
    console.log('[QR sw] handleDownloadRecording id=', id);
    const rec = await QRDB.get(id);
    if (!rec) {
      console.warn('[QR sw] downloadRecording: id not found', id);
      notify('Download failed', 'Recording not found in storage. It may have been deleted.');
      return;
    }
    const url = URL.createObjectURL(rec.blob);
    const safe = sanitizeFilename(rec.title);
    const fallback = `Recording_${new Date(rec.createdAt || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const filename = `${safe || fallback}.${rec.ext || 'mp4'}`;
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    pendingDownloads.set(downloadId, { url, recordingId: id, deleteAfter });
    console.log('[QR sw] download started, downloadId=', downloadId, 'filename=', filename);
  } catch (e) {
    console.error('[QR sw] download failed', e);
    notify('Download failed', e.message || String(e));
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingDownloads.has(delta.id)) return;
  const s = delta.state?.current;
  if (s !== 'complete' && s !== 'interrupted') return;
  const { url, recordingId, deleteAfter } = pendingDownloads.get(delta.id);
  pendingDownloads.delete(delta.id);
  try { URL.revokeObjectURL(url); } catch {}
  if (deleteAfter && s === 'complete') {
    QRDB.remove(recordingId).catch(() => {});
  } else if (s === 'complete') {
    QRDB.setStatus(recordingId, 'exported').catch(() => {});
  }
});

