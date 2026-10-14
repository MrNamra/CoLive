import * as vscode from 'vscode';
import { ParticipantInfo } from '@colive/protocol';
import { SessionController } from '../session/sessionController.js';

export class ParticipantTreeItem extends vscode.TreeItem {
  public participant: ParticipantInfo;

  constructor(participant: ParticipantInfo) {
    super(participant.displayName, vscode.TreeItemCollapsibleState.None);
    this.participant = participant;

    const isHost = participant.role === 'host';
    this.iconPath = isHost
      ? new vscode.ThemeIcon('workspace-trusted', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));

    const permLabel = participant.permission === 'readOnly' ? ' [Read-only]' : '';
    const fileLabel = participant.activeFile ? ` • ${participant.activeFile}` : '';
    this.description = `${isHost ? 'Host' : 'Guest'}${permLabel}${fileLabel}`;

    this.tooltip = `${participant.displayName} (${isHost ? 'Host' : 'Guest'})\nStatus: ${participant.status}\nPermission: ${participant.permission}`;
    this.contextValue = isHost ? 'host' : 'participant';
  }
}

export class ParticipantsTreeProvider implements vscode.TreeDataProvider<ParticipantTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<ParticipantTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentSession: SessionController | null = null;
  private listener: vscode.Disposable | null = null;

  public setSession(session: SessionController | null): void {
    if (this.listener) this.listener.dispose();
    this.currentSession = session;

    if (session) {
      this.listener = session.onDidChangeParticipants(() => {
        this._onDidChangeTreeData.fire();
      });
    }

    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: ParticipantTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): Thenable<ParticipantTreeItem[]> {
    if (!this.currentSession || this.currentSession.getState() !== 'active') {
      return Promise.resolve([]);
    }

    const participants = this.currentSession.getParticipants();
    // Sort host first, then guests alphabetically
    participants.sort((a, b) => {
      if (a.role === 'host') return -1;
      if (b.role === 'host') return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    const items = participants.map((p) => new ParticipantTreeItem(p));
    return Promise.resolve(items);
  }

  public dispose(): void {
    if (this.listener) this.listener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
