import * as vscode from 'vscode';
import { HostSession } from '../session/hostSession.js';
import { GuestSession } from '../session/guestSession.js';
import { SessionController } from '../session/sessionController.js';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private currentSession: SessionController | null = null;
  private stateListener: vscode.Disposable | null = null;
  private participantsListener: vscode.Disposable | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'colive.statusBarClicked';
    this.update();
    this.item.show();
  }

  public setSession(session: SessionController | null): void {
    if (this.stateListener) this.stateListener.dispose();
    if (this.participantsListener) this.participantsListener.dispose();

    this.currentSession = session;

    if (session) {
      this.stateListener = session.onDidChangeState(() => this.update());
      this.participantsListener = session.onDidChangeParticipants(() => this.update());
    }

    this.update();
  }

  public update(): void {
    if (!this.currentSession || this.currentSession.getState() === 'idle' || this.currentSession.getState() === 'ended') {
      this.item.text = '$(live-share) CoLive';
      this.item.tooltip = 'CoLive: Idle (Click to share workspace or join)';
      return;
    }

    const state = this.currentSession.getState();
    if (state === 'connecting') {
      this.item.text = '$(loading~spin) CoLive: Connecting...';
      this.item.tooltip = 'Connecting to CoLive relay server...';
      return;
    }

    if (state === 'reconnecting') {
      this.item.text = '$(loading~spin) CoLive: Reconnecting...';
      this.item.tooltip = 'Lost connection. Attempting to reconnect...';
      return;
    }

    if (this.currentSession instanceof HostSession) {
      const count = this.currentSession.getParticipants().length;
      this.item.text = `$(broadcast) CoLive: hosting (${count})`;
      this.item.tooltip = `Hosting session (${this.currentSession.sessionId}). Click for options.`;
    } else if (this.currentSession instanceof GuestSession) {
      const hostName = this.currentSession.hostInfo?.displayName || 'Host';
      this.item.text = `$(person) CoLive: ${hostName}`;
      this.item.tooltip = `Connected to ${hostName}'s workspace (${this.currentSession.sessionId}). Click for options.`;
    }
  }

  public async handleClick(): Promise<void> {
    if (!this.currentSession || this.currentSession.getState() === 'idle' || this.currentSession.getState() === 'ended') {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(broadcast) Share Workspace', description: 'Host a real-time collaboration session', action: 'share' },
          { label: '$(sign-in) Join Session', description: 'Join an existing session via link or code', action: 'join' },
          { label: '$(output) Show Output Logs', description: 'View backend relay & tunnel process logs', action: 'showLogs' },
        ],
        { placeHolder: 'CoLive Collaboration' },
      );

      if (choice?.action === 'share') {
        vscode.commands.executeCommand('colive.startSession');
      } else if (choice?.action === 'join') {
        vscode.commands.executeCommand('colive.joinSession');
      } else if (choice?.action === 'showLogs') {
        vscode.commands.executeCommand('colive.showLogs');
      }
      return;
    }

    const actions = [
      { label: '$(clippy) Copy Invite Link', action: 'copyInvite' },
      { label: '$(organization) Show Participants', action: 'showParticipants' },
      { label: '$(output) Show Output Logs', action: 'showLogs' },
      { label: '$(circle-slash) End / Leave Session', action: 'endSession' },
    ];

    const pick = await vscode.window.showQuickPick(actions, { placeHolder: 'CoLive Session Actions' });
    if (pick?.action === 'copyInvite') {
      this.currentSession.copyInvite();
    } else if (pick?.action === 'showParticipants') {
      vscode.commands.executeCommand('colive.participants.focus');
    } else if (pick?.action === 'showLogs') {
      vscode.commands.executeCommand('colive.showLogs');
    } else if (pick?.action === 'endSession') {
      vscode.commands.executeCommand('colive.endSession');
    }
  }

  public dispose(): void {
    if (this.stateListener) this.stateListener.dispose();
    if (this.participantsListener) this.participantsListener.dispose();
    this.item.dispose();
  }
}
