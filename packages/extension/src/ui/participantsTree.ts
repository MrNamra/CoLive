import * as vscode from 'vscode';
import { ParticipantInfo } from '@colive/protocol';
import { SessionController } from '../session/sessionController.js';
import { GuestSession } from '../session/guestSession.js';
import { PresenceManager, UserPresenceState } from '../presence/PresenceManager.js';
import { FollowController } from '../presence/FollowController.js';

export class ActionTreeItem extends vscode.TreeItem {
  constructor(label: string, icon: string, commandId: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.description = description;
    this.command = {
      command: commandId,
      title: label,
    };
  }
}

export class ParticipantTreeItem extends vscode.TreeItem {
  public participant: ParticipantInfo;

  constructor(
    participant: ParticipantInfo,
    presence?: UserPresenceState,
    isFollowing = false,
  ) {
    super(participant.displayName, vscode.TreeItemCollapsibleState.None);
    this.participant = participant;

    const isHost = participant.role === 'host';
    this.iconPath = isHost
      ? new vscode.ThemeIcon('crown')
      : new vscode.ThemeIcon('circle-filled');

    const permLabel =
      participant.permission === 'readOnly'
        ? ' [Read-only]'
        : participant.permission === 'terminalAccess'
          ? ' [Terminal]'
          : '';
    const isTyping = presence && presence.typingUntil > Date.now();
    const typingLabel = isTyping ? ' $(pencil) typing...' : '';

    let locationLabel = '';
    if (presence?.activeFile) {
      const line = presence.cursor ? `:${presence.cursor.line + 1}` : '';
      locationLabel = ` • ${presence.activeFile}${line}`;
    }

    const followBadge = isFollowing ? ' $(eye) Following' : '';

    this.description = `${isHost ? 'Host' : 'Guest'}${permLabel}${locationLabel}${typingLabel}${followBadge}`;
    this.tooltip = `${participant.displayName} (${isHost ? 'Host' : 'Guest'})\nStatus: ${participant.status}\nPermission: ${participant.permission}${presence?.activeFile ? `\nEditing: ${presence.activeFile}` : ''}`;

    this.contextValue = isHost ? 'host' : isFollowing ? 'following' : 'participant';

    // Click on participant to follow them
    this.command = {
      command: 'colive.followParticipant',
      title: 'Follow Participant',
      arguments: [participant.id, participant.displayName],
    };
  }
}

export class ParticipantsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentSession: SessionController | null = null;
  private presenceManager: PresenceManager | null = null;
  private followController: FollowController | null = null;
  private disposables: vscode.Disposable[] = [];

  public setSession(
    session: SessionController | null,
    presenceManager: PresenceManager | null = null,
    followController: FollowController | null = null,
  ): void {
    for (const d of this.disposables) {
      d?.dispose();
    }
    this.disposables = [];

    this.currentSession = session;
    this.presenceManager = presenceManager;
    this.followController = followController;

    if (session) {
      this.disposables.push(
        session.onDidChangeParticipants(() => {
          this._onDidChangeTreeData.fire();
        }),
      );
      this.disposables.push(
        session.onDidChangeState(() => {
          this._onDidChangeTreeData.fire();
        }),
      );
    }

    if (presenceManager) {
      this.disposables.push(
        presenceManager.onDidChangePresence(() => {
          this._onDidChangeTreeData.fire();
        }),
      );
    }

    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): Thenable<vscode.TreeItem[]> {
    if (!this.currentSession || this.currentSession.getState() !== 'active') {
      return Promise.resolve([]);
    }

    const participants = this.currentSession.getParticipants().filter((p) => p.status === 'active');
    // Sort host first, then guests alphabetically
    participants.sort((a, b) => {
      if (a.role === 'host') return -1;
      if (b.role === 'host') return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    const states = this.presenceManager?.getStates();
    const followingId = this.followController?.getFollowingUserId();

    const items: vscode.TreeItem[] = participants.map((p) => {
      const presence = states?.get(p.id);
      const isFollowing = followingId === p.id;
      return new ParticipantTreeItem(p, presence, isFollowing);
    });

    const isGuest = this.currentSession instanceof GuestSession;
    items.push(
      new ActionTreeItem(
        isGuest ? 'Disconnect Session' : 'End Session',
        isGuest ? 'debug-disconnect' : 'circle-slash',
        'colive.endSession',
        isGuest ? 'Leave workspace' : 'Stop hosting',
      ),
    );

    return Promise.resolve(items);
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d?.dispose();
    }
    this.disposables = [];
    this._onDidChangeTreeData.dispose();
  }
}
