# Real-Time Synchronization Architecture (Yjs)

This document describes the synchronization mechanics, CRDT binding, persistence model, and edge-case handling for the CoLive extension.

---

## 1. Document Identity (`docId`)

In a multi-user editing session, both the Host (accessing real files via `file://` URIs) and Guests (accessing virtual files via `colive:/` URIs) must address the same underlying file with a deterministic, collision-resistant identifier.

- **Normalization**: Paths are normalized to POSIX relative paths using `normalizeWorkspacePath` (e.g. `src/utils/helpers.ts`). Backslashes, redundant segments (`.`), trailing slashes, and traversal sequences are removed or rejected.
- **Hash Algorithm**: `docId = hashDocId(normalizedPath)`, which computes a SHA-256 hash formatted as a 16-character hex string (64 bits of entropy).
- **Doc Scope**: Exactly one `Y.Doc` exists per active file across the session. The `Y.Doc` contains a single root `Y.Text` named `"content"`.

---

## 2. Persistence Authority Model

The **Host** is the sole source of truth and authority for disk persistence:

1. **Guest Save Interception**: When a guest presses `Ctrl+S` / `Cmd+S`, VS Code invokes `FileSystemProvider.writeFile`. The provider verifies that the written content matches the current `Y.Text` state and immediately succeeds without modifying disk or leaving the editor in a dirty state.
2. **Host Atomic Persistence**:
   - The host maintains a debounced disk saver (default: 500 ms debounce).
   - Changes are written to a temporary file (`.colive-<hash>.tmp`) in the host file's directory and atomically renamed to the target filename.
   - Preserves existing file line endings (CRLF vs LF) and UTF-8 Byte Order Marks (BOM).
   - If the host user currently has the file open in an active editor, the host calls `vscode.TextDocument.save()` to prevent desynchronization between VS Code's internal dirty buffer and disk.
3. **Echo Prevention on Host Watcher**:
   - The host maintains `lastWrittenHash` per file path.
   - When the host's file watcher fires an `onDidChange` event, it compares the file content hash with `lastWrittenHash`. If they match, the event is recognized as our own write and discarded.
4. **External Disk Modification**:
   - If an external process (e.g., `git checkout`, external linter, build tool) modifies the file on disk while open in a session, the host reads the updated file and merges the delta into `Y.Text` using `fast-diff` inside a transaction tagged with origin `"disk"`.
   - This ensures concurrent remote edits and external disk changes converge cleanly without data loss.

---

## 3. Transaction Origins & Echo Prevention

Every mutation to a `Y.Doc` is scoped inside a `doc.transact((tr) => { ... }, origin)` call. We strictly distinguish three origins:

| Origin | Trigger | Action Taken |
|---|---|---|
| `"local-editor"` | VS Code `onDidChangeTextDocument` | Transcribed into `ytext.delete()` and `ytext.insert()`. Transmitted to relay as binary update frame (0x01). |
| `"remote"` | Binary update frame (0x01) received from relay | Decoded with `Y.applyUpdate(doc, update, "remote")`. In `ytext.observe`, remote changes generate a `vscode.WorkspaceEdit` applied to the local editor. |
| `"disk"` | Host detected external on-disk change via watcher | Merged into `Y.Text` via `fast-diff`. Transmitted to relay as standard Yjs update. |

### Echo Prevention (`applyingRemote` flag)
When remote edits or disk changes are applied to a `vscode.TextDocument` via `vscode.workspace.applyEdit`:
1. VS Code immediately triggers its local `onDidChangeTextDocument` listener.
2. If unhandled, this would re-encode the remote edit as a local edit and broadcast it back to the network, resulting in an infinite loop or duplicate operations.
3. **Guard**: Each `DocumentBinding` maintains a boolean flag `applyingRemote`. Before applying a `WorkspaceEdit`, `applyingRemote` is set to `true`. The `onDidChangeTextDocument` handler checks this flag; if `true`, it ignores the change and resets the flag.

---

## 4. Character Offsets & Unicode Surrogate Pairs

VS Code's `TextDocument` positions and offsets operate on **UTF-16 code units** (matching JavaScript string `.length` and index-based slicing).

- `TextDocument.offsetAt(position)` returns the character offset in UTF-16 code units.
- `Y.Text.delete(index, length)` and `Y.Text.insert(index, text)` operate on UTF-16 code unit indices.
- **Surrogate Pairs & Emoji**: A surrogate pair (e.g. `🎉` `\uD83C\uDF89`) has `length === 2` in both VS Code and JavaScript `string.length`, and occupies 2 positions in `Y.Text`.
- Because both systems share the UTF-16 code unit abstraction, direct mapping of `rangeOffset` and `rangeLength` to Yjs indices is 1:1, avoiding complex and slow codepoint transcoding on every keystroke.

---

## 5. Line Ending Normalization (LF vs CRLF)

- **Inside Y.Text**: Document text is strictly normalized to LF (`\n`). CRLF (`\r\n`) sequences from external files or user paste are normalized to `\n` before entering `Y.Text`.
- **Editor Boundary**: When binding to a `vscode.TextDocument` that uses `vscode.EndOfLine.CRLF`, translations between editor offsets and Y.Text offsets account for line-break representations, or the editor is configured to use LF during active collaboration sessions to ensure unambiguous remote cursor positioning.
- **Disk Boundary**: The host persistence layer records the original file's EOL convention and restores CRLF on save if the original file used CRLF.

---

## 6. Multi-Change Ordering & Concurrent Edits

When VS Code emits `onDidChangeTextDocument`, `event.contentChanges` may contain multiple edits (e.g., multi-cursor typing, find-and-replace, format document):
- In VS Code, all `rangeOffset` values in a single `contentChanges` array refer to offsets in the **pre-change** document state.
- If changes are applied in ascending offset order, early insertions or deletions would invalidate the subsequent offsets.
- **Rule**: `contentChanges` are sorted in **descending order of `rangeOffset`** before applying to `Y.Text` within a single `doc.transact(..., 'local-editor')`.

---

## 7. Safety Net & Desynchronization Recovery

Even with mathematically proven CRDT guarantees, unexpected extensions or editor interruptions could theoretically introduce drift.
- **Post-Remote Apply Check**: Immediately after applying a remote delta, `document.getText()` is compared with `ytext.toString()`.
- **Periodic Drift Check**: Every 5 seconds during active editing, the binding verifies `document.getText() === ytext.toString()`.
- **Automatic Recovery**: If a mismatch is detected:
  1. A warning is logged to the CoLive OutputChannel (logging character count only, never file content).
  2. A corrective `WorkspaceEdit` replaces the entire document content with `ytext.toString()`.
