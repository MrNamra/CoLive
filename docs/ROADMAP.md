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

## Phase 2: Rich Development Capabilities (v0.2.0 - Completed)
- [x] **Language Feature Proxying (LSP Mirroring)**:
  - Lightweight LSP proxy over relay RPC channel (`lsp.hover`, `lsp.completion`, `lsp.definition`, `lsp.references`).
  - Registered `HoverProvider`, `CompletionItemProvider`, `DefinitionProvider`, `ReferenceProvider` on `colive` URI schemes.
  - Portable path re-mapping between host local files and guest `colive:/` workspace URIs.
- [x] **Shared Interactive Debugging**:
  - Broadcast debug state (`stopped`, `running`, `inactive`) via `DebugAdapterTracker` event interception.
  - Remote DAP call stack inspection (`debug.stack.req`) and variable tree inspection (`debug.variables.req`).
  - Guest stepping commands (`colive.debugContinue`, `stepOver`, `stepInto`, `stepOut`, `pause`).
  - Bidirectional breakpoint synchronization across host and guest editors (`debug.breakpoints`).
- [x] **Binary Asset & Image Previews**:
  - Chunked file streaming (`fs.readChunk.req` / `fs.readChunk.res`) for large assets up to 10MB.
  - Native binary image rendering in guest virtual filesystem for `.png`, `.jpg`, `.svg`, `.webp`, `.ico`.
  - Custom Readonly Editor Provider (`colive.imagePreview`) with zoom in/out/reset controls and metadata banner.

---

## Phase 3: Universal Client (v1.0.0)

### 4. Web Editor Integration (`vscode.dev`)
- Support running the CoLive guest extension entirely inside browser-based editors like `github.dev` and `vscode.dev` without local editor installation.
- Use native browser WebSockets and IndexedDB for offline awareness caching.
