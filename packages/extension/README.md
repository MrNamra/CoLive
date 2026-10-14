# CoLive - Real-Time Collaboration for VS Code 🚀

**Next-generation, real-time collaboration extension for VS Code-compatible editors (VS Code, Cursor, VSCodium).**

Work together in the same workspace on one machine's files anywhere in the world: live co-editing, remote cursors & selections, inline code comments, follow mode, session chat, shared diagnostics, and shared terminal.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Engines: VS Code ^1.90.0](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC.svg)](https://code.visualstudio.com/)
[![E2E Encryption](https://img.shields.io/badge/Security-E2EE%20(AES--256--GCM)-success.svg)](https://github.com/MrNamra/CoLive/blob/master/docs/SECURITY.md)
[![Zero Telemetry](https://img.shields.io/badge/Telemetry-Zero%20(100%25%20Private)-brightgreen.svg)](https://github.com/MrNamra/CoLive#telemetry-guarantee)

---

## ⚡ Features at a Glance

- **Yjs State-Based CRDTs**: Offline-safe real-time collaborative text editing with instant conflict-free resolution.
- **Host-Authoritative Persistence**: Atomic file writes (`.tmp` + rename) with `fast-diff` 3-way merge on external disk modifications.
- **Native Virtual FileSystem (`colive:/`)**: Remote guests explore the workspace seamlessly via VS Code's native `FileSystemProvider`.
- **Presence & Remote Cursors**: Live color-coded carets, alpha-blended selections, and accessible name tags.
- **Follow Mode**: Seamlessly follow another developer's editor viewport with automatic un-follow on manual caret movement.
- **Threaded Inline Comments**: VS Code Comments controller integration anchored with CRDT `RelativePosition` to prevent comment drift.
- **Integrated Sidebar Chat**: Team chat with slash commands (`/who`, `/leave`, `/clear`, `/help`) and clickable file links.
- **Shared Diagnostics & Terminal**: Broadcast host language diagnostics and share terminal sessions with permission control.
- **End-to-End Encryption (E2EE)**: Authenticated WebCrypto AES-256-GCM encryption with HKDF-SHA256 key derivation.
- **Zero Telemetry**: No trackers, no telemetry beacons, and zero code retained on servers.

---

## 🚀 Quick Start

### For Hosts (Sharing a Workspace)

1. **Open your project folder** in VS Code, Cursor, or VSCodium.
2. Click **"Share"** in the status bar (or press `Ctrl+Alt+L S` / `Cmd+Alt+L S`, or run `CoLive: Share Workspace (Start Session)`).
3. Choose guest permission: **Read-Write** (collaborative) or **Read-Only** (review mode).
4. An invite link is copied to your clipboard (e.g. `colive://join/<sessionId>#secret=...`). Share it with your peers!

### For Guests (Joining a Session)

1. Open your editor and click **"Join"** in the status bar (or press `Ctrl+Alt+L J` / `Cmd+Alt+L J`, or run `CoLive: Join Collaboration Session`).
2. Paste the invite link or Session ID.
3. Once approved by the host, the shared workspace immediately opens in your editor under `colive:/`!

---

## ⌨️ Default Keybindings

CoLive registers a dedicated chord prefix: `Ctrl+Alt+L` (Linux/Windows) or `Cmd+Alt+L` (macOS):

| Command | Chord | Action |
| :--- | :--- | :--- |
| `colive.startSession` | `Ctrl+Alt+L S` | Start sharing current workspace |
| `colive.joinSession` | `Ctrl+Alt+L J` | Join a session with link or ID |
| `colive.stopSession` | `Ctrl+Alt+L X` | Stop hosting or leave session |
| `colive.followParticipant` | `Ctrl+Alt+L F` | Toggle Follow Mode on selected peer |
| `colive.openChat` | `Ctrl+Alt+L C` | Focus CoLive Team Chat |
| `colive.copyInviteLink` | `Ctrl+Alt+L I` | Copy session invite link to clipboard |

---

## ⚙️ Configuration Settings

Customize CoLive via Settings (`settings.json`):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `colive.serverUrl` | `ws://localhost:8787/ws` | WebSocket URL of the CoLive relay server |
| `colive.displayName` | `""` (System username) | Display name visible to participants |
| `colive.cursorColor` | `""` (Auto-assigned) | Preferred cursor color (hex) |
| `colive.defaultPermission` | `"readWrite"` | Default permission for joined guests (`readWrite` \| `readOnly`) |
| `colive.followMode` | `true` | Enable following when invited |
| `colive.showRemoteSelection` | `true` | Render semi-transparent remote selections |
| `colive.showRemoteCursorLabels` | `true` | Render name tags above remote carets |
| `colive.e2ee` | `true` | Enable End-to-End Encryption for document & awareness updates |
| `colive.autoSaveHost` | `true` | Persist Yjs document changes to host disk |
| `colive.saveDebounceMs` | `500` | Milliseconds to debounce disk writes on the host |
| `colive.excludePatterns` | `[".env*", "**/.git/**", "**/id_rsa*", "**/node_modules/**"]` | Glob patterns strictly blocked from guest access |

---

## 🔒 Security & Privacy

1. **End-to-End Encryption**: Document updates, awareness, and chat are encrypted using AES-256-GCM. The relay server is zero-knowledge.
2. **Strict Path Sandboxing**: Path traversal attacks (`../`) and out-of-workspace symlinks are strictly blocked by host verification.
3. **Sensitive File Exclusions**: Excluded files (`.env*`, `.git`, private keys) cannot be read, listed, or edited by guests.
4. **Zero Code Retention**: Sessions run in memory; when closed, all buffers are cleared.

---

## 📄 License

MIT © [CoLive Authors](https://github.com/MrNamra/CoLive/blob/master/LICENSE)
