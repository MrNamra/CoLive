import * as vscode from 'vscode';
import * as Y from 'yjs';
import {
  CommentData,
  CommentOp,
  CommentSyncReq,
  CommentSyncRes,
  CommentThreadData,
  normalizeWorkspacePath,
  Permission,
  PROTOCOL_VERSION,
  Role,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { Logger } from '../logger.js';
import { SyncManager } from '../sync/SyncManager.js';
import {
  generateInitialsAvatarSvg,
  parseMentions,
  sanitizeCommentMarkdown,
  validateCommentOp,
} from './commentValidator.js';

export interface CommentsManagerOptions {
  connection: ConnectionManager;
  role: Role;
  userId: string;
  userName: string;
  userColor: string;
  permission: Permission;
  syncManager?: SyncManager | null;
  workspaceRoot?: string;
  folderName?: string;
  allowReadOnlyComments?: boolean;
}

export class CommentsManager implements vscode.Disposable {
  private connection: ConnectionManager;
  private role: Role;
  private userId: string;
  private userName: string;
  private userColor: string;
  private permission: Permission;
  private syncManager?: SyncManager | null;
  private workspaceRoot?: string;
  private folderName: string;
  private allowReadOnlyComments: boolean;

  private commentController: vscode.CommentController;
  private commentsDoc: Y.Doc;
  private commentsMap: Y.Map<CommentThreadData>;
  private activeThreads: Map<string, vscode.CommentThread> = new Map();
  private disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  private _onDidChangeComments = new vscode.EventEmitter<CommentThreadData[]>();
  public readonly onDidChangeComments = this._onDidChangeComments.event;

  constructor(options: CommentsManagerOptions) {
    this.connection = options.connection;
    this.role = options.role;
    this.userId = options.userId;
    this.userName = options.userName;
    this.userColor = options.userColor;
    this.permission = options.permission;
    this.syncManager = options.syncManager;
    this.workspaceRoot = options.workspaceRoot;
    this.folderName = options.folderName || 'Shared';
    this.allowReadOnlyComments = options.allowReadOnlyComments ?? true;

    this.commentController = vscode.comments.createCommentController('colive', 'CoLive Comments');
    this.disposables.push(this.commentController);

    // Provide commenting ranges on all shared files
    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        const relPath = this.normalizeDocumentPath(document);
        if (!relPath) return undefined;
        return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
      },
    };

    // Get or create Y.Doc for comments
    if (this.syncManager) {
      this.commentsDoc = this.syncManager.getDoc('__comments__') || new Y.Doc();
    } else {
      this.commentsDoc = new Y.Doc();
    }

    this.commentsMap = this.commentsDoc.getMap<CommentThreadData>('comments');

    // Observe changes to shared comments map
    this.commentsMap.observeDeep(() => {
      this.syncCommentThreads();
      this._onDidChangeComments.fire(this.getAllThreads());
    });

    // Listen for incoming comment messages
    this.disposables.push(
      this.connection.onMessage((msg) => {
        if (msg.type === 'comment.op') {
          this.handleCommentOpMessage(msg as CommentOp);
        } else if (msg.type === 'comment.sync.req') {
          this.handleCommentSyncReq(msg as CommentSyncReq);
        }
      }),
    );

    // Watch active and visible editor changes to render comments
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.syncCommentThreads();
      }),
    );
    if (typeof vscode.window.onDidChangeVisibleTextEditors === 'function') {
      this.disposables.push(
        vscode.window.onDidChangeVisibleTextEditors(() => {
          this.syncCommentThreads();
        }),
      );
    }

    // Request comments sync on startup and on reconnect for guest
    if (this.role === 'guest') {
      this.requestCommentsSync();
      this.disposables.push(
        this.connection.on('reconnected', () => {
          this.requestCommentsSync();
        }),
      );
    }
  }

  public setPermission(permission: Permission): void {
    this.permission = permission;
  }

  public getUserId(): string {
    return this.userId;
  }

  public getUserName(): string {
    return this.userName;
  }

  public getUserColor(): string {
    return this.userColor;
  }

  public registerActiveThread(id: string, thread: vscode.CommentThread): void {
    (thread as any).threadId = id;
    this.activeThreads.set(id, thread);
  }

  public unregisterActiveThread(id: string): void {
    this.activeThreads.delete(id);
  }

  public getActiveThread(id: string): vscode.CommentThread | undefined {
    return this.activeThreads.get(id);
  }

  public expandThread(threadId: string): void {
    const thread = this.activeThreads.get(threadId);
    if (thread) {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  public getAllThreads(): CommentThreadData[] {
    const list: CommentThreadData[] = [];
    for (const thread of this.commentsMap.values()) {
      list.push(thread);
    }
    return list;
  }

  public getUnresolvedCount(): number {
    let count = 0;
    for (const thread of this.commentsMap.values()) {
      if (!thread.resolved) count++;
    }
    return count;
  }

  public getThreadIdByVsThread(vsThread: vscode.CommentThread): string | undefined {
    if ((vsThread as any)?.threadId && this.commentsMap.has((vsThread as any).threadId)) {
      return (vsThread as any).threadId;
    }
    for (const [id, t] of this.activeThreads.entries()) {
      if (t === vsThread) return id;
    }
    if (vsThread && vsThread.uri && vsThread.range) {
      for (const [id, t] of this.activeThreads.entries()) {
        if (
          t.uri?.toString() === vsThread.uri.toString() &&
          t.range &&
          Math.abs(t.range.start.line - vsThread.range.start.line) <= 1
        ) {
          return id;
        }
      }
      const normPath = this.normalizeDocumentPath({ uri: vsThread.uri } as any);
      if (normPath) {
        for (const threadData of this.commentsMap.values()) {
          if (
            threadData.path === normPath &&
            Math.abs(threadData.range.startLine - vsThread.range.start.line) <= 1
          ) {
            return threadData.id;
          }
        }
      }
    }
    return undefined;
  }

  public getNormalizedPath(doc: vscode.TextDocument): string | undefined {
    return this.normalizeDocumentPath(doc);
  }

  /**
   * Request full comments synchronization from host.
   */
  public async requestCommentsSync(): Promise<void> {
    try {
      const res = await this.connection.request<CommentSyncRes>({
        v: PROTOCOL_VERSION,
        type: 'comment.sync.req',
        id: `csync_${Math.random().toString(36).slice(2, 9)}`,
      });
      if (res && Array.isArray(res.threads)) {
        this.commentsDoc.transact(() => {
          for (const t of res.threads) {
            this.commentsMap.set(t.id, t);
          }
        });
        this.syncCommentThreads();
        this._onDidChangeComments.fire(this.getAllThreads());
      }
    } catch (err) {
      Logger.warn('Failed to sync comments with host', { err });
    }
  }

  private handleCommentSyncReq(msg: CommentSyncReq): void {
    if (this.role !== 'host') return;
    const threads = this.getAllThreads();
    this.connection.sendJson({
      v: PROTOCOL_VERSION,
      type: 'comment.sync.res',
      id: msg.id,
      threads,
    });
  }

  /**
   * Dispatches a comment operation.
   * Host validates, applies locally, and broadcasts to guests.
   * Guest applies locally (optimistic) and sends to host/session.
   */
  public async dispatchOp(op: CommentOp): Promise<void> {
    const enrichedOp: CommentOp = {
      ...op,
      authorId: op.authorId || this.userId,
      authorName: op.authorName || this.userName,
    };

    if (this.role === 'host') {
      const existing = this.commentsMap.get(enrichedOp.threadId);
      const validation = validateCommentOp(
        enrichedOp,
        {
          id: this.userId,
          role: 'host',
          displayName: this.userName,
          permission: this.permission,
        },
        this.allowReadOnlyComments,
        existing,
      );

      if (!validation.valid) {
        throw new Error(validation.error || 'Invalid comment operation');
      }

      this.applyOpToYMap(enrichedOp, this.userId, this.userName);

      // Broadcast validated op to all session participants
      this.connection.sendJson(enrichedOp);
    } else {
      // Guest: apply locally immediately for responsive UI, then broadcast to host
      this.applyOpToYMap(enrichedOp, this.userId, this.userName);
      this.connection.sendJson(enrichedOp);
    }
  }

  private handleCommentOpMessage(op: CommentOp): void {
    // If originated by this client, already applied locally
    if (op.authorId && op.authorId === this.userId) return;

    if (this.role === 'host') {
      const existing = this.commentsMap.get(op.threadId);
      const sender = {
        id: op.authorId || 'guest',
        role: 'guest' as const,
        displayName: op.authorName || 'Guest',
        permission: this.permission,
      };

      const validation = validateCommentOp(op, sender, this.allowReadOnlyComments, existing);
      if (!validation.valid) {
        Logger.warn('Rejected invalid comment.op from guest', { error: validation.error, op });
        return;
      }

      this.applyOpToYMap(op, sender.id, sender.displayName);

      // Broadcast validated op to other session participants
      this.connection.sendJson({
        ...op,
        authorId: sender.id,
        authorName: sender.displayName,
      });
    } else {
      // Guest receives comment.op from host or broadcast
      const authorId = op.authorId || 'host';
      const authorName = op.authorName || 'Host';
      this.applyOpToYMap(op, authorId, authorName);
    }
  }

  public applyOpToYMap(op: CommentOp, authorId: string, authorName: string): void {
    this.commentsDoc.transact(() => {
      switch (op.op) {
        case 'create': {
          if (!op.path || !op.range || !op.body) return;
          const existing = this.commentsMap.get(op.threadId);
          if (existing) {
            this.checkMentions(op.body);
            return;
          }

          const newComment: CommentData = {
            id: op.commentId || `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            authorId,
            authorName,
            body: sanitizeCommentMarkdown(op.body),
            createdAt: Date.now(),
          };

          const newThread: CommentThreadData = {
            id: op.threadId,
            path: op.path,
            range: op.range,
            anchorStartRelPos: op.anchorStartRelPos,
            anchorEndRelPos: op.anchorEndRelPos,
            authorId,
            createdAt: Date.now(),
            resolved: false,
            comments: [newComment],
          };

          this.commentsMap.set(op.threadId, newThread);
          this.checkMentions(op.body);
          break;
        }

        case 'reply': {
          const thread = this.commentsMap.get(op.threadId);
          if (!thread || !op.body) return;

          const commentId = op.commentId || `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          if (thread.comments.some((c) => c.id === commentId)) {
            return;
          }

          const reply: CommentData = {
            id: commentId,
            authorId,
            authorName,
            body: sanitizeCommentMarkdown(op.body),
            createdAt: Date.now(),
          };

          const updated = {
            ...thread,
            comments: [...thread.comments, reply],
          };
          this.commentsMap.set(op.threadId, updated);
          this.checkMentions(op.body);
          break;
        }

        case 'edit': {
          const thread = this.commentsMap.get(op.threadId);
          if (!thread || !op.commentId || !op.body) return;

          const updatedComments = thread.comments.map((c) =>
            c.id === op.commentId
              ? { ...c, body: sanitizeCommentMarkdown(op.body!), editedAt: Date.now() }
              : c,
          );

          this.commentsMap.set(op.threadId, {
            ...thread,
            comments: updatedComments,
          });
          break;
        }

        case 'delete': {
          const thread = this.commentsMap.get(op.threadId);
          if (!thread) return;

          if (!op.commentId) {
            this.commentsMap.delete(op.threadId);
            break;
          }

          const remaining = thread.comments.filter((c) => c.id !== op.commentId);
          if (remaining.length === 0) {
            this.commentsMap.delete(op.threadId);
          } else {
            this.commentsMap.set(op.threadId, {
              ...thread,
              comments: remaining,
            });
          }
          break;
        }

        case 'resolve': {
          const thread = this.commentsMap.get(op.threadId);
          if (thread) {
            this.commentsMap.set(op.threadId, { ...thread, resolved: true });
          }
          break;
        }

        case 'unresolve': {
          const thread = this.commentsMap.get(op.threadId);
          if (thread) {
            this.commentsMap.set(op.threadId, { ...thread, resolved: false });
          }
          break;
        }
      }
    });
  }

  private checkMentions(body: string): void {
    const mentions = parseMentions(body, [this.userName]);
    if (mentions.includes(this.userName)) {
      vscode.window.setStatusBarMessage(`CoLive: You were mentioned in a comment`, 5000);
    }
  }

  /**
   * Synchronizes comment threads with active and visible editors.
   */
  public syncCommentThreads(): void {
    if (this.isDisposed) return;
    const editors = vscode.window.visibleTextEditors && vscode.window.visibleTextEditors.length > 0
      ? vscode.window.visibleTextEditors
      : (vscode.window.activeTextEditor ? [vscode.window.activeTextEditor] : []);

    if (editors.length === 0) return;

    for (const editor of editors) {
      const currentPath = this.normalizeDocumentPath(editor.document);
      if (!currentPath) continue;

      const docThreads = this.getAllThreads().filter((t) => t.path === currentPath);

      for (const threadData of docThreads) {
        const existingThread = this.activeThreads.get(threadData.id);

        // Resolve anchored position using RelativePosition if available
        const resolvedRange = this.resolveAnchorRange(editor.document, threadData);

        const vsComments: vscode.Comment[] = threadData.comments.map((c) => {
          const vsC: vscode.Comment = {
            author: {
              name: c.authorName,
              iconPath: vscode.Uri.parse(generateInitialsAvatarSvg(c.authorName, '#4A90E2')),
            },
            body: new vscode.MarkdownString(c.body, false),
            mode: vscode.CommentMode.Preview,
            contextValue: c.authorId === this.userId || this.role === 'host' ? 'canDelete' : undefined,
          };
          (vsC as any).commentId = c.id;
          (vsC as any).threadId = threadData.id;
          return vsC;
        });

        if (existingThread) {
          (existingThread as any).threadId = threadData.id;
          existingThread.range = resolvedRange;
          existingThread.comments = vsComments;
          existingThread.canReply = !threadData.resolved && (this.permission !== 'readOnly' || this.allowReadOnlyComments);
          existingThread.contextValue = threadData.resolved ? 'resolved' : 'unresolved';
          // When resolved, automatically collapse.
          // When unresolved, preserve existing collapsibleState (so user's minimized state isn't reset).
          if (threadData.resolved) {
            existingThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
          }
        } else {
          const newThread = this.commentController.createCommentThread(
            editor.document.uri,
            resolvedRange,
            vsComments,
          );
          (newThread as any).threadId = threadData.id;
          newThread.canReply = !threadData.resolved && (this.permission !== 'readOnly' || this.allowReadOnlyComments);
          newThread.contextValue = threadData.resolved ? 'resolved' : 'unresolved';
          newThread.collapsibleState = threadData.resolved
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;
          this.activeThreads.set(threadData.id, newThread);
        }
      }
    }

    // Dispose only threads that no longer exist in commentsMap (i.e. deleted)
    for (const [id, thread] of this.activeThreads.entries()) {
      if (!this.commentsMap.has(id)) {
        thread.dispose();
        this.activeThreads.delete(id);
      }
    }
  }

  private resolveAnchorRange(doc: vscode.TextDocument, threadData: CommentThreadData): vscode.Range {
    if (threadData.anchorStartRelPos && threadData.anchorEndRelPos && this.syncManager) {
      const ydoc = this.syncManager.getDoc(threadData.path);
      if (ydoc) {
        try {
          const startRel = Y.decodeRelativePosition(Buffer.from(threadData.anchorStartRelPos, 'base64'));
          const endRel = Y.decodeRelativePosition(Buffer.from(threadData.anchorEndRelPos, 'base64'));

          const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc);
          const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc);

          if (startAbs && endAbs && doc.positionAt) {
            const startPos = doc.positionAt(startAbs.index);
            const endPos = doc.positionAt(endAbs.index);
            return new vscode.Range(startPos, endPos);
          }
        } catch (err) {
          Logger.warn('Failed to resolve comment RelativePosition anchor; falling back to stored range', { err });
        }
      }
    }

    // Fallback to static range
    const r = threadData.range;
    return new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar);
  }

  private normalizeDocumentPath(doc: vscode.TextDocument): string | undefined {
    if (doc.uri.scheme === 'file') {
      if (!this.workspaceRoot) return undefined;
      const fsPath = doc.uri.fsPath;
      if (!fsPath.startsWith(this.workspaceRoot)) return undefined;
      const rel = fsPath.slice(this.workspaceRoot.length).replace(/^[/\\]+/, '');
      return normalizeWorkspacePath(rel);
    } else if (doc.uri.scheme === 'colive') {
      let p = decodeURIComponent(doc.uri.path).replace(/^\/+/, '');
      const firstSlash = p.indexOf('/');
      if (firstSlash >= 0) p = p.slice(firstSlash + 1);
      return normalizeWorkspacePath(p);
    }
    return undefined;
  }

  public exportComments(): string {
    const threads = this.getAllThreads();
    return JSON.stringify(threads, null, 2);
  }

  public importComments(jsonStr: string): number {
    const parsed = JSON.parse(jsonStr) as CommentThreadData[];
    if (!Array.isArray(parsed)) return 0;

    let count = 0;
    this.commentsDoc.transact(() => {
      for (const thread of parsed) {
        if (thread.id && thread.path && thread.comments) {
          this.commentsMap.set(thread.id, thread);
          count++;
          if (this.role === 'host') {
            for (const c of thread.comments) {
              this.connection.sendJson({
                v: PROTOCOL_VERSION,
                type: 'comment.op',
                op: 'create',
                threadId: thread.id,
                commentId: c.id,
                path: thread.path,
                range: thread.range,
                body: c.body,
                authorId: c.authorId,
                authorName: c.authorName,
                resolved: thread.resolved,
              });
            }
          }
        }
      }
    });

    return count;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const thread of this.activeThreads.values()) {
      thread?.dispose();
    }
    this.activeThreads.clear();

    try {
      this.commentsDoc.transact(() => {
        for (const k of Array.from(this.commentsMap.keys())) {
          this.commentsMap.delete(k);
        }
      });
    } catch {
      // Ignore if doc is already closed
    }

    try {
      this._onDidChangeComments.fire([]);
    } catch {
      // Ignore
    }

    for (const d of this.disposables) {
      d?.dispose();
    }
    this.disposables = [];
    this._onDidChangeComments.dispose();
  }
}
