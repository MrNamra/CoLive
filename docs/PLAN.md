# CoLive Implementation Plan

This document outlines the end-to-end plan for building **CoLive**, a production-grade, real-time collaboration extension for VS Code-compatible editors (VS Code, Antigravity, Cursor, VSCodium).

---

## Architecture Overview

```
 Host Window                       Relay Server (Node 20)                 Guest Window(s)
┌────────────────────┐   WebSocket  ┌─────────────────────────┐  WebSocket  ┌────────────────────┐
│ Extension (host)   │◄────────────►│ Session registry        │◄───────────►│ Extension (guest)  │
│  - Real disk files │   (JSON +    │ Routing / Auth / Rate   │  (JSON +    │  - Virtual FS      │
│  - Source of truth │    Binary)   │ Yjs fan-out / Presence  │   Binary)   │  - Remote cursors  │
│  - Yjs documents   │              │ Metrics / Web Landing   │             │  - Inline comments │
└────────────────────┘              └─────────────────────────┘             └────────────────────┘
```

- **Host-authoritative persistence**: The host machine's disk holds the truth. The host writes Yjs updates to disk atomically (debounced, temp file + rename, BOM & EOL preserved).
- **Guest virtual filesystem**: Guests access host files through `vscode.FileSystemProvider` under `colive:/<workspaceName>/<relPath>`.
- **CRDT Text Sync**: Real-time collaborative editing using Yjs (`Y.Doc` per file, `Y.Text` for content) and binary sync protocols.
- **Presence & Cursors**: Yjs Awareness protocol with `RelativePosition` mapping to maintain accurate cursors across concurrent edits.
- **Inline Comments**: VS Code Comments API backed by a host-controlled shared `Y.Map` ("__comments__").
- **Security**: Strict path sandboxing, exclude patterns, token-based session secrets (timing-safe verification, hashed at rest), end-to-end encryption (E2EE) with WebCrypto AES-GCM and HKDF keys.

---

## Strict Milestone Breakdown

### Milestone 1: Monorepo Scaffold & Tooling
- **Root Setup**:
  - `package.json` with npm workspaces (`packages/*`), scripts: `build`, `lint`, `test`, `clean`, `dev:server`, `dev:extension`.
  - `tsconfig.base.json`: TypeScript strict mode, ES2022, Node16/bundler resolution.
  - ESLint (typescript-eslint flat config) + Prettier, `.editorconfig`, `.gitignore`, `.gitattributes` (`* text=auto eol=lf`), MIT `LICENSE`.
  - `.github/workflows/ci.yml`: install, build, lint, test on Node 20.
  - `README.md` and `docs/ARCHITECTURE.md`.
- **Packages**:
  - `packages/protocol`: minimal setup, vitest configuration.
  - `packages/server`: minimal Express/Node HTTP + WS server, vitest configuration, `/health` endpoint.
  - `packages/extension`: VS Code extension manifest (`^1.90.0`), esbuild bundle configuration (`dist/extension.js`), launch configs, logger, `strings.ts`, Activity Bar container (`colive.participants`), `colive.hello` command, smoke test.
- **Done When**: `npm install`, `npm run build`, `npm run lint`, `npm test` pass; server `/health` returns `{ status: "ok" }`; extension builds.

### Milestone 2: Wire Protocol (`@colive/protocol`)
- **JSON Message Schemas (Zod)**:
  - Session lifecycle: `hello`, `helloAck`, `host.createSession`, `server.sessionCreated`, `guest.join`, `server.joinRequest`, `host.joinDecision`, `server.joinAccepted`, `server.joinRejected`, `participantJoined/Left/Updated`, `setPermission`, `kick`, `endSession`, `sessionEnded`, `ping`, `pong`.
  - Workspace RPC: `fs.list`, `fs.stat`, `fs.read`, `fs.write`, `fs.create`, `fs.delete`, `fs.rename`, `fs.watchEvent`, `workspace.info`, typed RPC error definitions.
  - Documents: `doc.open`, `doc.close`, `doc.saved`.
  - Comments: `comment.op`, `CommentThreadData`, `CommentData`.
  - Chat: `chat.message`.
  - Diagnostics: `diagnostics.update`.
  - Terminal: `terminal.open`, `terminal.data`, `terminal.input`, `terminal.resize`, `terminal.close`.
