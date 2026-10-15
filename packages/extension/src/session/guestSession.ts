import * as vscode from 'vscode';
import {
  ColiveMessage,
  GuestJoin,
  ParticipantInfo,
  Permission,
  PROTOCOL_VERSION,
  ServerJoinAccepted,
  ServerJoinRejected,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { Logger } from '../logger.js';
import { Strings } from '../strings.js';
import { CoLiveFileSystemProvider } from '../guest/coliveFileSystem.js';
import { SyncManager } from '../sync/SyncManager.js';
import { PresenceManager } from '../presence/PresenceManager.js';
import { RemoteCursorRenderer } from '../presence/RemoteCursorRenderer.js';
import { FollowController } from '../presence/FollowController.js';
import { CommentsManager } from '../comments/CommentsManager.js';
import { GuestDiagnosticsReceiver } from '../diagnostics/diagnosticsService.js';
import { GuestTerminalService } from '../terminal/index.js';
import { SessionController } from './sessionController.js';
import { buildDeepLink, buildWebInviteUrl, buildPasteCode } from '../invite.js';

export class GuestSession extends SessionController {
  public sessionId: string;
  public inviteSecret: string;
  public guestId = '';
  public guestToken = '';
  public permission: Permission = 'readWrite';
  public hostInfo: ParticipantInfo | null = null;
  public fsProvider: CoLiveFileSystemProvider | null = null;
  public syncManager: SyncManager | null = null;
  public presenceManager: PresenceManager | null = null;
  public cursorRenderer: RemoteCursorRenderer | null = null;
  public followController: FollowController | null = null;
  public commentsManager: CommentsManager | null = null;
  public diagnosticsReceiver: GuestDiagnosticsReceiver | null = null;
  public terminalService: GuestTerminalService | null = null;
  private fsRegistration: vscode.Disposable | null = null;
  private mountedFolderUri: vscode.Uri | null = null;
  private serverUrl: string;
  private displayName: string;

  constructor(serverUrl: string, sessionId: string, inviteSecret: string, displayName: string, guestToken = '') {
    super();
    this.serverUrl = serverUrl;
    this.sessionId = sessionId;
    this.inviteSecret = inviteSecret;
    this.displayName = displayName;
    this.guestToken = guestToken;
  }

  public async join(): Promise<void> {
    this.setState('connecting');
    this.connection = new ConnectionManager(this.serverUrl, 'guest');

    this.connection.on('message', (msg: ColiveMessage) => {
      this.handleMessage(msg);
    });

    this.connection.on('stateChange', (connState) => {
      if (connState === 'reconnecting') {
        this.setState('reconnecting');
      } else if (connState === 'connected' && this.state === 'reconnecting') {
        this.rejoinWithToken();
      }
    });

    this.connection.on('reconnected', () => {
      this.rejoinWithToken();
    });

    await this.connection.connect();

    // Show progress while waiting for host approval
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CoLive',
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: Strings.waitingApproval });

        token.onCancellationRequested(() => {
          this.endSession();
        });

        const joinReq: GuestJoin = {
          v: PROTOCOL_VERSION,
          type: 'guest.join',
          sessionId: this.sessionId,
          inviteSecret: this.inviteSecret,
          guestToken: this.guestToken || undefined,
          displayName: this.displayName,
        };

        const res = await this.connection!.request<ServerJoinAccepted | ServerJoinRejected>(joinReq, 60_000);

        if (res.type === 'server.joinRejected') {
          this.setState('ended', res.reason);
          throw new Error(res.reason || Strings.joinRejected);
        }

        if (res.type === 'server.joinAccepted') {
          this.guestId = res.guestId;
          this.guestToken = res.guestToken;
          this.permission = res.permission;
          this.hostInfo = res.hostInfo;

          // Set host and all participants
          this.participantsMap.set(res.hostInfo.id, res.hostInfo);
          for (const p of res.participants) {
            this.participantsMap.set(p.id, p);
          }
          // Set self
          this.participantsMap.set(this.guestId, {
            id: this.guestId,
            role: 'guest',
            displayName: this.displayName,
            color: '#3CB44B',
            permission: this.permission,
            status: 'active',
          });

          // Initialize sync manager
          this.syncManager = new SyncManager({
            connection: this.connection!,
            role: 'guest',
            isReadOnly: this.permission === 'readOnly',
          });

          // Register Virtual File System Provider
          this.fsProvider = new CoLiveFileSystemProvider(
            this.connection!,
            this.permission === 'readOnly',
            (relPath) => !!this.syncManager?.getYText(relPath),
          );
          const folderName = this.hostInfo ? `CoLive: ${this.hostInfo.displayName}` : 'CoLive: Shared';
          try {
            this.fsRegistration = vscode.workspace.registerFileSystemProvider(
              CoLiveFileSystemProvider.SCHEME,
              this.fsProvider,
              { isCaseSensitive: true, isReadonly: this.permission === 'readOnly' },
            );

            const rootUri = vscode.Uri.parse(`colive:/${encodeURIComponent(folderName)}`);
            this.mountedFolderUri = rootUri;

            const existingFolders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;
            vscode.workspace.updateWorkspaceFolders(existingFolders, 0, { uri: rootUri, name: folderName });
          } catch (fsErr) {
            Logger.warn('Virtual FileSystemProvider registration note', { fsErr });
          }

          // Initialize presence and cursor rendering
          this.presenceManager = new PresenceManager({
            connection: this.connection!,
            role: 'guest',
            userId: this.guestId,
            userName: this.displayName,
            userColor: '#3CB44B',
            syncManager: this.syncManager,
          });
          this.cursorRenderer = new RemoteCursorRenderer(
            this.presenceManager,
            this.guestId,
            this.syncManager,
          );
          this.followController = new FollowController({
            presenceManager: this.presenceManager,
            connection: this.connection!,
            role: 'guest',
          });

          // Initialize comments manager
          this.commentsManager = new CommentsManager({
            connection: this.connection!,
            role: 'guest',
            userId: this.guestId,
            userName: this.displayName,
            userColor: '#3CB44B',
            permission: this.permission,
            syncManager: this.syncManager,
            folderName,
            allowReadOnlyComments: true,
          });

          // Initialize diagnostics receiver
          this.diagnosticsReceiver = new GuestDiagnosticsReceiver(
            this.connection!,
            folderName,
          );

          // Initialize guest terminal service
          this.terminalService = new GuestTerminalService(this.connection!);
          this.terminalService.setReadOnly(this.permission !== 'terminalAccess');

          this.setState('active');
          this._onDidChangeParticipants.fire(this.getParticipants());
          vscode.window.showInformationMessage(Strings.joinApproved);
        }
      },
    );
  }

  private async rejoinWithToken(): Promise<void> {
    if (!this.connection || !this.guestToken) return;
    Logger.info('Rejoining session automatically with existing guestToken');
    const joinReq: GuestJoin = {
      v: PROTOCOL_VERSION,
      type: 'guest.join',
      sessionId: this.sessionId,
      inviteSecret: this.inviteSecret,
      guestToken: this.guestToken,
      displayName: this.displayName,
    };
    try {
      const res = await this.connection.request<ServerJoinAccepted | ServerJoinRejected>(joinReq, 15000);
      if (res.type === 'server.joinAccepted') {
        this.guestId = res.guestId;
        this.guestToken = res.guestToken;
        this.permission = res.permission;
        this.hostInfo = res.hostInfo;

        this.participantsMap.set(res.hostInfo.id, res.hostInfo);
        for (const p of res.participants) {
          this.participantsMap.set(p.id, p);
        }
        this.participantsMap.set(this.guestId, {
          id: this.guestId,
          role: 'guest',
          displayName: this.displayName,
          color: '#3CB44B',
          permission: this.permission,
          status: 'active',
        });

        this.setState('active');
        this._onDidChangeParticipants.fire(this.getParticipants());
        vscode.window.setStatusBarMessage('CoLive: Reconnected to host', 4000);
      } else if (res.type === 'server.joinRejected') {
        Logger.warn('Rejoin was rejected by server', res.reason);
        this.setState('ended', res.reason);
        this.dispose();
      }
    } catch (err) {
      Logger.warn('Failed to rejoin session with token', { err });
    }
  }

  private handleMessage(msg: ColiveMessage): void {
    if (msg.type === 'server.participantJoined') {
      this.participantsMap.set(msg.participant.id, msg.participant);
      this._onDidChangeParticipants.fire(this.getParticipants());
      vscode.window.setStatusBarMessage(`CoLive: ${msg.participant.displayName} joined the session`, 4000);
      return;
    }

    if (msg.type === 'server.participantLeft') {
      const p = this.participantsMap.get(msg.participantId);
      this.participantsMap.delete(msg.participantId);
      this.presenceManager?.removeUser(msg.participantId);
      this.cursorRenderer?.removeParticipant(msg.participantId);
      this._onDidChangeParticipants.fire(this.getParticipants());
      if (p) {
        vscode.window.setStatusBarMessage(`CoLive: ${p.displayName} left the session`, 4000);
        Logger.info(`Participant left and removed: ${p.displayName} (${msg.participantId})`);
      }
      return;
    }

    if (msg.type === 'server.participantUpdated') {
      this.participantsMap.set(msg.participant.id, msg.participant);
      if (msg.participant.id === this.guestId) {
        this.permission = msg.participant.permission;
        const isReadOnly = this.permission === 'readOnly';
        this.fsProvider?.setReadOnly(isReadOnly);
        this.syncManager?.setReadOnly(isReadOnly);
        const hasTerminalAccess = this.permission === 'terminalAccess';
        this.terminalService?.setReadOnly(!hasTerminalAccess);
      }
      this._onDidChangeParticipants.fire(this.getParticipants());
      return;
    }

    if (msg.type === 'server.sessionEnded') {
      this.setState('ended', msg.reason);
      vscode.window.showWarningMessage(`CoLive session ended: ${msg.reason}`);
      this.dispose();
      return;
    }
  }

  public async copyInvite(): Promise<void> {
    const deepLink = buildDeepLink(this.sessionId, this.inviteSecret, this.serverUrl);
    const webLink = buildWebInviteUrl(this.sessionId, this.inviteSecret, this.serverUrl);
    const code = buildPasteCode(this.sessionId, this.inviteSecret, this.serverUrl);

    await vscode.env.clipboard.writeText(deepLink);

    const buttons: string[] = [];
    if (webLink) buttons.push('Copy Web Link');
    buttons.push('Copy Short Code');

    vscode.window
      .showInformationMessage('CoLive: Short invite link copied to clipboard.', ...buttons)
      .then(async (action) => {
        if (action === 'Copy Web Link' && webLink) {
          await vscode.env.clipboard.writeText(webLink);
          vscode.window.showInformationMessage('CoLive: Web invite link copied to clipboard.');
        } else if (action === 'Copy Short Code') {
          await vscode.env.clipboard.writeText(code);
          vscode.window.showInformationMessage('CoLive: Short invite code copied to clipboard.');
        }
      });
  }

  public async endSession(): Promise<void> {
    this.setState('ended', 'Left session');
    this.dispose();
  }

  public override dispose(): void {
    if (this.isDisposed) return;

    if (this.terminalService) {
      try {
        this.terminalService.dispose();
      } catch (err) {
        Logger.warn('Error disposing terminalService', { err });
      }
      this.terminalService = null;
    }
    if (this.diagnosticsReceiver) {
      try {
        this.diagnosticsReceiver.dispose();
      } catch (err) {
        Logger.warn('Error disposing diagnosticsReceiver', { err });
      }
      this.diagnosticsReceiver = null;
    }
    if (this.commentsManager) {
      try {
        this.commentsManager.dispose();
      } catch (err) {
        Logger.warn('Error disposing commentsManager', { err });
      }
      this.commentsManager = null;
    }
    if (this.followController) {
      try {
        this.followController.dispose();
      } catch (err) {
        Logger.warn('Error disposing followController', { err });
      }
      this.followController = null;
    }
    if (this.cursorRenderer) {
      try {
        this.cursorRenderer.dispose();
      } catch (err) {
        Logger.warn('Error disposing cursorRenderer', { err });
      }
      this.cursorRenderer = null;
    }
    if (this.presenceManager) {
      try {
        this.presenceManager.dispose();
      } catch (err) {
        Logger.warn('Error disposing presenceManager', { err });
      }
      this.presenceManager = null;
    }

    if (this.syncManager) {
      try {
        this.syncManager.dispose();
      } catch (err) {
        Logger.warn('Error disposing syncManager', { err });
      }
      this.syncManager = null;
    }

    if (vscode.workspace.workspaceFolders) {
      for (let i = vscode.workspace.workspaceFolders.length - 1; i >= 0; i--) {
        const folder = vscode.workspace.workspaceFolders[i];
        if (folder.uri.scheme === 'colive' || (this.mountedFolderUri && folder.uri.toString() === this.mountedFolderUri.toString())) {
          vscode.workspace.updateWorkspaceFolders(i, 1);
        }
      }
      this.mountedFolderUri = null;
    }

    if (this.fsRegistration) {
      try {
        this.fsRegistration.dispose();
      } catch (err) {
        Logger.warn('Error disposing fsRegistration', { err });
      }
      this.fsRegistration = null;
    }

    if (this.fsProvider) {
      try {
        this.fsProvider.dispose();
      } catch (err) {
        Logger.warn('Error disposing fsProvider', { err });
      }
      this.fsProvider = null;
    }

    super.dispose();
  }
}
