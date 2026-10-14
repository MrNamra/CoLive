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

## 6. Message Envelope vs Payload Properties (`fs.stat.res`)
- **Decision**: In `fs.stat.res`, the file's entry type is named `fileType` (`file` | `dir` | `symlink`) while the outer envelope retains `type: "fs.stat.res"`.
- **Rationale**: Prevents TypeScript and JSON property shadowing collisions on the top-level message object.

## 7. Three-Way External Disk Merging via fast-diff
- **Decision**: When an external process (git checkout, external code formatter) modifies a file on disk while participants are actively editing in memory, `HostPersistence` calculates a 3-way diff: `fastDiff(oldKnownDiskContent, newDiskContent)` and applies the edits to `Y.Text` inside a transaction tagged with origin `'disk'`.
- **Rationale**: Directly diffing `currentYText` against `newDiskContent` would erase concurrent edits made by guests that had not yet been saved to disk. Diffing the disk transformation from old-to-new preserves both external changes and in-flight collaborative typing.

## 9. Relay RPC Error Routing Expansion
- **Decision**: In `packages/server/src/relay.ts`, RPC routing recognizes `(msg.type === 'error' && msg.id)` as an RPC response from the host and routes it back directly to the requesting guest.
- **Rationale**: When a host rejects an RPC request (such as returning `{ type: 'error', id: req.id, code: 'FORBIDDEN' }`), the relay routes the error directly to the requesting guest instead of dropping it or timing out.

## 10. Headless E2E Stress Testing Strategy
- **Decision**: In `packages/e2e/tests/e2eCollab.test.ts`, 5,000 concurrent edits across 3 files are executed via batched editor transactions (`doc.transact(...)`) with 10 edits each across 500 transactions between Alice and Bob.
- **Rationale**: Mirrors realistic editor keystroke bursts, conforms to token bucket rate limiters, exercises high-throughput CRDT sync convergence, and completes in ~1.5s in CI.

## 11. Shared Terminal via Pseudoterminal & Batching
- **Decision**: Use VS Code's `Pseudoterminal` API on both host and guest with `node:child_process.spawn`. Host maintains a 2,000-line ring buffer scrollback replayed to newly connected guests. Output is batched with a 16ms / 4KB threshold, and guests are read-only by default with a host permission toggle.
- **Rationale**: Provides low-latency mirrored terminal output without requiring external terminal multiplexers, isolates guest inputs with strict host permission gating, and re-synchronizes terminal output instantly when guests join.