- **Binary Framing**:
  - 1-byte kind (`0x01` doc update, `0x02` awareness update) + 2-byte length-prefixed docId + binary payload.
  - Encoder/decoder helpers.
- **Utilities**:
  - `normalizeWorkspacePath`: path traversal prevention, converts backslashes, rejects `..`, null bytes, drive letters, leading slashes.
  - `isExcluded`: picomatch-based file matching with case sensitivity handling.
  - Constants: `MAX_FILE_BYTES` (5 MB), `MAX_MESSAGE_BYTES` (1 MB), `MAX_PARTICIPANTS` (10), 12-color accessible palette.
  - `sanitizeDisplayName`: strips control and RTL characters, caps at 32 chars.
- **Documentation & Tests**:
  - `docs/PROTOCOL.md` with schema documentation and Mermaid sequence diagrams.
  - 100% unit test coverage for parsers, path normalization, and binary framing.

### Milestone 3: Relay Server (`@colive/server`)
- **HTTP Endpoints**:
  - `GET /health`, `GET /metrics` (Prometheus metrics), `GET /j/:sessionId` web landing page (secret in fragment).
- **WebSocket Gateway (`/ws`)**:
  - Enforce `hello` within 5s; ping every 20s, terminate on 2 missed pongs.
  - Max JSON (1 MB) and binary frame limits (8 MB).
- **Session Management**:
  - `SessionStore` interface + `InMemorySessionStore`.
  - Secure session ID generation, timingSafeEqual comparison of SHA-256 secret hashes.
  - Single host enforcement with 60s reconnect grace window; pending joins queue (up to 5, 60s timeout).
  - Rate limiting (token bucket per connection, IP limits for session creation & failed joins).
- **Routing**:
  - Guest RPC forwarded to host with `guestId` tag; host response routed by request ID.
  - Server-side permission enforcement (drop unauthorized writes from `readOnly` guests).
  - Yjs doc update fan-out by `docId` tracking; awareness broadcast (all except sender); chat/participant broadcast.
- **Ops & Docker**:
  - Multi-stage Dockerfile + `docker-compose.yml`.
  - Graceful shutdown (`SIGTERM`).
- **Tests**:
  - Integration tests with real WS clients on random ports testing lifecycle, permissions, reconnects, rate limits.

### Milestone 4: Extension Session Layer (`packages/extension`)
- **Configuration**:
  - `colive.serverUrl`, `colive.displayName`, `colive.excludePatterns`, `colive.maxFileSizeMB`, `colive.defaultGuestPermission`, `colive.requireJoinApproval`, `colive.e2ee`.
- **Networking & State Machine**:
  - `ConnectionManager`: reconnect with exponential backoff & jitter, message queueing during reconnects, typed RPC timeouts.
  - `SessionController`: state machine (`Idle` -> `Connecting` -> `Active` -> `Reconnecting` -> `Ended`), status bar item integration.
- **Invite UX**:
  - Parse & build deep links (`vscode://...`) and paste codes (`<id>.<secret>`).
  - UriHandler with confirmation modal before join.
- **Commands & UI**:
  - `colive.startSession`, `colive.joinSession`, `colive.endSession`, `colive.copyInvite`, `colive.kickParticipant`, `colive.setParticipantPermission`.
  - Host approval modal/notification.
  - Participants Tree View with icons, roles, and status.
- **Tests**:
  - State machine, invite parsing, reconnect backoff tests, and extension-host test.

### Milestone 5: Host File Service & Guest Virtual File System
- **Host File Service**:
  - Handle `fs.list`, `fs.stat`, `fs.read`.
  - Path traversal and symlink escape verification using `fs.realpath`.
  - Exclude patterns filtering, binary file detection, file size limit.
  - Debounced file watcher (`createFileSystemWatcher`) emitting `fs.watchEvent`.
