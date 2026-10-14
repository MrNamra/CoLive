import * as vscode from 'vscode';
import { PresenceManager, UserPresenceState } from './PresenceManager.js';
import { CoLiveFileSystemProvider } from '../guest/coliveFileSystem.js';
import { Role } from '@colive/protocol';
import { ConnectionManager } from '../connection.js';

export interface FollowControllerOptions {
  presenceManager: PresenceManager;
  connection: ConnectionManager;
  role: Role;
  workspaceRoot?: string;
  folderName?: string;
}

/**
 * Follow Controller for CoLive sessions.
 * Allows a participant to smoothly mirror another participant's active editor
 * and viewport scroll position without displacing the follower's own cursor.
 * Auto-stops on manual navigation and shows a clickable status bar item.
 */
export class FollowController implements vscode.Disposable {
  private presenceManager: PresenceManager;
  private connection: ConnectionManager;
  private role: Role;
  private workspaceRoot?: string;
  private folderName: string;

  private followingUserId: string | null = null;
  private followingUserName: string | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private isProgrammaticNavigation = false;
  private programmaticNavTimestamp = 0;
  private disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  constructor(options: FollowControllerOptions) {
    this.presenceManager = options.presenceManager;
    this.connection = options.connection;
    this.role = options.role;
    this.workspaceRoot = options.workspaceRoot;
    this.folderName = options.folderName || 'Shared';

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'colive.stopFollowing';
    this.disposables.push(this.statusBarItem);

    this.setupListeners();
  }

  public isFollowing(): boolean {
    return this.followingUserId !== null;
  }

  public getFollowingUserId(): string | null {
    return this.followingUserId;
  }

  private setupListeners(): void {
    // 1. Follow updates on presence state change
    this.disposables.push(
      this.presenceManager.onDidChangePresence((states) => {
        if (!this.followingUserId) return;

        const target = states.get(this.followingUserId);
        if (!target) {
          this.stopFollowing('Target participant left the session');
          return;
        }

        this.applyFollowUpdate(target);
      }),
    );

    // 2. Detect manual user navigation to auto-stop follow
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.checkManualNavigation();
      }),
    );

    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges(() => {
        this.checkManualNavigation();
      }),
    );
  }

  public onManualNavigation(): void {
    if (this.followingUserId) {
      this.stopFollowing('Auto-stopped following due to manual navigation');
    }
  }

  private checkManualNavigation(): void {
    if (!this.followingUserId) return;
    const now = Date.now();

    // If navigation happened without recent programmatic trigger (> 250ms), user navigated manually
    if (!this.isProgrammaticNavigation && now - this.programmaticNavTimestamp > 250) {
      this.onManualNavigation();
    }
  }

  public followParticipant(userId: string, userName: string): void {
    this.followingUserId = userId;
    this.followingUserName = userName;

    this.statusBarItem.text = `$(eye) Following ${userName}`;
    this.statusBarItem.tooltip = `Currently following ${userName}. Click to stop following.`;
    this.statusBarItem.show();

    // Notify session / server subtly
    this.connection.send({
      v: 1,
      type: 'chat.message',
      text: `/followed ${userName}`,
    });

    const states = this.presenceManager.getStates();
    const target = states.get(userId);
    if (target) {
      this.applyFollowUpdate(target);
    }
  }

  public stopFollowing(reason?: string): void {
    if (!this.followingUserId) return;

    const name = this.followingUserName;
    this.followingUserId = null;
    this.followingUserName = null;
    this.statusBarItem.hide();

    if (reason) {
      vscode.window.setStatusBarMessage(`CoLive: ${reason}`, 3000);
    } else if (name) {
      vscode.window.setStatusBarMessage(`CoLive: Stopped following ${name}`, 3000);
    }
  }

  public handlePresenceChange(target: UserPresenceState): void {
    if (this.followingUserId === target.user.id) {
      this.applyFollowUpdate(target);
    }
  }

  public async applyFollowUpdate(target: UserPresenceState): Promise<void> {
    if (!target.activeFile) return;

    const targetUri = this.resolveFileUri(target.activeFile);
    if (!targetUri) return;

    this.isProgrammaticNavigation = true;
    this.programmaticNavTimestamp = Date.now();

    try {
      // 1. Ensure file is opened in editor (preview mode, preserve focus)
      let editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== targetUri.toString()) {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        editor = (await vscode.window.showTextDocument(doc, {
          preview: true,
          preserveFocus: true,
        })) as vscode.TextEditor;
      }

      // 2. Reveal viewport if target has viewport coordinates
      if (editor && target.viewport) {
        const targetLine = Math.floor((target.viewport.startLine + target.viewport.endLine) / 2);
        const clampedLine = Math.max(0, Math.min(targetLine, editor.document.lineCount - 1));
        const targetRange = new vscode.Range(
          new vscode.Position(clampedLine, 0),
          new vscode.Position(clampedLine, 0),
        );

        editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch {
      // Ignore follow display error
    } finally {
      setTimeout(() => {
        this.isProgrammaticNavigation = false;
      }, 100);
    }
  }

  private resolveFileUri(relPath: string): vscode.Uri | null {
    if (this.role === 'host' && this.workspaceRoot) {
      return vscode.Uri.file(`${this.workspaceRoot}/${relPath}`);
    } else if (this.role === 'guest') {
      return vscode.Uri.from({
        scheme: CoLiveFileSystemProvider.SCHEME,
        path: `/${encodeURIComponent(this.folderName)}/${relPath}`,
      });
    }
    return null;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.followingUserId = null;
    this.followingUserName = null;
    this.statusBarItem.dispose();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
