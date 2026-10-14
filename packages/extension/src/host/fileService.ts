import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import {
  CoLiveError,
  FsEntry,
  FsListReq,
  FsListRes,
  FsReadReq,
  FsReadRes,
  FsStatReq,
  FsStatRes,
  FsWatchChange,
  isExcluded,
  normalizeWorkspacePath,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';

export class HostFileService implements vscode.Disposable {
  private workspaceRoot: string;
  private realWorkspaceRoot: string;
  private excludePatterns: string[];
  private maxFileSizeBytes: number;
  private connection: ConnectionManager | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;
  private pendingChanges: FsWatchChange[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    workspaceRoot: string,
    excludePatterns: string[] = [],
    maxFileSizeMB = 5,
  ) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.realWorkspaceRoot = fs.existsSync(this.workspaceRoot)
      ? fs.realpathSync(this.workspaceRoot)
      : this.workspaceRoot;
    this.excludePatterns = excludePatterns;
    this.maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
  }

  public setConnection(connection: ConnectionManager | null): void {
    this.connection = connection;
    if (connection) {
      connection.on('message', async (msg) => {
        try {
          if (msg.type === 'fs.list.req') {
            const res = await this.handleList(msg);
            connection.send(res);
          } else if (msg.type === 'fs.stat.req') {
            const res = await this.handleStat(msg);
            connection.send(res);
          } else if (msg.type === 'fs.read.req') {
            const res = await this.handleRead(msg);
            connection.send(res);
          } else if (msg.type === 'workspace.info.req') {
            connection.send({
              v: PROTOCOL_VERSION,
              type: 'workspace.info.res',
              id: msg.id,
              name: path.basename(this.workspaceRoot),
              rootLabel: path.basename(this.workspaceRoot),
              excludePatterns: this.excludePatterns,
            });
          }
        } catch (err) {
          const coliveErr =
            err instanceof CoLiveError
              ? err
              : new CoLiveError('INTERNAL', err instanceof Error ? err.message : String(err));
          connection.send({
            v: PROTOCOL_VERSION,
            type: 'error',
            id: 'id' in msg ? msg.id : undefined,
            code: coliveErr.code,
            message: coliveErr.message,
          });
        }
      });

      this.startWatching();
    } else {
      this.stopWatching();
    }
  }

  public resolveSecurePath(rawRelPath: string): { fullPath: string; relPath: string } {
    const relPath = normalizeWorkspacePath(rawRelPath);

    if (this.excludePatterns.length > 0 && isExcluded(relPath, this.excludePatterns)) {
      throw new CoLiveError('FORBIDDEN', `Path is excluded: ${relPath}`);
    }

    const fullPath = path.resolve(this.workspaceRoot, relPath);

    // Symlink escape & sandboxing verification
    if (fs.existsSync(fullPath)) {
      const realFullPath = fs.realpathSync(fullPath);
      const isInside =
        realFullPath === this.realWorkspaceRoot ||
        realFullPath.startsWith(this.realWorkspaceRoot + path.sep);

      if (!isInside) {
        throw new CoLiveError('FORBIDDEN', `Symlink escapes workspace root: ${rawRelPath}`);
      }
    } else {
      // Check parent directory for paths that don't exist yet
      const parentDir = path.dirname(fullPath);
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        const isInside =
          realParent === this.realWorkspaceRoot ||
          realParent.startsWith(this.realWorkspaceRoot + path.sep);
        if (!isInside) {
          throw new CoLiveError('FORBIDDEN', `Path escapes workspace root: ${rawRelPath}`);
        }
      }
    }

    return { fullPath, relPath };
  }

  public async handleList(req: FsListReq): Promise<FsListRes> {
    const { fullPath, relPath } = this.resolveSecurePath(req.path);

    if (!fs.existsSync(fullPath)) {
      throw new CoLiveError('NOT_FOUND', `Directory not found: ${req.path}`);
    }

    const stat = await fs.promises.stat(fullPath);
    if (!stat.isDirectory()) {
      throw new CoLiveError('INVALID_PATH', `Path is not a directory: ${req.path}`);
    }

    const dirents = await fs.promises.readdir(fullPath, { withFileTypes: true });
    const entries: FsEntry[] = [];

    for (const dirent of dirents) {
      const childRelPath = relPath ? `${relPath}/${dirent.name}` : dirent.name;

      if (this.excludePatterns.length > 0 && isExcluded(childRelPath, this.excludePatterns)) {
        continue;
      }

      const childFullPath = path.join(fullPath, dirent.name);
      try {
        const childStat = await fs.promises.stat(childFullPath);
        entries.push({
          name: dirent.name,
          type: dirent.isDirectory() ? 'dir' : dirent.isSymbolicLink() ? 'symlink' : 'file',
          size: dirent.isDirectory() ? 0 : childStat.size,
          mtime: Math.floor(childStat.mtimeMs),
        });
      } catch {
        // Skip unreadable files
      }
    }

    return {
      v: PROTOCOL_VERSION,
      type: 'fs.list.res',
      id: req.id,
      entries,
    };
  }

  public async handleStat(req: FsStatReq): Promise<FsStatRes> {
    const { fullPath } = this.resolveSecurePath(req.path);

    if (!fs.existsSync(fullPath)) {
      throw new CoLiveError('NOT_FOUND', `File not found: ${req.path}`);
    }

    const stat = await fs.promises.stat(fullPath);
    return {
      v: PROTOCOL_VERSION,
      type: 'fs.stat.res',
      id: req.id,
      fileType: stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'symlink' : 'file',
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      ctime: Math.floor(stat.ctimeMs),
    };
  }

  public async handleRead(req: FsReadReq): Promise<FsReadRes> {
    const { fullPath } = this.resolveSecurePath(req.path);

    if (!fs.existsSync(fullPath)) {
      throw new CoLiveError('NOT_FOUND', `File not found: ${req.path}`);
    }

    const stat = await fs.promises.stat(fullPath);
    if (stat.isDirectory()) {
      throw new CoLiveError('INVALID_PATH', `Cannot read directory as file: ${req.path}`);
    }

    if (stat.size > this.maxFileSizeBytes) {
      throw new CoLiveError(
        'TOO_LARGE',
        `File size (${Math.round(stat.size / 1024)} KB) exceeds limit of ${Math.round(this.maxFileSizeBytes / (1024 * 1024))} MB`,
      );
    }

    const buffer = await fs.promises.readFile(fullPath);
    // Check first 8 KB for null byte (binary heuristic)
    const checkLen = Math.min(buffer.length, 8192);
    let isBinary = false;
    for (let i = 0; i < checkLen; i++) {
      if (buffer[i] === 0) {
        isBinary = true;
        break;
      }
    }

    return {
      v: PROTOCOL_VERSION,
      type: 'fs.read.res',
      id: req.id,
      contentBase64: buffer.toString('base64'),
      mtime: Math.floor(stat.mtimeMs),
      isBinary,
    };
  }

  private startWatching(): void {
    if (this.watcher) return;

    try {
      this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
      this.disposables.push(
        this.watcher.onDidCreate((uri) => this.queueWatchChange('created', uri)),
        this.watcher.onDidChange((uri) => this.queueWatchChange('changed', uri)),
        this.watcher.onDidDelete((uri) => this.queueWatchChange('deleted', uri)),
      );
    } catch {
      // In non-vscode test environments, file watching is handled directly
    }
  }

  public queueWatchChange(type: 'created' | 'changed' | 'deleted', uri: vscode.Uri | string): void {
    const filePath = typeof uri === 'string' ? uri : uri.fsPath;
    const rel = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return;

    if (this.excludePatterns.length > 0 && isExcluded(rel, this.excludePatterns)) {
      return;
    }

    this.pendingChanges.push({ type, path: rel });

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flushWatchChanges();
    }, 100);
  }

  private flushWatchChanges(): void {
    if (this.pendingChanges.length === 0 || !this.connection) return;

    const changes = [...this.pendingChanges];
    this.pendingChanges = [];

    this.connection.send({
      v: PROTOCOL_VERSION,
      type: 'fs.watchEvent',
      changes,
    });
  }

  private stopWatching(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  public dispose(): void {
    this.stopWatching();
  }
}
