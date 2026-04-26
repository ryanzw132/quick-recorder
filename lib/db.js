// Shared IndexedDB layer for Quick Recorder.
// Used by offscreen.js (write), background.js (status updates), editor.js (read).
// Exposes a global QRDB object — included via classic <script> in extension
// pages, or imported via importScripts in the SW.

(function (root) {
  const DB = 'qr-db';
  const STORE = 'recordings';
  const VERSION = 1;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function asPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Wait for the transaction to fully commit. Without this, a request can
  // resolve before the IDB write is durable and a subsequent reader (e.g.,
  // a freshly-opened editor tab) may not see the record.
  function waitTx(store) {
    const t = store.transaction;
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onabort = t.onerror = () => reject(t.error || new Error('IDB tx failed'));
    });
  }

  // Save a recording. Returns the auto-assigned id.
  async function save({ blob, mime, ext, title, durationMs, hasAudio }) {
    const store = await tx('readwrite');
    const record = {
      blob,
      mime,
      ext,
      title: title || '',
      durationMs: durationMs || 0,
      sizeBytes: blob.size,
      hasAudio: hasAudio !== false, // assume yes unless explicitly false
      createdAt: Date.now(),
      status: 'pending' // 'pending' | 'editing' | 'exported'
    };
    const id = await asPromise(store.add(record));
    await waitTx(store);
    return id;
  }

  async function get(id) {
    const store = await tx('readonly');
    return await asPromise(store.get(id));
  }

  async function setStatus(id, status) {
    const store = await tx('readwrite');
    const rec = await asPromise(store.get(id));
    if (!rec) return;
    rec.status = status;
    await asPromise(store.put(rec));
    await waitTx(store);
  }

  async function remove(id) {
    const store = await tx('readwrite');
    await asPromise(store.delete(id));
    await waitTx(store);
  }

  // List all recordings with the given status, newest first. Omit blob payload
  // to keep the response small for sidebar listings.
  async function listByStatus(status) {
    const store = await tx('readonly');
    const idx = store.index('status');
    const req = idx.getAll(status);
    const records = await asPromise(req);
    return records
      .map(({ blob, ...meta }) => meta)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async function listEditing() {
    return listByStatus('editing');
  }

  root.QRDB = {
    save, get, setStatus, remove, listEditing, listByStatus
  };
})(typeof self !== 'undefined' ? self : this);
