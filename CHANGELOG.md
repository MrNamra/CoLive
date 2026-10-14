# Changelog

All notable changes to the "CoLive" real-time collaboration extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-14

### Added
- **Real-Time Co-editing**: Powered by Yjs CRDTs with state vector diff exchange, optimistic local edits, and echo suppression.
- **Host Atomic Persistence**: Safe file persistence with debounced atomic writes (`.tmp` + rename) and `fast-diff` 3-way merge on external disk modifications.
- **Virtual FileSystem (`colive:/`)**: Implemented complete `vscode.FileSystemProvider` for guests with directory caching, memory-efficient streaming, and error mapping.
- **Presence & Remote Cursors**: Color-coded 2px carets, alpha-blended selections, name tags with WCAG-compliant luminance contrast, and active file indicators.
- **Follow Mode**: Automatically reveal active editor viewports with instant auto-stop when the follower manually moves the caret or switches tabs.
- **Threaded Inline Comments**: VS Code `CommentController` integration anchored using Yjs `RelativePosition` to prevent comment drift across code edits; synced via host-owned `__comments__` `Y.Map`.
- **Integrated Sidebar Chat**: Modern Webview chat panel with strict CSP, nonce script loading, clickable file linkification, slash command allowlist (`/who`, `/leave`, `/clear`, `/help`), and rate limiting.
- **Shared Diagnostics**: Broadcasts language server diagnostics and lint errors from Host to Guest `DiagnosticCollection`.
- **End-to-End Encryption (E2EE)**: WebCrypto AES-256-GCM authenticated encryption with HKDF-SHA256 key derivation from session secrets.
- **Security Hardening**: Strict path traversal and symlink-escape prevention with `fs.realpathSync`, sensitive file glob filtering (`.env*`, `**/.git/**`, `**/id_rsa*`), and token bucket DoS mitigations.
- **Multi-Editor Support**: Tested for full compatibility with VS Code, Cursor, and VSCodium.
- **Interactive Walkthroughs**: Built-in 4-step onboarding walkthroughs in package manifest.
- **Headless E2E Test Suite**: Multi-client 5,000-operation concurrency and security fuzz test suite.
