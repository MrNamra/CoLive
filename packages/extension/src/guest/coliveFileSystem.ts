import * as vscode from 'vscode';
import {
  FsListReq,
  FsListRes,
  FsReadReq,
  FsReadRes,
  FsStatReq,
  FsStatRes,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { Strings } from '../strings.js';

interface CachedStat {
  stat: vscode.FileStat;
  cachedAt: number;
}

interface CachedDir {
  entries: [string, vscode.FileType][];
  cachedAt: number;
}

interface CachedFile {
  content: Uint8Array;
  mtime: number;
  size: number;
}

export class CoLiveFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  public static readonly SCHEME = 'colive';

  private connection: ConnectionManager;
  private isReadOnly = false;
  private isSyncedFile?: (relPath: string) => boolean;
  private statCache: Map<string, CachedStat> = new Map();
  private dirCache: Map<string, CachedDir> = new Map();
  private fileCache: Map<string, CachedFile> = new Map();
  private totalCacheBytes = 0;
  private maxCacheBytes = 50 * 1024 * 1024; // 50 MB cap

  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

  constructor(connection: ConnectionManager, isReadOnly = false, isSyncedFile?: (relPath: string) => boolean) {
    this.connection = connection;
    this.isReadOnly = isReadOnly;
    this.isSyncedFile = isSyncedFile;
    this.setupWatchEventListener();
  }

  public setSyncedFileCheck(check: (relPath: string) => boolean): void {
    this.isSyncedFile = check;
  }

  public setReadOnly(isReadOnly: boolean): void {
    if (this.isReadOnly !== isReadOnly) {
      this.isReadOnly = isReadOnly;
      // Invalidate stat cache to reflect updated readonly flag
      this.statCache.clear();
      // Notify VS Code that files changed permission
      this._onDidChangeFile.fire([]);
    }
  }

  private setupWatchEventListener(): void {
    this.connection.on('message', (msg) => {
      if (msg.type === 'fs.watchEvent') {
        const events: vscode.FileChangeEvent[] = [];
        for (const change of msg.changes) {
          // Invalidate caches
          this.statCache.delete(change.path);
          this.dirCache.delete(change.path);
          this.fileCache.delete(change.path);

          const uri = vscode.Uri.from({
            scheme: CoLiveFileSystemProvider.SCHEME,
            path: `/${change.path}`,
          });

          const type =
            change.type === 'created'
              ? vscode.FileChangeType.Created
              : change.type === 'changed'
                ? vscode.FileChangeType.Changed
                : vscode.FileChangeType.Deleted;

          events.push({ type, uri });
        }
        if (events.length > 0) {
          this._onDidChangeFile.fire(events);
        }
      }
    });
  }

  private extractRelativePath(uri: vscode.Uri): string {
    // URI shape: colive:/<workspaceName>/<relPath> or colive:/<relPath>
    let p = uri.path.replace(/^\/+/, '');
    const firstSlash = p.indexOf('/');
    if (firstSlash >= 0) {
      p = p.slice(firstSlash + 1);
    } else {
      p = ''; // Workspace root directory
    }
    return p;
  }

  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const relPath = this.extractRelativePath(uri);

    // Root directory of virtual workspace
    if (!relPath) {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 0,
        permissions: this.isReadOnly ? vscode.FilePermission.Readonly : undefined,
      };
    }

    const cached = this.statCache.get(relPath);
    if (cached && Date.now() - cached.cachedAt < 2000) {
      return cached.stat;
    }

    try {
      const req: FsStatReq = {
        v: PROTOCOL_VERSION,
        type: 'fs.stat.req',
        id: `stat_${Math.random().toString(36).slice(2, 9)}`,
        path: relPath,
      };

      const res = await this.connection.request<FsStatRes>(req);
      const fileType =
        res.fileType === 'dir'
          ? vscode.FileType.Directory
          : res.fileType === 'symlink'
            ? vscode.FileType.SymbolicLink
            : vscode.FileType.File;

      const fileStat: vscode.FileStat = {
        type: fileType,
        ctime: res.ctime,
        mtime: res.mtime,
        size: res.size,
        permissions: this.isReadOnly ? vscode.FilePermission.Readonly : undefined,
      };

      this.statCache.set(relPath, { stat: fileStat, cachedAt: Date.now() });
      return fileStat;
    } catch (err: unknown) {
      throw this.mapError(err, uri);
    }
  }

  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const relPath = this.extractRelativePath(uri);

    const cached = this.dirCache.get(relPath);
    if (cached && Date.now() - cached.cachedAt < 2000) {
      return cached.entries;
    }

    try {
      const req: FsListReq = {
        v: PROTOCOL_VERSION,
        type: 'fs.list.req',
        id: `list_${Math.random().toString(36).slice(2, 9)}`,
        path: relPath,
      };

      const res = await this.connection.request<FsListRes>(req);
      const entries: [string, vscode.FileType][] = res.entries.map((e) => [
        e.name,
        e.type === 'dir'
          ? vscode.FileType.Directory
          : e.type === 'symlink'
            ? vscode.FileType.SymbolicLink
            : vscode.FileType.File,
      ]);

      this.dirCache.set(relPath, { entries, cachedAt: Date.now() });
      return entries;
    } catch (err: unknown) {
      throw this.mapError(err, uri);
    }
  }

  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const relPath = this.extractRelativePath(uri);

    const cached = this.fileCache.get(relPath);
    if (cached) {
      return cached.content;
    }

    try {
      const req: FsReadReq = {
        v: PROTOCOL_VERSION,
        type: 'fs.read.req',
        id: `read_${Math.random().toString(36).slice(2, 9)}`,
        path: relPath,
      };

      const res = await this.connection.request<FsReadRes>(req);

      let content: Uint8Array;
      if (res.isBinary) {
        content = new TextEncoder().encode(Strings.binaryFilePlaceholder);
      } else {
        content = new Uint8Array(Buffer.from(res.contentBase64, 'base64'));
      }

      this.addToCache(relPath, content, res.mtime);
      return content;
    } catch (err: unknown) {
      throw this.mapError(err, uri);
    }
  }

  private addToCache(relPath: string, content: Uint8Array, mtime: number): void {
    const size = content.byteLength;
    if (size > this.maxCacheBytes) return; // Don't cache oversized single files

    while (this.totalCacheBytes + size > this.maxCacheBytes && this.fileCache.size > 0) {
      const firstKey = this.fileCache.keys().next().value;
      if (!firstKey) break;
      const old = this.fileCache.get(firstKey);
      if (old) this.totalCacheBytes -= old.size;
      this.fileCache.delete(firstKey);
    }

    this.fileCache.set(relPath, { content, mtime, size });
    this.totalCacheBytes += size;
  }

  public async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    if (this.isReadOnly) {
      throw vscode.FileSystemError.NoPermissions('Cannot write to file in read-only mode');
    }

    const relPath = this.extractRelativePath(uri);
    if (this.isSyncedFile && this.isSyncedFile(relPath)) {
      // Actively synced collaborative document; saved by host automatically
      vscode.window.setStatusBarMessage(Strings.savedByHost, 3000);
      return;
    }

    try {
      const contentBase64 = Buffer.from(content).toString('base64');
      await this.connection.request({
        v: PROTOCOL_VERSION,
        type: 'fs.write.req',
        id: `write_${Math.random().toString(36).slice(2, 9)}`,
        path: relPath,
        contentBase64,
      });

      this.statCache.delete(relPath);
      this.fileCache.set(relPath, { content, mtime: Date.now(), size: content.byteLength });
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (err: unknown) {
      throw this.mapError(err, uri);
    }
  }

  public async createDirectory(uri: vscode.Uri): Promise<void> {
    if (this.isReadOnly) {
      throw vscode.FileSystemError.NoPermissions('Cannot create directory in read-only mode');
    }
    const relPath = this.extractRelativePath(uri);

    try {
      await this.connection.request({
        v: PROTOCOL_VERSION,
        type: 'fs.create.req',
        id: `create_dir_${Math.random().toString(36).slice(2, 9)}`,
        path: relPath,
        itemType: 'dir',
      });
      this.statCache.delete(relPath);
      this.dirCache.clear();
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
    } catch (err: unknown) {
      throw this.mapError(err, uri);
    }
  }

  public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    if (this.isReadOnly) {
      throw vscode.FileSystemError.NoPermissions('Cannot delete in read-only mode');
    }
    const relPath = this.extractRelativePath(uri);

    try {
      await this.connection.request({
        v: PROTOCOL_VERSION,
        type: 'fs.delete.req',
        id: `del_${Math.random().toString(36).slice(2, 9)}`,
        path: relPath,
        recursive: options.recursive,
      });
      this.statCache.delete(relPath);
      this.dirCache.clear();
      this.fileCache.delete(relPath);
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    } catch (err: unknown) {
      throw this.mapError(err, uri);
    }
  }

  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (this.isReadOnly) {
      throw vscode.FileSystemError.NoPermissions('Cannot rename in read-only mode');
    }
    const oldRel = this.extractRelativePath(oldUri);
    const newRel = this.extractRelativePath(newUri);

    try {
      await this.connection.request({
        v: PROTOCOL_VERSION,
        type: 'fs.rename.req',
        id: `ren_${Math.random().toString(36).slice(2, 9)}`,
        oldPath: oldRel,
        newPath: newRel,
        overwrite: options.overwrite,
      });
      this.statCache.clear();
      this.dirCache.clear();
      this.fileCache.delete(oldRel);
      this._onDidChangeFile.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    } catch (err: unknown) {
      throw this.mapError(err, oldUri);
    }
  }

  public watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: readonly string[] }): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  private mapError(err: unknown, uri: vscode.Uri): vscode.FileSystemError {
    const msg = err instanceof Error ? err.message : String(err || '');
    if (msg.includes('NOT_FOUND')) {
      return vscode.FileSystemError.FileNotFound(uri);
    }
    if (msg.includes('FORBIDDEN') || msg.includes('READ_ONLY')) {
      return vscode.FileSystemError.NoPermissions(msg);
    }
    return vscode.FileSystemError.Unavailable(msg);
  }

  public dispose(): void {
    this.statCache.clear();
    this.dirCache.clear();
    this.fileCache.clear();
    this._onDidChangeFile.dispose();
  }
}
