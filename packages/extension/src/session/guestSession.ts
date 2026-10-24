import * as vscode from 'vscode';
import {
  ColiveMessage,
  GuestJoin,
  ParticipantInfo,
  Permission,
  PROTOCOL_VERSION,
  ServerJoinAccepted,
  ServerJoinRejected,
  WorkspaceInfoRes,
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
import os from 'node:os';
import fs from 'node:fs';
import { GuestDiagnosticsReceiver } from '../diagnostics/diagnosticsService.js';
import { GuestTerminalService } from '../terminal/index.js';
import { GuestLspClient } from '../guest/lspClient.js';
import { GuestDebugClient } from '../guest/debugClient.js';
import { CoLiveImageEditorProvider } from '../guest/imagePreview.js';
import { extensionContext } from '../extension.js';
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
  public lspClient: GuestLspClient | null = null;
  public debugClient: GuestDebugClient | null = null;
  public onJoinAccepted?: (guestToken: string) => void;
  public isReloading = false;
  private previousTerminalCwd?: string;
  private fsRegistration: vscode.Disposable | null = null;
  private debugTreeRegistration: vscode.Disposable | null = null;
  private imageEditorRegistration: vscode.Disposable | null = null;
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
      } else if (connState === 'disconnected') {
        this.setState('ended', 'Disconnected from server');
        this.dispose();
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

          // Notify listener (e.g. extension persistence) before mounting workspace folder
          this.onJoinAccepted?.(this.guestToken);

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

            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
              // Transitioning from empty window to workspace triggers window reload in VS Code
              this.isReloading = true;
            }

            const existingColiveIdx = folders
              ? folders.findIndex((f) => f.uri.scheme === CoLiveFileSystemProvider.SCHEME)
              : -1;

            if (existingColiveIdx >= 0) {
              vscode.workspace.updateWorkspaceFolders(existingColiveIdx, 1, { uri: rootUri, name: folderName });
            } else {
              const insertAt = folders ? folders.length : 0;
              vscode.workspace.updateWorkspaceFolders(insertAt, 0, { uri: rootUri, name: folderName });
            }

            // Prevent VS Code integrated terminal from failing with "cwd does not exist" on virtual workspace schemes
            const termConfig = vscode.workspace.getConfiguration('terminal.integrated');
            const inspect = termConfig.inspect<string>('cwd');
            this.previousTerminalCwd = inspect?.globalValue;
            if (!this.previousTerminalCwd || !fs.existsSync(this.previousTerminalCwd)) {
              await termConfig.update('cwd', os.homedir(), vscode.ConfigurationTarget.Global);
            }
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

          // Initialize Phase 2: LSP Client, Debug Client, and Image Preview Provider
          this.lspClient = new GuestLspClient(folderName, this.connection!);
          this.debugClient = new GuestDebugClient(folderName, this.connection!);
          this.debugTreeRegistration = vscode.window.registerTreeDataProvider('colive.debug', this.debugClient);
          if (extensionContext) {
            this.imageEditorRegistration = vscode.window.registerCustomEditorProvider(
              CoLiveImageEditorProvider.viewType,
              new CoLiveImageEditorProvider(extensionContext, this.fsProvider!),
            );
          }

          this.setState('active');
          this._onDidChangeParticipants.fire(this.getParticipants());
          vscode.window.showInformationMessage(Strings.joinApproved);
          void this.handleGitignoredFilesPrompt();
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

    if (this.imageEditorRegistration) {
      try {
        this.imageEditorRegistration.dispose();
      } catch (err) {
        Logger.warn('Error disposing imageEditorRegistration', { err });
      }
      this.imageEditorRegistration = null;
    }
    if (this.debugTreeRegistration) {
      try {
        this.debugTreeRegistration.dispose();
      } catch (err) {
        Logger.warn('Error disposing debugTreeRegistration', { err });
      }
      this.debugTreeRegistration = null;
    }
    if (this.debugClient) {
      try {
        this.debugClient.dispose();
      } catch (err) {
        Logger.warn('Error disposing debugClient', { err });
      }
      this.debugClient = null;
    }
    if (this.lspClient) {
      try {
        this.lspClient.dispose();
      } catch (err) {
        Logger.warn('Error disposing lspClient', { err });
      }
      this.lspClient = null;
    }

    if (this.syncManager) {
      try {
        this.syncManager.dispose();
      } catch (err) {
        Logger.warn('Error disposing syncManager', { err });
      }
      this.syncManager = null;
    }

    if (vscode.workspace.workspaceFolders && !this.isReloading) {
      for (let i = vscode.workspace.workspaceFolders.length - 1; i >= 0; i--) {
        const folder = vscode.workspace.workspaceFolders[i];
        if (folder.uri.scheme === 'colive' || (this.mountedFolderUri && folder.uri.toString() === this.mountedFolderUri.toString())) {
          vscode.workspace.updateWorkspaceFolders(i, 1);
        }
      }
      this.mountedFolderUri = null;
    }

    if (!this.isReloading) {
      try {
        const termConfig = vscode.workspace.getConfiguration('terminal.integrated');
        termConfig.update('cwd', this.previousTerminalCwd ?? undefined, vscode.ConfigurationTarget.Global);
      } catch (termErr) {
        Logger.warn('Error restoring terminal cwd', { termErr });
      }
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

  public toggleGitIgnoredFiles(): boolean {
    if (!this.fsProvider) return false;
    const next = !this.fsProvider.getIncludeGitIgnored();
    this.fsProvider.setIncludeGitIgnored(next);
    vscode.window.showInformationMessage(
      next
        ? 'CoLive: Showing gitignored files (loaded last).'
        : 'CoLive: Hiding gitignored files.',
    );
    return next;
  }

  public getIncludeGitIgnored(): boolean {
    return this.fsProvider ? this.fsProvider.getIncludeGitIgnored() : false;
  }

  public setIncludeGitIgnored(include: boolean): void {
    this.fsProvider?.setIncludeGitIgnored(include);
  }

  private async handleGitignoredFilesPrompt(): Promise<void> {
    if (!this.connection || !this.fsProvider) return;
    try {
      const config = vscode.workspace.getConfiguration('colive');
      const setting = config.get<string>('loadGitIgnoredFiles', 'prompt');

      if (setting === 'always') {
        this.fsProvider.setIncludeGitIgnored(true);
        return;
      }
      if (setting === 'never') {
        this.fsProvider.setIncludeGitIgnored(false);
        return;
      }

      // Check if the host workspace actually contains gitignore rules
      try {
        const info = await this.connection.request<WorkspaceInfoRes>(
          {
            v: PROTOCOL_VERSION,
            type: 'workspace.info.req',
          },
          5000,
        );
        if (info && info.hasGitignore === false) {
          // No gitignore in workspace, keep default
          return;
        }
      } catch {
        // Fallback: proceed to prompt if request fails
      }

      const choice = await vscode.window.showInformationMessage(
        'Do you want to load gitignored files in this workspace?',
        'No, Skip Gitignored',
        'Yes, Load All (Gitignored Last)',
      );

      if (choice === 'Yes, Load All (Gitignored Last)') {
        this.fsProvider.setIncludeGitIgnored(true);
        vscode.window.setStatusBarMessage('CoLive: Loading all files (gitignored files loaded last)', 4000);
      } else {
        this.fsProvider.setIncludeGitIgnored(false);
      }
    } catch (err) {
      Logger.warn('Error during gitignore prompt', { err });
    }
  }
}
