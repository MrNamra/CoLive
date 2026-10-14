# CoLive Security Architecture & Threat Model

This document outlines the security architecture, threat model, mitigations, and audit findings for the **CoLive** real-time collaboration system.

---

## 1. Assets & Trust Boundaries

| Asset | Sensitivity | Location | Protection Mechanism |
|---|---|---|---|
| **Host Disk Files** | High | Host machine only | Path sandboxing, `realpath` boundary checks, exclude patterns, size limits |
| **Workspace Credentials (`.env`, `.git/`, keys)** | Critical | Host machine | Excluded by default (`.env*`, `.git/**`, `**/*.pem`, etc.); forbidden on read RPC |
| **Real-time Code & Edits** | High | Ephemeral in-flight & client memory | End-to-End Encryption (AES-256-GCM) with WebCrypto |
| **Session Invite Secret** | Critical | Memory & URL fragments only | 32-byte base64url entropy; SHA-256 hashed at rest; timing-safe compare |
| **Guest Editor Environment** | High | Guest machine | Untrusted workspace; `.vscode/**` excluded; no task execution |

---

## 2. Threat Actors & Mitigations

### Actor A: Malicious Guest
* **Threat 1: Directory Traversal (`../../etc/passwd`)**:
  - *Mitigation*: Paths normalized using `normalizeWorkspacePath`, strictly rejecting `..`, absolute paths, Windows drive letters, null bytes, and percent-encoded sequences.
  - *Mitigation*: `fs.realpath` resolves symlinks and guarantees target stays within the workspace root directory.
* **Threat 2: Unauthorized Modifications in Read-Only Mode**:
  - *Mitigation*: Permission enforced on **BOTH** relay server and host file service. Relay drops write RPCs and Yjs updates from read-only guests; host verifies permissions before persisting or mutating state.
* **Threat 3: Update Bombs / DoS**:
  - *Mitigation*: Rate limits enforced per connection (50 JSON msgs/s, 2 MB/s binary). Doc updates and message payloads capped at strict byte limits (`MAX_FILE_BYTES = 5 MB`, `MAX_MESSAGE_BYTES = 1 MB`).

### Actor B: Malicious Relay Server
* **Threat: Server inspects file contents, chat, or comments**:
  - *Mitigation*: **End-to-End Encryption (E2EE)**.
  - Invite secret derives `authKey` (for session authentication) and `encKey` (AES-256-GCM) using HKDF.
  - Relay routes messages solely by envelope headers (`type`, `docId`, `id`) and never has access to the cryptographic keys.

### Actor C: Malicious Host
* **Threat: Host compromises guest editor via `.vscode/tasks.json` or settings**:
  - *Mitigation*: `.vscode/**` is in the default exclude list and completely hidden from guests. Guest workspaces are virtual (`colive:`) and never marked as trusted workspaces by VS Code.

### Actor D: Network Attacker (MITM)
* **Threat: Eavesdropping or message tampering**:
  - *Mitigation*: Production requires TLS (`wss://`). Non-localhost `ws://` connections trigger a security warning. AES-GCM 128-bit authentication tag detects any packet modification.

---

## 3. End-to-End Encryption (E2EE) Specification

CoLive implements authenticated E2EE using the W3C Web Cryptography API (`crypto.subtle`):

1. **Key Derivation (HKDF-SHA256)**:
   $$\text{PRK} = \text{HKDF-Extract}(\text{salt}, \text{inviteSecret})$$
   $$\text{authKey} = \text{HKDF-Expand}(\text{PRK}, \text{"auth"}, 32)$$
   $$\text{encKey} = \text{HKDF-Expand}(\text{PRK}, \text{"enc"}, 32)$$
2. **Authenticated Encryption (AES-256-GCM)**:
   - 12-byte IV generated from a monotonic counter.
   - 16-byte authentication tag guarantees confidentiality and integrity.
   - Any tampering produces a cryptographic validation failure, terminating the malformed frame.

---

## 4. Security Audit & Regression Test Matrix

| Issue | Severity | Fixed? | Regression Test |
|---|---|---|---|
| **Path Traversal via `..` or `%2e%2e`** | Critical | Yes | `packages/protocol/tests/protocol.test.ts` (`normalizeWorkspacePath`) |
| **Symlink Escape beyond Workspace Root** | Critical | Yes | `packages/extension/tests/fileService.test.ts` (`symlink traversal`) |
| **Excluded Files Leakage (`.env`, `.git`)** | High | Yes | `packages/extension/tests/fileService.test.ts` (`excludePatterns`) |
| **Read-Only Guest Write Bypass** | High | Yes | `packages/server/tests/server.test.ts` (`readOnly guest cannot write`) |
| **Invite Secret Timing Attack** | High | Yes | `packages/server/tests/server.test.ts` (`crypto.timingSafeEqual`) |
| **XSS via Chat / Webview HTML Injection** | High | Yes | `packages/extension/tests/commentsAndChat.test.ts` (`escapes HTML tags`) |
| **Malicious Comment Command URIs (`command:`)**| Medium | Yes | `packages/extension/tests/commentsAndChat.test.ts` (`sanitizes markdown`) |
| **Chat Flood / Connection DoS** | Medium | Yes | `packages/extension/tests/commentsAndChat.test.ts` (`rate limits chat`) |
| **E2EE Key Derivation & Tamper Detection** | High | Yes | `packages/protocol/tests/e2ee.test.ts` (`E2EE AES-GCM and tamper test`) |
