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

let activeSession: SessionController | null = null;
let statusBar: StatusBarManager | null = null;
let participantsTree: ParticipantsTreeProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  Logger.initialize();
  Logger.info('CoLive extension activating...');

  statusBar = new StatusBarManager();
  participantsTree = new ParticipantsTreeProvider();

  context.subscriptions.push(statusBar);
  context.subscriptions.push(participantsTree);

  // Register Tree View
  const treeView = vscode.window.createTreeView('colive.participants', {
    treeDataProvider: participantsTree,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Register URI handler for deep links: vscode://colive-team.colive/join?...
  const uriHandler: vscode.UriHandler = {
    handleUri(uri: vscode.Uri) {
      if (uri.path === '/join') {
        const query = new URLSearchParams(uri.query);
        const sessionId = query.get('session');
        const secret = query.get('secret') || uri.fragment;

        if (sessionId && secret) {
          vscode.window
            .showInformationMessage(
              `Do you want to join CoLive session "${sessionId}"?`,
              { modal: true },
              'Join Session',
            )
            .then((action) => {
              if (action === 'Join Session') {
                joinSessionByIdAndSecret(sessionId, secret);
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

  Logger.info('CoLive extension activated successfully.');
}

async function startHostSession(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(Strings.noOpenFolder);
    return;
  }

  if (activeSession && activeSession.getState() === 'active') {
    vscode.window.showWarningMessage('A CoLive session is already active. Please end it before starting a new one.');
    return;
  }

  const config = getExtensionConfig();
  const displayName = await resolveDisplayName();

  try {
    const hostSession = new HostSession(config.serverUrl, displayName, config.requireJoinApproval);
    activeSession = hostSession;
    statusBar?.setSession(hostSession);
    participantsTree?.setSession(hostSession);

    await hostSession.start();
  } catch (err) {
    Logger.error('Failed to start host session', err);
    vscode.window.showErrorMessage(`Failed to start CoLive session: ${err instanceof Error ? err.message : String(err)}`);
    activeSession = null;
    statusBar?.setSession(null);
    participantsTree?.setSession(null);
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

  await joinSessionByIdAndSecret(parsed.sessionId, parsed.secret);
}

async function joinSessionByIdAndSecret(sessionId: string, secret: string): Promise<void> {
  const config = getExtensionConfig();
  const displayName = await resolveDisplayName();

  try {
    const guestSession = new GuestSession(config.serverUrl, sessionId, secret, displayName);
    activeSession = guestSession;
    statusBar?.setSession(guestSession);
    participantsTree?.setSession(guestSession);

    await guestSession.join();
  } catch (err) {
    Logger.error('Failed to join session', err);
    vscode.window.showErrorMessage(`Failed to join CoLive session: ${err instanceof Error ? err.message : String(err)}`);
    activeSession = null;
    statusBar?.setSession(null);
    participantsTree?.setSession(null);
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
    statusBar?.setSession(null);
    participantsTree?.setSession(null);
    vscode.window.showInformationMessage(Strings.sessionEnded);
  }
}

export function deactivate(): void {
  Logger.info('CoLive extension deactivating...');
  if (activeSession) {
    activeSession.endSession();
    activeSession = null;
  }
  statusBar?.dispose();
  participantsTree?.dispose();
  Logger.dispose();
}
