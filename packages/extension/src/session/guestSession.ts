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
import { buildPasteCode } from '../invite.js';
import { Logger } from '../logger.js';
import { Strings } from '../strings.js';
import { CoLiveFileSystemProvider } from '../guest/coliveFileSystem.js';
import { SyncManager } from '../sync/SyncManager.js';
import { SessionController } from './sessionController.js';

export class GuestSession extends SessionController {
  public sessionId: string;
  public inviteSecret: string;
  public guestId = '';
  public guestToken = '';
  public permission: Permission = 'readWrite';
  public hostInfo: ParticipantInfo | null = null;
  public fsProvider: CoLiveFileSystemProvider | null = null;
  public syncManager: SyncManager | null = null;
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
          try {
            this.fsRegistration = vscode.workspace.registerFileSystemProvider(
              CoLiveFileSystemProvider.SCHEME,
              this.fsProvider,
              { isCaseSensitive: true, isReadonly: this.permission === 'readOnly' },
            );

            const folderName = this.hostInfo ? `CoLive: ${this.hostInfo.displayName}` : 'CoLive: Shared';
            const rootUri = vscode.Uri.parse(`colive:/${encodeURIComponent(folderName)}`);
            this.mountedFolderUri = rootUri;

            const existingFolders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;
            vscode.workspace.updateWorkspaceFolders(existingFolders, 0, { uri: rootUri, name: folderName });
          } catch (fsErr) {
            Logger.warn('Virtual FileSystemProvider registration note', { fsErr });
          }

          this.setState('active');
          this._onDidChangeParticipants.fire(this.getParticipants());
          vscode.window.showInformationMessage(Strings.joinApproved);
        }
      },
    );
  }

  private rejoinWithToken(): void {
    if (!this.connection || !this.guestToken) return;
    Logger.info('Rejoining session automatically with existing guestToken');
    const joinReq: GuestJoin = {
      v: PROTOCOL_VERSION,
      type: 'guest.join',
      sessionId: this.sessionId,
      guestToken: this.guestToken,
      displayName: this.displayName,
    };
    this.connection.send(joinReq);
    this.setState('active');
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
      if (p) {
        p.status = 'idle';
        this._onDidChangeParticipants.fire(this.getParticipants());
        vscode.window.setStatusBarMessage(`CoLive: ${p.displayName} left the session`, 4000);
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
    const pasteCode = buildPasteCode(this.sessionId, this.inviteSecret);
    await vscode.env.clipboard.writeText(pasteCode);
    vscode.window.showInformationMessage('CoLive: Invite code copied to clipboard.');
  }

  public async endSession(): Promise<void> {
    this.setState('ended', 'Left session');
    this.dispose();
  }

  public override dispose(): void {
    if (this.syncManager) {
      this.syncManager.dispose();
      this.syncManager = null;
    }

    if (this.mountedFolderUri && vscode.workspace.workspaceFolders) {
      const idx = vscode.workspace.workspaceFolders.findIndex(
        (f) => f.uri.toString() === this.mountedFolderUri!.toString(),
      );
      if (idx >= 0) {
        vscode.workspace.updateWorkspaceFolders(idx, 1);
      }
      this.mountedFolderUri = null;
    }

    if (this.fsRegistration) {
      this.fsRegistration.dispose();
      this.fsRegistration = null;
    }

    if (this.fsProvider) {
      this.fsProvider.dispose();
      this.fsProvider = null;
    }

    super.dispose();
  }
}
