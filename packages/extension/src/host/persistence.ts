import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import fastDiff from 'fast-diff';
import * as Y from 'yjs';
import { PROTOCOL_VERSION } from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { Logger } from '../logger.js';

export interface HostPersistenceOptions {
  workspaceRoot: string;
  connection: ConnectionManager;
  debounceMs?: number;
}

/**
 * Host disk persistence authority.
 * Debounces writes (500 ms), executes atomic saves via temp file + rename,
 * preserves CRLF / LF line endings and UTF-8 BOM, avoids echo on own writes via hash tracking,
 * merges external disk changes via fast-diff with origin 'disk', and broadcasts doc.saved.
 */
export class HostPersistence implements vscode.Disposable {
  private workspaceRoot: string;
  private connection: ConnectionManager;
  private debounceMs: number;

  private debouncedTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastWrittenHashes: Map<string, string> = new Map();
  private lastKnownDiskContent: Map<string, string> = new Map();
  private eolPreferences: Map<string, 'crlf' | 'lf'> = new Map();
  private bomPreferences: Map<string, boolean> = new Map();
  private isDisposed = false;

  constructor(options: HostPersistenceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.connection = options.connection;
    this.debounceMs = options.debounceMs ?? 500;
  }

  public trackFileProperties(relPath: string, content: string | Buffer): void {
    let str = typeof content === 'string' ? content : content.toString('utf8');
    const hasBom = str.charCodeAt(0) === 0xfeff || (Buffer.isBuffer(content) && content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf);
    const hasCrlf = str.includes('\r\n');

    this.bomPreferences.set(relPath, hasBom);
    this.eolPreferences.set(relPath, hasCrlf ? 'crlf' : 'lf');

    if (str.charCodeAt(0) === 0xfeff) {
      str = str.slice(1);
    }
    this.lastKnownDiskContent.set(relPath, str.replace(/\r\n/g, '\n'));

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    this.lastWrittenHashes.set(relPath, hash);
  }

  public isOwnWrite(relPath: string, contentHash: string): boolean {
    return this.lastWrittenHashes.get(relPath) === contentHash;
  }

  public scheduleSave(relPath: string, docId: string, ydoc: Y.Doc): void {
    if (this.isDisposed) return;

    const existing = this.debouncedTimers.get(relPath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debouncedTimers.delete(relPath);
      this.saveImmediately(relPath, docId, ydoc).catch((err) => {
        Logger.error(`Failed to persist document ${relPath} to disk`, err);
      });
    }, this.debounceMs);

    this.debouncedTimers.set(relPath, timer);
  }

  public async saveImmediately(relPath: string, docId: string, ydoc: Y.Doc): Promise<void> {
    const fullPath = path.join(this.workspaceRoot, relPath);
    let text = ydoc.getText('content').toString();

    // Check EOL preference
    const eol = this.eolPreferences.get(relPath) ?? 'lf';
    if (eol === 'crlf') {
      text = text.replace(/\n/g, '\r\n');
    }

    // Check BOM preference
    const hasBom = this.bomPreferences.get(relPath) ?? false;
    let fileBuffer: Buffer;
    if (hasBom) {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      fileBuffer = Buffer.concat([bom, Buffer.from(text, 'utf8')]);
    } else {
      fileBuffer = Buffer.from(text, 'utf8');
    }

    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    this.lastWrittenHashes.set(relPath, hash);

    // If host has file open in active VS Code editor, call document.save()
    let savedViaEditor = false;
    try {
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.scheme === 'file' && d.uri.fsPath === fullPath,
      );
      if (openDoc && openDoc.isDirty) {
        await openDoc.save();
        savedViaEditor = true;
      }
    } catch {
      // Fall through to atomic disk write
    }

    if (!savedViaEditor) {
      // Atomic write via temp file + rename
      const dir = path.dirname(fullPath);
      const tempFile = path.join(dir, `.colive-${crypto.randomBytes(6).toString('hex')}.tmp`);
      try {
        await fs.promises.writeFile(tempFile, fileBuffer);
        await fs.promises.rename(tempFile, fullPath);
      } catch (err: unknown) {
        try {
          if (fs.existsSync(tempFile)) {
            await fs.promises.unlink(tempFile);
          }
        } catch {
          // Ignore temp cleanup errors
        }
        throw err;
      }
    }

    // Broadcast doc.saved to participants
    this.connection.sendJson({
      v: PROTOCOL_VERSION,
      type: 'doc.saved',
      docId,
      path: relPath,
    });
  }

  /**
   * Merge external changes on disk (git checkout, external linter/formatter)
   * into Y.Text using fast-diff with origin 'disk'.
   */
  public async mergeExternalDiskChange(relPath: string, ydoc: Y.Doc): Promise<void> {
    const fullPath = path.join(this.workspaceRoot, relPath);
    if (!fs.existsSync(fullPath)) return;

    const rawBuffer = await fs.promises.readFile(fullPath);
    const hash = crypto.createHash('sha256').update(rawBuffer).digest('hex');

    // Echo prevention: ignore our own writes
    if (this.lastWrittenHashes.get(relPath) === hash) {
      return;
    }

    const oldDisk = this.lastKnownDiskContent.get(relPath);

    this.trackFileProperties(relPath, rawBuffer);

    let diskStr = rawBuffer.toString('utf8');
    // Strip BOM and normalize CRLF to LF for Y.Text
    if (diskStr.charCodeAt(0) === 0xfeff) {
      diskStr = diskStr.slice(1);
    }
    diskStr = diskStr.replace(/\r\n/g, '\n');

    const ytext = ydoc.getText('content');
    const currentYText = ytext.toString();
    if (currentYText === diskStr) return;

    if (!oldDisk) {
      const diffs = fastDiff(currentYText, diskStr);
      ydoc.transact(() => {
        let index = 0;
        for (const [op, text] of diffs) {
          if (op === fastDiff.EQUAL) {
            index += text.length;
          } else if (op === fastDiff.DELETE) {
            ytext.delete(index, text.length);
          } else if (op === fastDiff.INSERT) {
            ytext.insert(index, text);
            index += text.length;
          }
        }
      }, 'disk');
    } else {
      const diffs = fastDiff(oldDisk, diskStr);
      ydoc.transact(() => {
        let searchFrom = 0;
        for (const [op, text] of diffs) {
          if (op === fastDiff.EQUAL) {
            const idx = ytext.toString().indexOf(text, searchFrom);
            if (idx !== -1) {
              searchFrom = idx + text.length;
            }
          } else if (op === fastDiff.DELETE) {
            const idx = ytext.toString().indexOf(text, searchFrom);
            if (idx !== -1) {
              ytext.delete(idx, text.length);
              searchFrom = idx;
            }
          } else if (op === fastDiff.INSERT) {
            ytext.insert(searchFrom, text);
            searchFrom += text.length;
          }
        }
      }, 'disk');
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const timer of this.debouncedTimers.values()) {
      clearTimeout(timer);
    }
    this.debouncedTimers.clear();
    this.lastWrittenHashes.clear();
  }
}
