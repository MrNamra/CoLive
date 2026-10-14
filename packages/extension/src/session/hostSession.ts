import * as vscode from 'vscode';
import {
  ColiveMessage,
  ParticipantInfo,
  Permission,
  PROTOCOL_VERSION,
  ServerJoinRequest,
  ServerSessionCreated,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { buildDeepLink, buildPasteCode } from '../invite.js';
import { Logger } from '../logger.js';
import { Strings } from '../strings.js';
import { HostFileService } from '../host/fileService.js';
import { SyncManager } from '../sync/SyncManager.js';
import { PresenceManager } from '../presence/PresenceManager.js';
import { RemoteCursorRenderer } from '../presence/RemoteCursorRenderer.js';
import { FollowController } from '../presence/FollowController.js';
import { CommentsManager } from '../comments/CommentsManager.js';
import { HostDiagnosticsBroadcaster } from '../diagnostics/diagnosticsService.js';
import { HostTerminalService } from '../terminal/index.js';
import { SessionController } from './sessionController.js';

export class HostSession extends SessionController {
  public sessionId = '';
  public hostToken = '';
  public inviteSecret = '';
  public expiresAt = 0;
  public fileService: HostFileService | null = null;
  public syncManager: SyncManager | null = null;
  public presenceManager: PresenceManager | null = null;
  public cursorRenderer: RemoteCursorRenderer | null = null;
  public followController: FollowController | null = null;
  public commentsManager: CommentsManager | null = null;
  public diagnosticsBroadcaster: HostDiagnosticsBroadcaster | null = null;
  public terminalService: HostTerminalService | null = null;
  private serverUrl: string;
  private publicServerUrl?: string;
  private displayName: string;
  private requireApproval: boolean;
  private workspaceRoot: string;
  private excludePatterns: string[];
  private maxFileSizeMB: number;

  constructor(
    serverUrl: string,
    displayName: string,
    workspaceRoot: string,
    excludePatterns: string[] = [],
    maxFileSizeMB = 5,
    requireApproval = true,
    publicServerUrl?: string,
  ) {
    super();
    this.serverUrl = serverUrl;
    this.publicServerUrl = publicServerUrl;
    this.displayName = displayName;
    this.workspaceRoot = workspaceRoot;
    this.excludePatterns = excludePatterns;
    this.maxFileSizeMB = maxFileSizeMB;
    this.requireApproval = requireApproval;
  }

  public async start(): Promise<void> {
    this.setState('connecting');
    this.connection = new ConnectionManager(this.serverUrl, 'host');

    this.connection.on('message', (msg: ColiveMessage) => {
      this.handleMessage(msg);
    });

    this.connection.on('stateChange', (connState) => {
      if (connState === 'reconnecting') {
        this.setState('reconnecting');
      } else if (connState === 'connected' && this.state === 'reconnecting') {
        this.setState('active');
      }
    });

    await this.connection.connect();

    Logger.info('Host requesting session creation from server');
    const createReq: ColiveMessage = {
      v: PROTOCOL_VERSION,
      type: 'host.createSession',
      displayName: this.displayName,
    };

    const res = await this.connection.request<ServerSessionCreated>(createReq);
    if (res.type !== 'server.sessionCreated') {
      throw new Error(`Unexpected session creation response: ${res.type}`);
    }

    this.sessionId = res.sessionId;
    this.hostToken = res.hostToken;
    this.inviteSecret = res.inviteSecret;
    this.expiresAt = res.expiresAt;

    // Initialize host file service
    this.fileService = new HostFileService(this.workspaceRoot, this.excludePatterns, this.maxFileSizeMB);
    this.fileService.setConnection(this.connection);

    // Initialize host sync manager
    this.syncManager = new SyncManager({
      connection: this.connection,
      role: 'host',
      workspaceRoot: this.workspaceRoot,
    });

    // Initialize presence and cursor rendering
    this.presenceManager = new PresenceManager({
      connection: this.connection,
      role: 'host',
      userId: 'host',
      userName: this.displayName,
      userColor: '#E6194B',
      workspaceRoot: this.workspaceRoot,
      syncManager: this.syncManager,
    });
    this.cursorRenderer = new RemoteCursorRenderer(
      this.presenceManager,
      'host',
      this.syncManager,
      this.workspaceRoot,
    );
    this.followController = new FollowController({
      presenceManager: this.presenceManager,
      connection: this.connection,
      role: 'host',
      workspaceRoot: this.workspaceRoot,
    });

    // Initialize comments manager
    this.commentsManager = new CommentsManager({
      connection: this.connection,
      role: 'host',
      userId: 'host',
      userName: this.displayName,
      userColor: '#E6194B',
      permission: 'readWrite',
      syncManager: this.syncManager,
      workspaceRoot: this.workspaceRoot,
      allowReadOnlyComments: true,
    });

    // Initialize diagnostics broadcaster
    this.diagnosticsBroadcaster = new HostDiagnosticsBroadcaster(
      this.connection,
      this.workspaceRoot,
    );

    // Initialize host terminal service
    this.terminalService = new HostTerminalService(
      this.connection,
      this.workspaceRoot,
    );

    // Add self as host participant
    const hostParticipant: ParticipantInfo = {
      id: 'host',
      role: 'host',
      displayName: this.displayName,
      color: '#E6194B',
      permission: 'readWrite',
      status: 'active',
    };
    this.participantsMap.set('host', hostParticipant);
    this.setState('active');
    this._onDidChangeParticipants.fire(this.getParticipants());

    // Copy deep link or paste code to clipboard by default
    const inviteServer = this.publicServerUrl || this.serverUrl;
    const deepLink = buildDeepLink(this.sessionId, this.inviteSecret, inviteServer);
    const pasteCode = buildPasteCode(this.sessionId, this.inviteSecret, inviteServer);
    await vscode.env.clipboard.writeText(deepLink);

    vscode.window
      .showInformationMessage(Strings.sessionStarted, Strings.copyLink, Strings.copyCode, Strings.showParticipants)
      .then((action) => {
        if (action === Strings.copyLink) {
          vscode.env.clipboard.writeText(deepLink);
          vscode.window.showInformationMessage('CoLive: Invite deep link copied to clipboard.');
        } else if (action === Strings.copyCode) {
          vscode.env.clipboard.writeText(pasteCode);
          vscode.window.showInformationMessage('CoLive: Invite code copied to clipboard.');
        } else if (action === Strings.showParticipants) {
          vscode.commands.executeCommand('colive.participants.focus');
        }
      });
  }

  private handleMessage(msg: ColiveMessage): void {
    if (msg.type === 'server.joinRequest') {
      this.handleJoinRequest(msg);
      return;
    }

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
      this._onDidChangeParticipants.fire(this.getParticipants());
      return;
    }

    if (msg.type === 'server.sessionEnded') {
      this.setState('ended', msg.reason);
      vscode.window.showWarningMessage(`CoLive session ended: ${msg.reason}`);
      return;
    }
  }

  private handleJoinRequest(req: ServerJoinRequest): void {
    if (!this.requireApproval) {
      // Auto-accept if configured
      this.connection?.send({
        v: PROTOCOL_VERSION,
        type: 'host.joinDecision',
        requestId: req.requestId,
        accept: true,
        permission: 'readWrite',
      });
      return;
    }

    vscode.window
      .showInformationMessage(
        `CoLive: "${req.displayName}" wants to join your session.`,
        Strings.acceptReadWrite,
        Strings.acceptReadOnly,
        Strings.decline,
      )
      .then((decision) => {
        if (decision === Strings.acceptReadWrite) {
          this.connection?.send({
            v: PROTOCOL_VERSION,
            type: 'host.joinDecision',
            requestId: req.requestId,
            accept: true,
            permission: 'readWrite',
          });
        } else if (decision === Strings.acceptReadOnly) {
          this.connection?.send({
            v: PROTOCOL_VERSION,
            type: 'host.joinDecision',
            requestId: req.requestId,
            accept: true,
            permission: 'readOnly',
          });
        } else {
          this.connection?.send({
            v: PROTOCOL_VERSION,
            type: 'host.joinDecision',
            requestId: req.requestId,
            accept: false,
            permission: 'readOnly',
            reason: 'Host declined the join request',
          });
        }
      });
  }

  public async setParticipantPermission(guestId: string, permission: Permission): Promise<void> {
    if (!this.connection) return;
    this.connection.send({
      v: PROTOCOL_VERSION,
      type: 'host.setPermission',
      guestId,
      permission,
    });
  }

  public async kickParticipant(guestId: string, reason?: string): Promise<void> {
    if (!this.connection) return;
    this.connection.send({
      v: PROTOCOL_VERSION,
      type: 'host.kick',
      guestId,
      reason,
    });
    this.participantsMap.delete(guestId);
    this._onDidChangeParticipants.fire(this.getParticipants());
  }

  public async copyInvite(): Promise<void> {
    const inviteServer = this.publicServerUrl || this.serverUrl;
    const deepLink = buildDeepLink(this.sessionId, this.inviteSecret, inviteServer);
    await vscode.env.clipboard.writeText(deepLink);
    vscode.window.showInformationMessage('CoLive: Worldwide invite link copied to clipboard.');
  }

  public async endSession(): Promise<void> {
    if (this.connection) {
      this.connection.send({
        v: PROTOCOL_VERSION,
        type: 'host.endSession',
      });
    }
    this.setState('ended', 'Host ended session');
    this.dispose();
  }

  public override dispose(): void {
    if (this.terminalService) {
      this.terminalService.dispose();
      this.terminalService = null;
    }
    if (this.diagnosticsBroadcaster) {
      this.diagnosticsBroadcaster.dispose();
      this.diagnosticsBroadcaster = null;
    }
    if (this.commentsManager) {
      this.commentsManager.dispose();
      this.commentsManager = null;
    }
    if (this.followController) {
      this.followController.dispose();
      this.followController = null;
    }
    if (this.cursorRenderer) {
      this.cursorRenderer.dispose();
      this.cursorRenderer = null;
    }
    if (this.presenceManager) {
      this.presenceManager.dispose();
      this.presenceManager = null;
    }
    if (this.syncManager) {
      this.syncManager.dispose();
      this.syncManager = null;
    }
    if (this.fileService) {
      this.fileService.dispose();
      this.fileService = null;
    }
    super.dispose();
  }
}
