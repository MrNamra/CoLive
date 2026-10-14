# CoLive Project Roadmap 🗺️

This document outlines the architectural and capability trajectory for CoLive across upcoming milestones.

## Phase 1: Core Collaboration Foundation (v0.1.0 - Current)
- [x] Monorepo scaffold with TypeScript strict mode, ESLint, and Vitest.
- [x] Wire protocol with Zod schemas, binary framing, and RPC conventions.
- [x] Node.js WebSocket relay server with token bucket rate limiting and session management.
- [x] Host local file sync and guest virtual filesystem (`vscode.FileSystemProvider`).
- [x] Real-time text co-editing via Yjs CRDTs with state vector diff exchange.
- [x] Awareness, carets, selections, name tags, and Follow Mode with manual auto-stop.
- [x] Threaded inline comments via VS Code Comments Controller and `RelativePosition` anchors.
- [x] Sidebar chat with strict CSP, file linkification, and slash commands.
- [x] End-to-End Encryption (E2EE) with WebCrypto HKDF + AES-256-GCM.
- [x] Shared terminal with `Pseudoterminal` and host permission toggles.

---

## Phase 2: Rich Development Capabilities (v0.2.0)

### 1. Language Feature Proxying (LSP Mirroring)
- **Problem**: Guests currently receive basic syntax highlighting, but full IntelliSense (hover info, autocomplete, go-to-definition, find references) requires language servers running on the host machine.
- **Approach**:
  - Implement a lightweight LSP proxy over the relay RPC channel.
  - Intercept `vscode.languages.registerHoverProvider`, `registerCompletionItemProvider`, and `registerDefinitionProvider` in the guest extension.
  - Forward queries to the host, query the host's active language server, and return serialized completions/definitions.

### 2. Shared Interactive Debugging
- **Problem**: Pair programming often involves joint debugging sessions.
- **Approach**:
  - Share breakpoint states (added/removed/hit) via a dedicated `Y.Map`.
  - Broadcast debug execution state (`stopped`, `running`, `stepIn`, `stepOver`).
  - Host proxies the active debug session call stack and variable inspection tree to guest debug views.

### 3. Binary Asset & Image Previews
- **Problem**: Virtual FS currently handles UTF-8 source files; large binaries are rejected to protect memory.
- **Approach**:
  - Chunked streaming for image files (`.png`, `.svg`, `.jpg`) and assets up to 10MB.
  - Implement custom `CustomReadonlyEditorProvider` to preview images in guest tabs.

---

## Phase 3: Real-Time Audio & High Concurrency (v0.3.0)

### 4. WebRTC Peer-to-Peer Voice Channels
- **Problem**: Developers need voice communication alongside code editing without third-party meeting apps.
- **Approach**:
  - Utilize WebSocket relay for WebRTC SDP offer/answer/ICE candidate signaling.
  - Establish direct P2P mesh audio channels between participants with Opus codec.
  - Display speaking indicators on participant avatars in the CoLive tree view.

### 5. Multi-Region Server Clustering & Redis Backplane
- **Problem**: Centralized relay creates cross-continent latency (e.g. EU to US).
- **Approach**:
  - Distribute relay nodes across regions (e.g. US-East, EU-Central, AP-Southeast).
  - Use Redis Pub/Sub for inter-relay session message fanout.
  - Route participants to the nearest edge server with WebSocket connection handoff.

---

## Phase 4: Universal Client (v1.0.0)

### 6. Web Editor Integration (`vscode.dev`)
- Support running the CoLive guest extension entirely inside browser-based editors like `github.dev` and `vscode.dev` without local editor installation.
- Use native browser WebSockets and IndexedDB for offline awareness caching.
