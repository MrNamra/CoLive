import * as vscode from 'vscode';
import { getExtensionConfig, resolveDisplayName } from './config.js';
import { parseInviteInput } from './invite.js';
import { Logger } from './logger.js';
import { GuestSession } from './session/guestSession.js';
import { HostSession } from './session/hostSession.js';
import { SessionController } from './session/sessionController.js';
import { Strings } from './strings.js';
import { ParticipantsTreeProvider, ParticipantTreeItem } from './ui/participantsTree.js';
import { StatusBarManager } from './ui/statusBar.js';
import { ChatViewProvider } from './chat/chatViewProvider.js';
import { CommentsTreeProvider } from './comments/commentsTree.js';
import { TunnelManager } from './tunnel/TunnelManager.js';

let activeSession: SessionController | null = null;
let statusBar: StatusBarManager | null = null;
let participantsTree: ParticipantsTreeProvider | null = null;
let commentsTree: CommentsTreeProvider | null = null;
let chatProvider: ChatViewProvider | null = null;
let tunnelManager: TunnelManager | null = null;

export function activate(context: vscode.ExtensionContext): void {
  Logger.initialize();
  Logger.info('CoLive extension activating...');

  tunnelManager = new TunnelManager();
  statusBar = new StatusBarManager();
  participantsTree = new ParticipantsTreeProvider();
  commentsTree = new CommentsTreeProvider();
  chatProvider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(tunnelManager);

  context.subscriptions.push(statusBar);
  context.subscriptions.push(participantsTree);
  context.subscriptions.push(commentsTree);
  context.subscriptions.push(chatProvider);

  // Register Tree Views
  const treeView = vscode.window.createTreeView('colive.participants', {
    treeDataProvider: participantsTree,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const commentsTreeView = vscode.window.createTreeView('colive.comments', {
    treeDataProvider: commentsTree,
    showCollapseAll: true,
  });
  context.subscriptions.push(commentsTreeView);

  // Register Chat Webview View Provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),
  );

  // Register URI handler for deep links: vscode://colive-team.colive/join?...
  const uriHandler: vscode.UriHandler = {
    handleUri(uri: vscode.Uri) {
      if (uri.path === '/join') {
        const query = new URLSearchParams(uri.query);
        const sessionId = query.get('session');
        const secret = query.get('secret') || uri.fragment;
        const serverUrl = query.get('server') || undefined;

        if (sessionId && secret) {
          vscode.window
            .showInformationMessage(
              `Do you want to join CoLive session "${sessionId}"?`,
              { modal: true },
              'Join Session',
            )
            .then((action) => {
              if (action === 'Join Session') {
                joinSessionByIdAndSecret(sessionId, secret, serverUrl);
              }
            });
        }
      }
    },
  };
  context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('colive.hello', () => {
      vscode.window.showInformationMessage(Strings.helloMessage);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.statusBarClicked', () => {
      statusBar?.handleClick();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.startSession', async () => {
      await startHostSession();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.joinSession', async () => {
      await promptJoinSession();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.endSession', async () => {
      await endCurrentSession();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.copyInvite', async () => {
      if (activeSession) {
        await activeSession.copyInvite();
      } else {
        vscode.window.showInformationMessage('No active CoLive session.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.setParticipantPermission', async (item?: ParticipantTreeItem) => {
      if (!(activeSession instanceof HostSession)) {
        vscode.window.showErrorMessage('Only the host can change participant permissions.');
        return;
      }

      const guestId = item?.participant.id;
      if (!guestId || item?.participant.role === 'host') {
        return;
      }

      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Read & write', value: 'readWrite' as const },
          { label: 'Read-only', value: 'readOnly' as const },
        ],
        { placeHolder: `Set permission for ${item.participant.displayName}` },
      );

      if (choice) {
        await activeSession.setParticipantPermission(guestId, choice.value);
        vscode.window.showInformationMessage(`Permission for ${item.participant.displayName} set to ${choice.label}.`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.kickParticipant', async (item?: ParticipantTreeItem) => {
      if (!(activeSession instanceof HostSession)) {
        vscode.window.showErrorMessage('Only the host can remove participants.');
        return;
      }

      const guestId = item?.participant.id;
      if (!guestId || item?.participant.role === 'host') {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Remove "${item.participant.displayName}" from the session?`,
        { modal: true },
        'Remove',
      );

      if (confirm === 'Remove') {
        await activeSession.kickParticipant(guestId);
        vscode.window.showInformationMessage(`Removed ${item.participant.displayName} from session.`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.followParticipant', async (item?: ParticipantTreeItem) => {
      let targetId = item?.participant.id;
      let targetName = item?.participant.displayName;
      if (!targetId && activeSession) {
        const participants = activeSession.getParticipants().filter((p) => p.status === 'active');
        if (participants.length === 0) return;
        const choice = await vscode.window.showQuickPick(
          participants.map((p) => ({ label: p.displayName, description: p.role, participant: p })),
          { placeHolder: 'Select a participant to follow' },
        );
        if (choice) {
          targetId = choice.participant.id;
          targetName = choice.participant.displayName;
        }
      }
      if (!targetId || !targetName) return;

      if (activeSession instanceof HostSession && activeSession.followController) {
        activeSession.followController.followParticipant(targetId, targetName);
      } else if (activeSession instanceof GuestSession && activeSession.followController) {
        activeSession.followController.followParticipant(targetId, targetName);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.stopFollowing', () => {
      if (activeSession instanceof HostSession && activeSession.followController) {
        activeSession.followController.stopFollowing();
      } else if (activeSession instanceof GuestSession && activeSession.followController) {
        activeSession.followController.stopFollowing();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.exportComments', async () => {
      let manager = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager) {
        vscode.window.showInformationMessage('No active comments session.');
        return;
      }
      const data = manager.exportComments();
      const doc = await vscode.workspace.openTextDocument({ content: data, language: 'json' });
      await vscode.window.showTextDocument(doc);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.importComments', async () => {
      let manager = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager) {
        vscode.window.showInformationMessage('No active comments session.');
        return;
      }
      const input = await vscode.window.showInputBox({
        prompt: 'Paste JSON comments export string',
      });
      if (input) {
        const count = manager.importComments(input);
        vscode.window.showInformationMessage(`Imported ${count} comment thread(s).`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.openCommentThread', async (threadData: any) => {
      if (!threadData || !threadData.path) return;
      let targetUri: vscode.Uri;
      if (activeSession instanceof HostSession) {
        targetUri = vscode.Uri.file(`${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}/${threadData.path}`);
      } else {
        targetUri = vscode.Uri.parse(`colive:/Shared/${threadData.path}`);
      }
      try {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(threadData.range.startLine, threadData.range.startChar);
        editor.revealRange(new vscode.Range(pos, pos));
      } catch (err) {
        Logger.warn('Failed to open comment thread file', { err, path: threadData.path });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.showWalkthrough', async () => {
      await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'colive-team.colive#colive.welcome', false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.showSessionInfo', async () => {
      if (!activeSession || activeSession.getState() !== 'active') {
        vscode.window.showInformationMessage('No active CoLive session.');
        return;
      }

      const isHost = activeSession instanceof HostSession;
      const role = isHost ? 'Host' : 'Guest';
      const participants = activeSession.getParticipants();
      const pNames = participants.map((p) => `${p.displayName} (${p.role}, ${p.permission})`).join('\n • ');

      const infoText = `CoLive Session Info:\n\n` +
        `• Role: ${role}\n` +
        `• Status: ${activeSession.getState()}\n` +
        `• Active Participants (${participants.length}):\n • ${pNames}\n`;

      await vscode.window.showInformationMessage(infoText, { modal: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.copyLineLink', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const line = editor.selection.active.line + 1;
      const docPath = editor.document.uri.fsPath || editor.document.uri.path;
      const linkText = `${docPath}:${line}`;

      await vscode.env.clipboard.writeText(linkText);
      vscode.window.setStatusBarMessage(`CoLive: Copied link to line ${line}`, 3000);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.shareTerminal', async () => {
      if (!activeSession || activeSession.getState() !== 'active') {
        vscode.window.showInformationMessage('You must be in an active CoLive session to use shared terminal.');
        return;
      }

      if (activeSession instanceof HostSession && activeSession.terminalService) {
        activeSession.terminalService.shareTerminal();
        vscode.window.showInformationMessage('CoLive: Shared terminal started on host. Output is mirrored to guests.');
      } else if (activeSession instanceof GuestSession && activeSession.terminalService) {
        try {
          await activeSession.terminalService.openSharedTerminal();
        } catch (err: unknown) {
          vscode.window.showErrorMessage(`Failed to open shared terminal: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.toggleTerminalWrite', async () => {
      if (!(activeSession instanceof HostSession) || !activeSession.terminalService) {
        vscode.window.showInformationMessage('Only the host can toggle terminal write permissions.');
        return;
      }

      const activeTerms = activeSession.terminalService.getActiveTerminals();
      if (activeTerms.length === 0) {
        vscode.window.showInformationMessage('No active shared terminals found.');
        return;
      }

      const term = activeTerms[0]!;
      const allowed = activeSession.terminalService.toggleGuestWrite(term.terminalId);
      vscode.window.showInformationMessage(
        `CoLive: Guests ${allowed ? 'can now type in' : 'are now read-only in'} the shared terminal.`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.setTunnelUrl', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter Cloudflare Tunnel URL (e.g. https://xxx.trycloudflare.com or wss://xxx.trycloudflare.com/ws)',
        placeHolder: 'https://xxxx.trycloudflare.com',
      });
      if (!input || !input.trim()) return;

      let wsUrl = input.trim();
      if (wsUrl.startsWith('https://')) {
        wsUrl = wsUrl.replace('https://', 'wss://');
      } else if (wsUrl.startsWith('http://')) {
        wsUrl = wsUrl.replace('http://', 'ws://');
      }
      if (!wsUrl.endsWith('/ws')) {
        wsUrl = wsUrl.replace(/\/+$/, '') + '/ws';
      }

      await vscode.workspace.getConfiguration('colive').update('serverUrl', wsUrl, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`CoLive: Worldwide Cloudflare server URL configured to: ${wsUrl}`);
    }),
  );

  Logger.info('CoLive extension activated successfully.');
}

async function startHostSession(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    const action = await vscode.window.showErrorMessage(
      Strings.noOpenFolder,
      'Open Folder',
    );
    if (action === 'Open Folder') {
      await vscode.commands.executeCommand('vscode.openFolder');
    }
    return;
  }

  if (activeSession && activeSession.getState() === 'active') {
    vscode.window.showWarningMessage('A CoLive session is already active. Please end it before starting a new one.');
    return;
  }

  const config = getExtensionConfig();
  let hostLocalServerUrl = config.serverUrl;
  let publicServerUrl: string | undefined = undefined;

  // Auto-run Cloudflare Tunnel for worldwide collaboration if configured to localhost and cloudflared is installed
  if (
    (hostLocalServerUrl === 'ws://localhost:8787/ws' || hostLocalServerUrl.includes('127.0.0.1')) &&
    tunnelManager &&
    (await tunnelManager.isCloudflaredAvailable())
  ) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CoLive: Establishing Worldwide Cloudflare Tunnel...',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Starting relay & Cloudflare tunnel...' });
        try {
          publicServerUrl = await tunnelManager!.startTunnel(8787);
          progress.report({ message: 'Connected to Cloudflare worldwide edge!' });
        } catch (err) {
          Logger.warn('Failed to auto-start Cloudflare tunnel, falling back to local relay', err);
          vscode.window.showWarningMessage(
            'Could not auto-start Cloudflare tunnel; falling back to local relay server.',
          );
        }
      },
    );
  }

  // If Cloudflare tunnel is active, host connects locally to 127.0.0.1:8787 to avoid
  // internet round-trip and Cloudflare 530 DNS propagation delay, while guests connect via tunnel
  if (publicServerUrl) {
    hostLocalServerUrl = 'ws://127.0.0.1:8787/ws';
  }

  const displayName = await resolveDisplayName();

  try {
    const rootPath = folders[0]!.uri.fsPath;
    const hostSession = new HostSession(
      hostLocalServerUrl,
      displayName,
      rootPath,
      config.excludePatterns,
      config.maxFileSizeMB,
      config.requireJoinApproval,
      publicServerUrl,
    );
    activeSession = hostSession;
    statusBar?.setSession(hostSession);
    participantsTree?.setSession(hostSession);

    await hostSession.start();
    participantsTree?.setSession(hostSession, hostSession.presenceManager, hostSession.followController);
    commentsTree?.setCommentsManager(hostSession.commentsManager);
    chatProvider?.setSession(hostSession.connection, 'host', displayName);
  } catch (err) {
    Logger.error('Failed to start host session', err);
    vscode.window.showErrorMessage(`Failed to start CoLive session: ${err instanceof Error ? err.message : String(err)}`);
    activeSession = null;
    statusBar?.setSession(null);
    participantsTree?.setSession(null);
    commentsTree?.setCommentsManager(null);
    chatProvider?.setSession(null, '', '');
  }
}

