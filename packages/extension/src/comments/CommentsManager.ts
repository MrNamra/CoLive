import * as vscode from 'vscode';
import * as Y from 'yjs';
import {
  CommentData,
  CommentOp,
  CommentThreadData,
  normalizeWorkspacePath,
  Permission,
  PROTOCOL_VERSION,
  Range,
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

    // Listen for incoming comment.op messages
    this.disposables.push(
      this.connection.on('message', (msg) => {
        if (msg.type === 'comment.op') {
          this.handleCommentOpMessage(msg);
        }
      }) as unknown as vscode.Disposable,
    );

    // Watch active/visible editor changes to render comments
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.syncCommentThreads();
      }),
    );
  }

  public setPermission(permission: Permission): void {
    this.permission = permission;
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

  /**
   * Dispatches a comment operation. Guests send to host; Host validates and applies to Y.Map.
   */
  public async dispatchOp(op: CommentOp): Promise<void> {
    if (this.role === 'host') {
      const existing = this.commentsMap.get(op.threadId);
      const validation = validateCommentOp(
        op,
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

      this.applyOpToYMap(op, this.userId, this.userName);
    } else {
      // Guest sends to host
      this.connection.send(op);
    }
  }

  private handleCommentOpMessage(op: CommentOp): void {
    if (this.role !== 'host') return;

    // Sender is guest; find their info from connection if needed or sender metadata
    const existing = this.commentsMap.get(op.threadId);
    const sender = {
      id: 'guest',
      role: 'guest' as const,
      displayName: 'Guest',
      permission: this.permission,
    };

    const validation = validateCommentOp(op, sender, this.allowReadOnlyComments, existing);
    if (!validation.valid) {
      Logger.warn('Rejected invalid comment.op from guest', { error: validation.error, op });
      return;
    }

    this.applyOpToYMap(op, sender.id, sender.displayName);
  }

  public applyOpToYMap(op: CommentOp, authorId: string, authorName: string): void {
    this.commentsDoc.transact(() => {
      switch (op.op) {
        case 'create': {
          if (!op.path || !op.range || !op.body) return;
          const newComment: CommentData = {
            id: `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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

          const reply: CommentData = {
            id: `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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
          if (!thread || !op.commentId) return;

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
   * Synchronizes comment threads with active/visible editors.
   */
  public syncCommentThreads(): void {
    if (this.isDisposed) return;
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) return;

    const currentPath = this.normalizeDocumentPath(activeEditor.document);
    if (!currentPath) return;

    const docThreads = this.getAllThreads().filter((t) => t.path === currentPath);
    const currentThreadIds = new Set<string>();

    for (const threadData of docThreads) {
      currentThreadIds.add(threadData.id);
      const existingThread = this.activeThreads.get(threadData.id);

      // Resolve anchored position using RelativePosition if available
      const resolvedRange = this.resolveAnchorRange(activeEditor.document, threadData);

      const vsComments: vscode.Comment[] = threadData.comments.map((c) => ({
        author: {
          name: c.authorName,
          iconPath: vscode.Uri.parse(generateInitialsAvatarSvg(c.authorName, '#4A90E2')),
        },
        body: new vscode.MarkdownString(c.body, false),
        mode: vscode.CommentMode.Preview,
        contextValue: c.authorId === this.userId || this.role === 'host' ? 'canDelete' : undefined,
      }));

      if (existingThread) {
        existingThread.range = resolvedRange;
        existingThread.comments = vsComments;
        existingThread.contextValue = threadData.resolved ? 'resolved' : 'unresolved';
        existingThread.collapsibleState = threadData.resolved
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
      } else {
        const newThread = this.commentController.createCommentThread(
          activeEditor.document.uri,
          resolvedRange,
          vsComments,
        );
        newThread.canReply = !threadData.resolved && (this.permission !== 'readOnly' || this.allowReadOnlyComments);
        newThread.contextValue = threadData.resolved ? 'resolved' : 'unresolved';
        newThread.collapsibleState = threadData.resolved
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
        this.activeThreads.set(threadData.id, newThread);
      }
    }

    // Dispose threads that no longer exist or are in other documents
    for (const [id, thread] of this.activeThreads.entries()) {
      if (!currentThreadIds.has(id)) {
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
      let p = doc.uri.path.replace(/^\/+/, '');
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
        }
      }
    });

    return count;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const thread of this.activeThreads.values()) {
      thread.dispose();
    }
    this.activeThreads.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this._onDidChangeComments.dispose();
  }
}
