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
import { SessionController } from './sessionController.js';

export class HostSession extends SessionController {
  public sessionId = '';
  public hostToken = '';
  public inviteSecret = '';
  public expiresAt = 0;
  public fileService: HostFileService | null = null;
  private serverUrl: string;
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
  ) {
    super();
    this.serverUrl = serverUrl;
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

    // Copy paste code to clipboard by default
    const pasteCode = buildPasteCode(this.sessionId, this.inviteSecret);
    await vscode.env.clipboard.writeText(pasteCode);

    vscode.window
      .showInformationMessage(Strings.sessionStarted, Strings.copyLink, Strings.copyCode, Strings.showParticipants)
      .then((action) => {
        if (action === Strings.copyLink) {
          const deepLink = buildDeepLink(this.sessionId, this.inviteSecret);
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
      if (p) {
        p.status = 'idle';
        this._onDidChangeParticipants.fire(this.getParticipants());
        vscode.window.setStatusBarMessage(`CoLive: ${p.displayName} left the session`, 4000);
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
    const pasteCode = buildPasteCode(this.sessionId, this.inviteSecret);
    await vscode.env.clipboard.writeText(pasteCode);
    vscode.window.showInformationMessage('CoLive: Invite code copied to clipboard.');
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
    if (this.fileService) {
      this.fileService.dispose();
      this.fileService = null;
    }
    super.dispose();
  }
}
