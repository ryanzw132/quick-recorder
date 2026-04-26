# Quick Recorder

A one-click Chrome extension that records the active tab — screen, camera (as a draggable overlay), and microphone — into a single MP4 file. Comes with a built-in editor for trimming and re-sizing.

No screen picker, no setup once installed. Click the icon, get a 3-second countdown, recording starts. Click again to stop. A bottom-left popup lets you Download or Edit (auto-downloads after 30s if you do nothing).

## Features

- **One-click recording** — no picker dialog. Uses `chrome.tabCapture` to start instantly on the current tab.
- **Camera overlay** — draggable, resizable rounded-rectangle webcam bubble. Position is remembered. A subtle saturation/contrast filter is always on so the MacBook camera looks less washed out.
- **Audio** — microphone + tab audio, mixed into a single track. Mic priority: USB → Bluetooth/AirPods → built-in.
- **Built-in editor** — after recording, a popup offers Download or Edit. Edit opens a tab with a video player + timeline. Set trim start/end, mark cut regions to delete, scrub the playhead. Re-export to a target file size (5/10/25/50/100/250 MB or Original) — the editor picks the resolution and bitrate automatically. Powered by ffmpeg.wasm (single-thread).
- **Project library** — recordings you opened in the editor but didn't export persist in a sidebar so you can come back to them.
- **MP4 output** — native `MediaRecorder` MP4 (Chrome 130+). Falls back to WebM on older versions.
- **File named after the tab** — recording on a tab titled "Above and Beyond" downloads as `Above and Beyond.mp4`.
- **1080p / 30fps** — capped to keep raw file size manageable (~12 MB/min). The editor can re-encode smaller.

## Install (unpacked)

1. Clone this repo or download as a zip and unzip.
2. Open Chrome and go to `chrome://extensions`.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the `quick-recorder` directory.
5. Pin the extension (puzzle icon → pin Quick Recorder).
6. A tab will open asking you to grant microphone permission. Click **Grant Microphone Access** → **Allow**. The tab closes itself.

## Use

1. Open the page you want to record (must be a regular `http(s)` page — not `chrome://`, not the Web Store, not the PDF viewer).
2. Click the Quick Recorder icon.
3. Camera overlay appears, then a 3-2-1 countdown.
4. Recording starts. Drag the camera bubble anywhere; resize from the bottom-right corner.
5. Click the icon again, or click **■ Stop** in the floating bar, to finish.
6. The MP4 downloads automatically.

## Trade-offs (read me)

- **Tab-only**: records only the tab you started on. If you `Cmd-Tab` to another app, that app won't be in the recording — the tab keeps recording in the background.
- **Tab audio**, not system audio: whatever's playing in the captured tab is included. YouTube playing in a different tab is not.
- **2-minute "small file" limit**: at 1.5 Mbps + 96 kbps, recordings stay around 12 MB/minute. Long recordings will exceed 25 MB.
- **Camera bubble visible only on Chrome tabs**: the bubble is rendered into the tab's DOM. It stays in the recording because tab capture sees it. If you switch tabs during recording, the bubble follows you, but the recording itself stays on the original tab.

## Architecture

- `manifest.json` — MV3
- `background.js` — service worker, orchestrator. Owns action click → tab capture → offscreen lifecycle → editor tab spawning → downloads.
- `offscreen.js` — owns `MediaRecorder`, audio mixing graph, blob assembly. Saves recordings to IndexedDB on stop.
- `content.js` — injected into the active tab. Renders the floating control bar, camera bubble, and post-record popup inside a Shadow DOM.
- `editor.html` / `editor.js` / `editor.css` — full-page editor in a separate tab. Reads recording from IndexedDB, renders timeline canvas, trim/cut interactions, runs ffmpeg.wasm for re-encoding.
- `lib/db.js` — IndexedDB helper shared by SW, offscreen, editor.
- `lib/ffmpeg/` — bundled ffmpeg.wasm (~32 MB) for client-side re-encoding.
- `permissions.html` / `permissions.js` — first-run page that triggers the mic permission prompt.
- `icons/` — record-dot icon at 16/32/48/128 px.

## Permissions

- `tabCapture` — to capture the active tab without a picker.
- `offscreen` — `MediaRecorder` runs in an offscreen document so the recording survives across page navigations.
- `scripting`, `tabs`, `activeTab` — to inject the floating UI.
- `downloads` — to save the MP4.
- `storage` — to remember the camera bubble's position and size.
- `notifications` — for error messages (mic permission missing, etc.).
- `host_permissions: <all_urls>` — needed because the floating UI is injected into whatever tab you're recording.

## Built with help from

Multiple Codex and Claude review agents helped find and fix bugs during development. The architecture follows patterns from [Screenity](https://github.com/alyssaxuu/screenity) (offscreen document + content-script overlay).

## License

MIT
