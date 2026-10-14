# CoLive Architecture and Design Decisions

This document details the architectural decisions, data flows, and security model of CoLive.

---

## 1. High-Level Topology

CoLive uses a **hub-and-spoke star topology** connected through a WebSocket relay server:

```
Host Window (Local Disk) <--- Outbound WS ---> Relay Server <--- Outbound WS ---> Guest Window(s)
```

### Why a Relay Server?
- **Firewall & NAT Traversal**: Direct peer-to-peer (P2P/WebRTC) connections fail across corporate firewalls, symmetric NATs, and VPNs without complex STUN/TURN infrastructure. By using standard outbound WebSocket connections (ports 80/443), connection establishment is 100% reliable.
- **Single Host-Authority**: The host holds the authentic disk files and git context; the relay coordinates routing and fan-out without storing files.

---

## 2. Key Subsystems

| Concern | Design Decision | Rationale |
|---|---|---|
| **Text Sync** | Yjs CRDT (`Y.Doc` per file, `Y.Text`) | Mathematical convergence, battle-tested CRDT, minimal network payloads, binary delta protocol. |
| **Persistence** | Host is the sole disk writer | Prevents disk write races; atomic write via temp file + rename; external disk changes merged into Yjs via `fast-diff`. |
| **Virtual FS** | `vscode.FileSystemProvider` (`colive:`) | Guests view the host's files as a standard folder in VS Code with zero disk footprint on the guest machine. |
| **Presence** | Yjs Awareness protocol | Shares cursor positions, selections, viewport ranges, and active file paths in lightweight binary broadcasts. |
| **Cursors** | `RelativePosition` mapping | Remote cursors maintain accurate document anchors even during concurrent remote edits. |
| **Comments** | VS Code Comments API + Host-written `Y.Map` | Comments sync via `__comments__` document; only the host commits validated `comment.op` operations. |
| **Security** | Path sandboxing, exclude patterns, E2EE | Strict validation prevents directory traversal (`../`) and symlink escapes; sensitive files (`.env`) are hidden. |

---

## 3. Data & Communication Protocol

Communication consists of two channel layers over a single multiplexed WebSocket:
1. **JSON Control Messages (`v: 1`)**:
   - Connection & authentication handshake (`hello`, `helloAck`).
   - Session lifecycle (`createSession`, `join`, `joinDecision`, `setPermission`, `kick`, `endSession`).
   - Workspace RPCs (`fs.list`, `fs.stat`, `fs.read`, `fs.write`, `fs.create`, `fs.delete`, `fs.rename`).
   - Comments, chat, and diagnostic updates.
2. **Binary Frames (`kind` byte + docId + payload)**:
   - `0x01`: Yjs document sync updates and state vectors.
   - `0x02`: Yjs Awareness presence updates.

---

## 4. Resilience and Disconnects

- **Graceful Reconnection**: Both host and guests implement exponential backoff with jitter (1s to 30s cap).
- **Host Grace Period**: If the host disconnects temporarily, the relay holds the session for 60 seconds while notifying guests with a "Host reconnecting..." indicator.
- **Guest Token**: Accepted guests receive a `guestToken` allowing them to reconnect without requiring host re-approval.
- **CRDT State Resync**: Upon reconnecting, open documents perform state-vector synchronization (`sync step 1 & 2`) to seamlessly merge any edits made while offline.
