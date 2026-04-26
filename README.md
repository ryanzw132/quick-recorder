# Quick Recorder

A one-click Chrome extension that records the active tab — screen, camera (as a draggable overlay), and microphone — into a single MP4 file.

No screen picker, no setup once installed. Click the icon, get a 3-second countdown, recording starts. Click again to stop, the file downloads automatically named after the tab.

## Features

- **One-click recording** — no picker dialog. Uses `chrome.tabCapture` to start instantly on the current tab.
- **Camera overlay** — draggable, resizable rounded-rectangle webcam bubble. Position is remembered between sessions.
- **Audio** — microphone + tab audio, mixed into a single track.
- **MP4 output** — native `MediaRecorder` MP4 (Chrome 130+). Falls back to WebM on older versions.
- **Compact controls** — bar with timer, retry, stop, and icon-button menus for camera/mic device selection.
- **File named after the tab** — recording on a tab titled "Above and Beyond" downloads as `Above and Beyond.mp4`.
- **1080p / 30fps** — capped to keep file size manageable (~12 MB/min).

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
- `background.js` — service worker, orchestrator. Owns action click → tab capture → offscreen lifecycle → downloads.
- `offscreen.js` — owns `MediaRecorder`, audio mixing graph, blob assembly. Captures via `chrome.tabCapture` stream id passed from the SW.
- `content.js` — injected into the active tab. Renders the floating control bar and camera bubble inside a Shadow DOM (so hostile page CSS can't break it).
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
