# CoLive Architectural Decisions

This document records architectural, protocol, and design decisions made during the development of CoLive.

---

## 1. Monorepo Structure and Package Boundaries
- **Decision**: Use npm workspaces with 4 core packages:
  - `packages/protocol`: Types, Zod schemas, binary frame codec, pure utilities (no VS Code dependency).
  - `packages/server`: Standalone Node 20 WebSocket relay server.
  - `packages/extension`: VS Code extension targeting engine `^1.90.0`.
  - `packages/e2e`: Headless end-to-end simulation tests.
- **Rationale**: Strict isolation ensures protocol definitions can be shared cleanly across server, extension, and headless bots without leaking VS Code APIs or Node-specific dependencies inappropriately.

## 2. Text Synchronization with Yjs CRDT
- **Decision**: One `Y.Doc` per open file, with `Y.Text` containing file content. Host is the sole persistence authority to disk.
- **Rationale**: Prevents write conflicts across distributed participants and guarantees mathematical convergence without complex operational transformation servers.

## 3. Host-Authoritative Persistence & Guest Virtual Filesystem
- **Decision**: The host's local files remain the single source of truth. Guests access the workspace via a custom `vscode.FileSystemProvider` (`colive:/<workspaceName>/<relPath>`).
- **Rationale**: No need for guests to download entire git histories or have build tools locally. Preserves host-side hooks, formatters, and disk state.

## 4. Host-Controlled Comments (`comment.op`)
- **Decision**: The host is the only direct writer to the shared `__comments__` `Y.Map`. Guests submit validated `comment.op` JSON messages which the host verifies and commits.
- **Rationale**: Allows strict permission gating, author verification, and size validation before mutating the shared comments CRDT map.

## 5. End-to-End Encryption (E2EE)
- **Decision**: Invite secrets are never sent to the server in plaintext. The relay receives only the SHA-256 hash or `authKey` derived via HKDF. Content payloads (Yjs binary frames, file contents, chat) are encrypted with an `encKey` derived via HKDF using AES-GCM (WebCrypto).
- **Rationale**: Zero-trust architecture ensures relay operators or compromised servers cannot inspect source code, file contents, or chat messages.
