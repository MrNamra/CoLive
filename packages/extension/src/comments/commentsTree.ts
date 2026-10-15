import * as vscode from 'vscode';
import { CommentThreadData } from '@colive/protocol';
import { CommentsManager } from './CommentsManager.js';

export type TreeItemType = 'file' | 'thread';

export class CommentTreeItem extends vscode.TreeItem {
  public itemType: TreeItemType;
  public filePath?: string;
  public threadData?: CommentThreadData;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    itemType: TreeItemType,
    filePath?: string,
    threadData?: CommentThreadData,
  ) {
    super(label, collapsibleState);
    this.itemType = itemType;
    this.filePath = filePath;
    this.threadData = threadData;

    if (itemType === 'file') {
      this.iconPath = new vscode.ThemeIcon('file');
      this.contextValue = 'commentFile';
    } else if (threadData) {
      this.iconPath = threadData.resolved
        ? new vscode.ThemeIcon('pass-filled')
        : new vscode.ThemeIcon('comment-discussion');
      this.contextValue = threadData.resolved ? 'resolvedThread' : 'unresolvedThread';
      const commentCount = threadData.comments.length;
      const countLabel = commentCount > 100 ? '100+ comments' : `${commentCount} comment${commentCount > 1 ? 's' : ''}`;
      const lineLabel = `line ${threadData.range.startLine + 1}`;
      this.description = `${lineLabel} • ${countLabel}${threadData.resolved ? ' • [Resolved]' : ''}`;

      const firstComment = threadData.comments[0];
      this.tooltip = firstComment
        ? `${firstComment.authorName}: ${firstComment.body.slice(0, 100)}`
        : 'Comment thread';

      // Click opens file and reveals line
      this.command = {
        command: 'colive.openCommentThread',
        title: 'Go to Comment',
        arguments: [threadData],
      };
    }
  }
}

export class CommentsTreeProvider implements vscode.TreeDataProvider<CommentTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<CommentTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private commentsManager: CommentsManager | null = null;
  private disposables: vscode.Disposable[] = [];

  public setCommentsManager(manager: CommentsManager | null): void {
    for (const d of this.disposables) {
      d?.dispose();
    }
    this.disposables = [];

    this.commentsManager = manager;
    if (manager) {
      this.disposables.push(
        manager.onDidChangeComments(() => {
          this._onDidChangeTreeData.fire();
        }),
      );
    }
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: CommentTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: CommentTreeItem): Thenable<CommentTreeItem[]> {
    if (!this.commentsManager) {
      return Promise.resolve([]);
    }

    const allThreads = this.commentsManager.getAllThreads();

    if (!element) {
      // Group by file
      const groups = new Map<string, CommentThreadData[]>();
      for (const thread of allThreads) {
        const fileKey = thread.path || 'Orphaned';
        const list = groups.get(fileKey) || [];
        list.push(thread);
        groups.set(fileKey, list);
      }

      const fileItems: CommentTreeItem[] = [];
      for (const [filePath, threads] of groups.entries()) {
        const hasUnresolved = threads.some((t) => !t.resolved);
        const item = new CommentTreeItem(
          filePath,
          vscode.TreeItemCollapsibleState.Expanded,
          'file',
          filePath,
        );
        const count = threads.length;
        item.description = `${count} thread${count > 1 ? 's' : ''}${hasUnresolved ? ' (unresolved)' : ''}`;
        fileItems.push(item);
      }

      // Sort files: unresolved first, then alphabetically, "Orphaned" last
      fileItems.sort((a, b) => {
        if (a.filePath === 'Orphaned') return 1;
        if (b.filePath === 'Orphaned') return -1;
        return (a.filePath || '').localeCompare(b.filePath || '');
      });

      return Promise.resolve(fileItems);
    }

    if (element.itemType === 'file' && element.filePath) {
      const fileThreads = allThreads.filter((t) => (t.path || 'Orphaned') === element.filePath);
      // Sort threads: unresolved first, then by line number
      fileThreads.sort((a, b) => {
        if (a.resolved !== b.resolved) {
          return a.resolved ? 1 : -1;
        }
        return a.range.startLine - b.range.startLine;
      });

      const threadItems = fileThreads.map((t) => {
        const snippet = t.comments[0]?.body.slice(0, 35) || 'Thread';
        return new CommentTreeItem(
          snippet,
          vscode.TreeItemCollapsibleState.None,
          'thread',
          element.filePath,
          t,
        );
      });

      return Promise.resolve(threadItems);
    }

    return Promise.resolve([]);
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d?.dispose();
    }
    this.disposables = [];
    this._onDidChangeTreeData.dispose();
  }
}