async function promptJoinSession(): Promise<void> {
  if (activeSession && activeSession.getState() === 'active') {
    vscode.window.showWarningMessage('A CoLive session is already active. Please end it before joining another.');
    return;
  }

  const input = await vscode.window.showInputBox({
    prompt: 'Paste CoLive invite link or code (e.g. "a1b2c3d4e5.Xy7Z...")',
    placeHolder: 'sessionId.secret or vscode://colive-team.colive/join?...',
    ignoreFocusOut: true,
  });

  if (!input) return;

  const parsed = parseInviteInput(input);
  if (!parsed) {
    vscode.window.showErrorMessage('Invalid CoLive invite code or link.');
    return;
  }

  await joinSessionByIdAndSecret(parsed.sessionId, parsed.secret, parsed.serverUrl);
}

async function joinSessionByIdAndSecret(
  sessionId: string,
  secret: string,
  serverUrl?: string,
): Promise<void> {
  const config = getExtensionConfig();
  const targetServerUrl = serverUrl || config.serverUrl;
  const displayName = await resolveDisplayName();

  try {
    const guestSession = new GuestSession(targetServerUrl, sessionId, secret, displayName);
    activeSession = guestSession;
    statusBar?.setSession(guestSession);
    participantsTree?.setSession(guestSession);

    await guestSession.join();
    participantsTree?.setSession(guestSession, guestSession.presenceManager, guestSession.followController);
    commentsTree?.setCommentsManager(guestSession.commentsManager);
    chatProvider?.setSession(guestSession.connection, guestSession.guestId, displayName);
  } catch (err) {
    Logger.error('Failed to join session', err);
    vscode.window.showErrorMessage(`Failed to join CoLive session (${targetServerUrl}): ${err instanceof Error ? err.message : String(err)}`);
    activeSession = null;
    statusBar?.setSession(null);
    participantsTree?.setSession(null);
    commentsTree?.setCommentsManager(null);
    chatProvider?.setSession(null, '', '');
  }
}

async function endCurrentSession(): Promise<void> {
  if (!activeSession || activeSession.getState() !== 'active') {
    return;
  }

  const isHost = activeSession instanceof HostSession;
  const message = isHost ? Strings.confirmEndSession : Strings.confirmLeaveSession;
  const button = isHost ? Strings.endSessionButton : Strings.leaveSessionButton;

  const choice = await vscode.window.showWarningMessage(message, { modal: true }, button);
  if (choice === button) {
    await activeSession.endSession();
    activeSession = null;
    tunnelManager?.stopTunnel();
    statusBar?.setSession(null);
    participantsTree?.setSession(null);
    commentsTree?.setCommentsManager(null);
    chatProvider?.setSession(null, '', '');
    vscode.window.showInformationMessage(Strings.sessionEnded);
  }
}

export function deactivate(): void {
  Logger.info('CoLive extension deactivating...');
  if (activeSession) {
    activeSession.endSession();
    activeSession = null;
  }
  tunnelManager?.stopTunnel();
  statusBar?.dispose();
  participantsTree?.dispose();
  commentsTree?.dispose();
  chatProvider?.dispose();
  Logger.dispose();
}
