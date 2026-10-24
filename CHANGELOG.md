# Changelog

All notable changes to the "CoLive" real-time collaboration extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-24

### Added
- **Configurable Gitignored Files Loading**: Added `colive.loadGitIgnoredFiles` configuration (`prompt`, `always`, `never`) and `colive.toggleGitIgnoredFiles` command.
- **Gitignore Rule Support**: Full `.gitignore` rule parsing supporting comments, directory rules (`dir/`), sequential evaluation, and negation rules (`!pattern`). The `.gitignore` configuration file itself is always tracked and visible.
- **Guest Workspace Prompt**: Prompts guest users upon joining whether to load gitignored files.
- **Ordered File Fetching**: When loading gitignored files, all non-gitignored files are fetched and displayed first, and gitignored files are fetched last.

### Fixed
- **Terminal Staircase & Output Formatting**: Normalized terminal newlines (`\r\n`) to eliminate staircase rendering on guest and host shared terminals.
- **Terminal Mirroring & Synchronization**: Enhanced terminal output streaming and mirroring stability between host and guests.

## [1.0.0] - 2026-10-23

### Added
- **Production-Ready 1.0.0 Release**: Full suite of pair programming and real-time collaboration features.
- **Language Feature Proxying (LSP Mirroring)**: Remote hover, completion, definition, and reference providers over relay RPC.
- **Shared Interactive Debugging**: Debug adapter tracker, DAP call stack & variables tree views, guest stepping commands, and bidirectional breakpoint synchronization.
- **Binary Asset & Image Previews**: Chunked file streaming for assets up to 10MB and custom image preview editor with zoom controls.
- **Comment Lifecycle & Disconnect Cleanup**: Full lifecycle handling for inline & panel comments, draft discard, and complete session cleanup upon disconnect.
- **Clean Zero-Config Cloudflare Tunnels**: In-memory tunnel lifecycle management without leaving temporary workspace files.
- **End-to-End Encryption (E2EE)**: WebCrypto AES-256-GCM session protection with out-of-band secret keys.

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
