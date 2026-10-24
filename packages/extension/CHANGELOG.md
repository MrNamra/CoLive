# Changelog

All notable changes to the "colive" extension will be documented in this file.

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

## [0.2.0] - 2026-10-23
### Added
- **Language Feature Proxying (LSP Mirroring)**: Remote hover, completion, definition, and reference providers over relay RPC.
- **Shared Interactive Debugging**: Debug adapter tracker, DAP call stack & variables tree views, guest stepping commands, and bidirectional breakpoint synchronization.
- **Binary Asset & Image Previews**: Chunked file streaming for assets up to 10MB and custom image preview editor with zoom controls.

## [0.1.0] - 2026-10-14
### Added
- Initial release of CoLive.
- Host and guest session management.
- Yjs-powered real-time collaborative editing.
- Presence and remote cursors.
- Inline comment threads.
- Follow mode and session chat.