- **Guest Virtual File System**:
  - `CoLiveFileSystemProvider` for `colive:` URI scheme.
  - In-memory stat/list caching (2s) and LRU file cache (50 MB cap).
  - Error translation to `vscode.FileSystemError`.
  - Workspace folder addition with re-activation token persistence in `globalState`.
- **Tests**:
  - Symlink escapes, path traversal fixtures, and host-guest change notification test.

### Milestone 6: Real-time Co-editing with Yjs
- **Design (`docs/SYNC.md`)**:
  - CRDT model, persistence authority, origin tagging (`local-editor`, `remote`, `disk`), echo prevention with `applyingRemote` flag, UTF-16 offset handling.
- **DocumentBinding**:
  - Translate editor `contentChange` into Y.Text operations in a single transaction.
  - Yjs `observe` -> `WorkspaceEdit` on active document; safety net text resync.
- **SyncManager & Host Persistence**:
  - Doc open/close tracking, Yjs sync handshake, release after 30s idle.
  - Atomic file persistence on host, disk change merging via `fast-diff`.
  - Read-only permission enforcement on guest side (`FilePermission.Readonly`).
- **Tests**:
  - Fuzz tests with 3 clients (1,000 operations), emoji/surrogate pairs, CRLF vs LF, multi-cursor, 100 KB paste, disk merge test.

### Milestone 7: Presence, Remote Cursors, Follow Mode
- **PresenceManager**:
  - Yjs Awareness per session; throttled updates (50ms selection, 150ms viewport); idle detection.
  - RelativePosition encoding for robust cursor tracking through edits.
- **RemoteCursorRenderer**:
  - Custom decorations: selection highlight, caret line, name tag label with auto-contrast.
  - Overview ruler / minimap integration.
- **FollowController**:
  - Follow participant active editor and viewport scrolling without moving follower cursor.
  - Auto-stop on manual navigation.
- **Tests**:
  - Position mapping, clamping, follow state machine, and decoration range tests.

### Milestone 8: Inline Comments & Discussion Threads
- **Comments Architecture**:
  - Dedicated `__comments__` doc with Y.Map, host is the sole writer applying validated `comment.op`.
  - Thread anchor positioning via `RelativePosition`.
  - `vscode.comments.createCommentController`, Markdown rendering, @mention parsing.
  - Comments tree view grouped by file, unresolved status count badge, export/import commands.
- **Tests**:
  - Comment op validator, anchor resolution, mention parser, thread synchronization.

### Milestone 9: Chat, Notifications, Diagnostics & Security Hardening
- **Chat & Diagnostics**:
  - Webview View with strict CSP, sanitized text, slash commands (`/follow`, `/goto`).
  - Host diagnostic forwarding to guest `DiagnosticCollection("CoLive (host)")`.
- **Security Hardening (`docs/SECURITY.md`)**:
  - Threat model audit (path traversal, symlinks, permissions, secret timing, DoS, XSS).
  - End-to-End Encryption (E2EE): AES-GCM + HKDF key derivation via WebCrypto.
  - Sanitize display names, prevent guest workspace auto-trust or tasks execution.
- **Tests**:
  - E2EE vectors and tamper detection, XSS sanitization, diagnostic mapping.

### Milestone 10: Polish, Documentation, E2E Testing & Packaging
- **Onboarding & Polish**:
  - Walkthrough with 4 steps (`docs/walkthrough/*.md`).
  - Keybindings, accessibility labels, session info command.
  - Comprehensive documentation: `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `ROADMAP.md`, `DEPLOY.md`, `RELEASE.md`.
- **Testing & Scripts**:
  - `scripts/dev-two-windows.sh` and `.ps1`.
  - Headless E2E test suite in `packages/e2e` (5,000 operations, bot host + 2 bot guests).
  - Load test script `scripts/loadtest.ts`.
- **Packaging**:
  - Extension icon, `.vscodeignore`, production bundle, `.vsix` packaging.

### Milestone 11: Shared Terminal (Optional Stretch)
- Shared Pseudoterminal implementation on host (spawning shell) streaming to guest read-only terminal, with host-granted input permissions and attribution.
