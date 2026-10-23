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
import { generateInitialsAvatarSvg } from './comments/commentValidator.js';
import { TunnelManager } from './tunnel/TunnelManager.js';
import {
  getOsInstallCommand,
  promptOrInstallDependencies,
  formatFriendlyErrorMessage,
} from './dependencies.js';

let activeSession: SessionController | null = null;
let statusBar: StatusBarManager | null = null;
let participantsTree: ParticipantsTreeProvider | null = null;
let commentsTree: CommentsTreeProvider | null = null;
let chatProvider: ChatViewProvider | null = null;
let tunnelManager: TunnelManager | null = null;
export let extensionContext: vscode.ExtensionContext | null = null;

export interface PersistedGuestSession {
  sessionId: string;
  secret: string;
  serverUrl?: string;
  guestToken: string;
  displayName: string;
  savedAt: number;
}

export function cleanupColiveWorkspaceFolders(): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;
  for (let i = folders.length - 1; i >= 0; i--) {
    if (folders[i].uri.scheme === 'colive') {
      vscode.workspace.updateWorkspaceFolders(i, 1);
    }
  }
}

export function updateSessionContext(session: SessionController | null): void {
  const inSession = session !== null && session.getState() === 'active';
  const isGuest = session instanceof GuestSession;
  const isHost = session instanceof HostSession;
  vscode.commands.executeCommand('setContext', 'colive.inSession', inSession);
  vscode.commands.executeCommand('setContext', 'colive.isGuest', inSession && isGuest);
  vscode.commands.executeCommand('setContext', 'colive.isHost', inSession && isHost);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  Logger.initialize();
  Logger.info('CoLive extension activating...');

  const persisted = context.globalState.get<PersistedGuestSession>('colive.persistedGuestSession');
  if (persisted && Date.now() - persisted.savedAt < 60000) {
    Logger.info(`Restoring guest session after workspace transition (Session ID: ${persisted.sessionId})...`);
    context.globalState.update('colive.persistedGuestSession', undefined);
    setTimeout(() => {
      joinSessionByIdAndSecret(persisted.sessionId, persisted.secret, persisted.serverUrl, persisted.guestToken);
    }, 150);
  } else {
    context.globalState.update('colive.persistedGuestSession', undefined);
    // Prune any lingering virtual workspace folders from previous closed sessions
    cleanupColiveWorkspaceFolders();
  }
  updateSessionContext(null);

  tunnelManager = new TunnelManager(context.globalStorageUri.fsPath);
  statusBar = new StatusBarManager();
  participantsTree = new ParticipantsTreeProvider();
  commentsTree = new CommentsTreeProvider();
  chatProvider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(tunnelManager);
  context.subscriptions.push(
    vscode.commands.registerCommand('colive.showLogs', () => {
      Logger.show();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('colive.installDependencies', async () => {
      if (tunnelManager) {
        await promptOrInstallDependencies(tunnelManager, true);
      }
    }),
  );

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
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  // Register URI handler for deep links: vscode://colive-team.colive/join?...
  const uriHandler: vscode.UriHandler = {
    handleUri(uri: vscode.Uri) {
      if (uri.path === '/join') {
        const parsed = parseInviteInput(uri.toString());
        if (parsed) {
          vscode.window
            .showInformationMessage(
              `Do you want to join CoLive session "${parsed.sessionId}"?`,
              { modal: true },
              'Join Session',
            )
            .then((action) => {
              if (action === 'Join Session') {
                joinSessionByIdAndSecret(parsed.sessionId, parsed.secret, parsed.serverUrl);
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
    vscode.commands.registerCommand('colive.previewImage', async (uri?: vscode.Uri) => {
      const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        vscode.window.showInformationMessage(Strings.noImageSelected);
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', targetUri, 'colive.imagePreview');
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
    vscode.commands.registerCommand('colive.setParticipantPermission', async (item?: ParticipantTreeItem | string) => {
      if (!(activeSession instanceof HostSession)) {
        vscode.window.showErrorMessage('Only the host can change participant permissions.');
        return;
      }

      let guestId: string | undefined;
      let guestName: string | undefined;

      if (typeof item === 'string') {
        guestId = item;
        const p = activeSession.getParticipants().find((x) => x.id === item);
        if (p?.role === 'host') return;
        guestName = p?.displayName;
      } else if (item && typeof item === 'object' && 'participant' in item && item.participant) {
        if (item.participant.role === 'host') return;
        guestId = item.participant.id;
        guestName = item.participant.displayName;
      }

      if (!guestId) {
        const guests = activeSession.getParticipants().filter((p) => p.role !== 'host');
        if (guests.length === 0) {
          vscode.window.showInformationMessage('No guests in the session.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          guests.map((g) => ({ label: g.displayName, participant: g })),
          { placeHolder: 'Select a participant to change permission' },
        );
        if (!picked) return;
        guestId = picked.participant.id;
        guestName = picked.participant.displayName;
      }

      const displayName = guestName || guestId;
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Read & write', description: 'Can view and edit workspace files', value: 'readWrite' as const },
          { label: 'Terminal access', description: 'Can edit files and execute in shared terminal', value: 'terminalAccess' as const },
          { label: 'Read-only', description: 'Can only view files and follow host', value: 'readOnly' as const },
        ],
        { placeHolder: `Set permission for ${displayName}` },
      );

      if (choice) {
        await activeSession.setParticipantPermission(guestId, choice.value);
        vscode.window.showInformationMessage(`Permission for ${displayName} set to ${choice.label}.`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.kickParticipant', async (item?: ParticipantTreeItem | string) => {
      if (!(activeSession instanceof HostSession)) {
        vscode.window.showErrorMessage('Only the host can remove participants.');
        return;
      }

      let guestId: string | undefined;
      let guestName: string | undefined;

      if (typeof item === 'string') {
        guestId = item;
        const p = activeSession.getParticipants().find((x) => x.id === item);
        if (p?.role === 'host') return;
        guestName = p?.displayName;
      } else if (item && typeof item === 'object' && 'participant' in item && item.participant) {
        if (item.participant.role === 'host') return;
        guestId = item.participant.id;
        guestName = item.participant.displayName;
      }

      if (!guestId) {
        const guests = activeSession.getParticipants().filter((p) => p.role !== 'host');
        if (guests.length === 0) {
          vscode.window.showInformationMessage('No guests in the session.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          guests.map((g) => ({ label: g.displayName, participant: g })),
          { placeHolder: 'Select a participant to remove' },
        );
        if (!picked) return;
        guestId = picked.participant.id;
        guestName = picked.participant.displayName;
      }

      const displayName = guestName || guestId;
      const confirm = await vscode.window.showWarningMessage(
        `Remove "${displayName}" from the session?`,
        { modal: true },
        'Remove',
      );

      if (confirm === 'Remove') {
        await activeSession.kickParticipant(guestId);
        vscode.window.showInformationMessage(`Removed ${displayName} from session.`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.followParticipant', async (item?: ParticipantTreeItem | string, nameArg?: string) => {
      let targetId: string | undefined;
      let targetName: string | undefined;

      if (typeof item === 'string') {
        targetId = item;
        targetName = nameArg || activeSession?.getParticipants().find((p) => p.id === item)?.displayName;
      } else if (item && typeof item === 'object' && 'participant' in item && item.participant) {
        targetId = item.participant.id;
        targetName = item.participant.displayName;
      }

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
    vscode.commands.registerCommand('colive.clearChat', () => {
      chatProvider?.clearChatLocally();
      vscode.window.showInformationMessage('CoLive chat history cleared locally.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.createComment', async (reply?: vscode.CommentReply) => {
      let manager: CommentsManager | null = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager) return;

      if (!reply || !reply.thread) return;

      const thread = reply.thread;
      const text = (reply.text || '').trim();
      if (!text) return;

      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const relPath = manager.getNormalizedPath(doc);
      if (!relPath) return;

      const existingThreadId = manager.getThreadIdByVsThread(thread);
      const commentId = `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const vsComment: vscode.Comment = {
        author: {
          name: manager.getUserName(),
          iconPath: vscode.Uri.parse(generateInitialsAvatarSvg(manager.getUserName(), manager.getUserColor())),
        },
        body: new vscode.MarkdownString(text, false),
        mode: vscode.CommentMode.Preview,
        contextValue: 'canDelete',
      };
      (vsComment as any).commentId = commentId;

      if (existingThreadId) {
        (vsComment as any).threadId = existingThreadId;
        // Thread already exists, this is a reply
        thread.comments = [...thread.comments, vsComment];
        await manager.dispatchOp({
          v: 1,
          type: 'comment.op',
          op: 'reply',
          threadId: existingThreadId,
          commentId,
          body: text,
          authorId: manager.getUserId(),
          authorName: manager.getUserName(),
        });
      } else {
        // New thread: populate comments so VS Code retains it when collapsed/minimized
        const newThreadId = `th_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        (thread as any).threadId = newThreadId;
        (vsComment as any).threadId = newThreadId;
        thread.comments = [vsComment];
        thread.canReply = true;
        thread.contextValue = 'unresolved';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        manager.registerActiveThread(newThreadId, thread);

        await manager.dispatchOp({
          v: 1,
          type: 'comment.op',
          op: 'create',
          threadId: newThreadId,
          commentId,
          path: relPath,
          range: {
            startLine: thread.range.start.line,
            startChar: thread.range.start.character,
            endLine: thread.range.end.line,
            endChar: thread.range.end.character,
          },
          body: text,
          authorId: manager.getUserId(),
          authorName: manager.getUserName(),
        });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.replyComment', async (reply?: vscode.CommentReply) => {
      let manager: CommentsManager | null = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager) return;

      if (!reply || !reply.thread) return;

      const thread = reply.thread;
      const text = (reply.text || '').trim();
      if (!text) return;

      const threadId = manager.getThreadIdByVsThread(thread);
      if (!threadId) return;

      const commentId = `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const vsComment: vscode.Comment = {
        author: {
          name: manager.getUserName(),
          iconPath: vscode.Uri.parse(generateInitialsAvatarSvg(manager.getUserName(), manager.getUserColor())),
        },
        body: new vscode.MarkdownString(text, false),
        mode: vscode.CommentMode.Preview,
        contextValue: 'canDelete',
      };
      (vsComment as any).commentId = commentId;
      (vsComment as any).threadId = threadId;
      thread.comments = [...thread.comments, vsComment];

      await manager.dispatchOp({
        v: 1,
        type: 'comment.op',
        op: 'reply',
        threadId,
        commentId,
        body: text,
        authorId: manager.getUserId(),
        authorName: manager.getUserName(),
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.deleteComment', async (arg?: any) => {
      let manager: CommentsManager | null = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager || !arg) return;

      const comment: vscode.Comment | undefined = arg?.comment ? arg.comment : (arg?.body !== undefined ? arg : undefined);
      const thread: vscode.CommentThread | undefined = arg?.thread ? arg.thread : (arg?.comments !== undefined ? arg : undefined);

      let targetThreadId: string | undefined =
        (comment as any)?.threadId ||
        (thread ? manager.getThreadIdByVsThread(thread) : undefined);
      let targetCommentId: string | undefined = (comment as any)?.commentId;

      // Fallback matching if not tagged
      if (!targetThreadId || !targetCommentId) {
        const commentBodyStr = comment?.body
          ? typeof comment.body === 'string'
            ? comment.body
            : comment.body.value
          : undefined;

        for (const t of manager.getAllThreads()) {
          if (targetThreadId && t.id !== targetThreadId) continue;
          if (commentBodyStr) {
            const found = t.comments.find(
              (c) => c.body === commentBodyStr || c.body.trim() === commentBodyStr.trim(),
            );
            if (found) {
              targetThreadId = t.id;
              targetCommentId = found.id;
              break;
            }
          }
        }
      }

      if (!targetThreadId) {
        if (thread) {
          thread.dispose();
        }
        return;
      }

      if (targetCommentId) {
        await manager.dispatchOp({
          v: 1,
          type: 'comment.op',
          op: 'delete',
          threadId: targetThreadId,
          commentId: targetCommentId,
          authorId: manager.getUserId(),
          authorName: manager.getUserName(),
        });
      } else {
        await manager.dispatchOp({
          v: 1,
          type: 'comment.op',
          op: 'delete',
          threadId: targetThreadId,
          authorId: manager.getUserId(),
          authorName: manager.getUserName(),
        });
      }

      if (thread) {
        const remaining = thread.comments.filter((c) => (c as any).commentId !== targetCommentId);
        if (remaining.length === 0) {
          thread.dispose();
          manager.unregisterActiveThread(targetThreadId);
        } else {
          thread.comments = remaining;
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.deleteCommentThread', async (arg?: any) => {
      let manager: CommentsManager | null = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager || !arg) return;

      const thread: vscode.CommentThread | undefined = arg?.thread
        ? arg.thread
        : arg?.comments !== undefined
        ? arg
        : undefined;

      if (!thread) return;

      // If thread has no comments (draft thread), dispose immediately
      if (!thread.comments || thread.comments.length === 0) {
        const draftId = manager.getThreadIdByVsThread(thread);
        if (draftId) {
          manager.unregisterActiveThread(draftId);
        }
        thread.dispose();
        return;
      }

      const threadId = manager.getThreadIdByVsThread(thread);
      if (!threadId) {
        thread.dispose();
        return;
      }

      await manager.dispatchOp({
        v: 1,
        type: 'comment.op',
        op: 'delete',
        threadId,
        authorId: manager.getUserId(),
        authorName: manager.getUserName(),
      });

      thread.dispose();
      manager.unregisterActiveThread(threadId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.discardComment', async (replyOrThread?: any) => {
      let manager: CommentsManager | null = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager || !replyOrThread) return;

      const thread: vscode.CommentThread | undefined = replyOrThread?.thread
        ? replyOrThread.thread
        : replyOrThread?.comments !== undefined
        ? replyOrThread
        : undefined;

      if (!thread) return;

      const replyText = typeof replyOrThread.text === 'string' ? replyOrThread.text.trim() : '';

      // If draft thread with no comments, dispose immediately
      if (!thread.comments || thread.comments.length === 0) {
        const draftId = manager.getThreadIdByVsThread(thread);
        if (draftId) {
          manager.unregisterActiveThread(draftId);
        }
        thread.dispose();
        return;
      }

      const threadId = manager.getThreadIdByVsThread(thread);
      if (!replyText && threadId) {
        // Discard thread/comment when reply text is empty
        await manager.dispatchOp({
          v: 1,
          type: 'comment.op',
          op: 'delete',
          threadId,
          authorId: manager.getUserId(),
          authorName: manager.getUserName(),
        });
        thread.dispose();
        manager.unregisterActiveThread(threadId);
      } else if (!threadId) {
        thread.dispose();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.resolveCommentThread', async (thread?: vscode.CommentThread) => {
      let manager: CommentsManager | null = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager || !thread) return;

      const threadId = manager.getThreadIdByVsThread(thread);
      if (threadId) {
        thread.contextValue = 'resolved';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        await manager.dispatchOp({
          v: 1,
          type: 'comment.op',
          op: 'resolve',
          threadId,
          authorId: manager.getUserId(),
          authorName: manager.getUserName(),
        });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.unresolveCommentThread', async (thread?: vscode.CommentThread) => {
      let manager: CommentsManager | null = null;
      if (activeSession instanceof HostSession) manager = activeSession.commentsManager;
      if (activeSession instanceof GuestSession) manager = activeSession.commentsManager;
      if (!manager || !thread) return;

      const threadId = manager.getThreadIdByVsThread(thread);
      if (threadId) {
        thread.contextValue = 'unresolved';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        await manager.dispatchOp({
          v: 1,
          type: 'comment.op',
          op: 'unresolve',
          threadId,
          authorId: manager.getUserId(),
          authorName: manager.getUserName(),
        });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('colive.openCommentThread', async (threadData: any) => {
      if (!threadData || !threadData.path) return;
      let targetUri: vscode.Uri;
      if (activeSession instanceof HostSession) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        targetUri = root ? vscode.Uri.joinPath(root, threadData.path) : vscode.Uri.file(threadData.path);
      } else if (activeSession instanceof GuestSession && activeSession.mountedFolderUri) {
        targetUri = vscode.Uri.joinPath(activeSession.mountedFolderUri, threadData.path);
      } else {
        targetUri = vscode.Uri.parse(`colive:/Shared/${threadData.path}`);
      }
      try {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(threadData.range.startLine, threadData.range.startChar);
        editor.revealRange(new vscode.Range(pos, pos));
        const manager = activeSession instanceof HostSession ? activeSession.commentsManager : (activeSession instanceof GuestSession ? activeSession.commentsManager : null);
        if (manager) {
          manager.expandThread(threadData.id);
        }
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
    vscode.commands.registerCommand('colive.openSharedTerminal', async () => {
      if (!activeSession || activeSession.getState() !== 'active') {
        vscode.window.showInformationMessage('You must be in an active CoLive session to access the host terminal.');
        return;
      }

      if (activeSession instanceof GuestSession && activeSession.terminalService) {
        try {
          await activeSession.terminalService.openSharedTerminal();
        } catch (err: unknown) {
          vscode.window.showErrorMessage(`Failed to open shared terminal: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (activeSession instanceof HostSession && activeSession.terminalService) {
        activeSession.terminalService.shareTerminal();
        vscode.window.showInformationMessage('CoLive: Shared terminal started on host. Output is mirrored to guests.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('colive.hostTerminal', {
      async provideTerminalProfile(): Promise<vscode.TerminalProfile | undefined> {
        if (!activeSession || activeSession.getState() !== 'active') {
          vscode.window.showWarningMessage('You must be in an active CoLive session to access the host terminal.');
          return undefined;
        }

        if (activeSession instanceof GuestSession && activeSession.terminalService) {
          const { pty } = await activeSession.terminalService.createSharedPseudoterminal();
          return new vscode.TerminalProfile({
            name: 'CoLive: Host Terminal',
            pty,
            isTransient: true,
            iconPath: new vscode.ThemeIcon('broadcast'),
          });
        }

        return undefined;
      },
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

export function teardownActiveSessionUI(session?: SessionController | null): void {
  if (session && activeSession && activeSession !== session) return;
  const targetSession = session || activeSession;
  activeSession = null;
  updateSessionContext(null);
  cleanupColiveWorkspaceFolders();
  if (extensionContext) {
    extensionContext.globalState.update('colive.persistedGuestSession', undefined);
  }
  tunnelManager?.stopTunnel();
  statusBar?.setSession(null);
  participantsTree?.setSession(null);
  commentsTree?.setCommentsManager(null);
  chatProvider?.setSession(null, '', '');
  chatProvider?.clearChatLocally(false);

  if (targetSession instanceof HostSession || targetSession instanceof GuestSession) {
    if (targetSession.commentsManager) {
      targetSession.commentsManager.dispose();
      targetSession.commentsManager = null;
    }
  }
}

async function startHostSession(): Promise<void> {
  Logger.show(true);
  Logger.info('--- Starting CoLive Host Session ---');

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

  const isLocalOrTryCloudflare =
    hostLocalServerUrl === 'ws://localhost:8787/ws' ||
    hostLocalServerUrl.includes('127.0.0.1') ||
    hostLocalServerUrl.includes('trycloudflare.com');

  // 1. ALWAYS start the local relay server first. This prevents connect ECONNREFUSED 127.0.0.1:8787!
  try {
    if (tunnelManager) {
      await tunnelManager.ensureLocalServer(8787);
    }
  } catch (relayErr) {
    Logger.error('Failed to start local relay server', relayErr);
    vscode.window
      .showErrorMessage(
        `Failed to start CoLive local relay server: ${relayErr instanceof Error ? relayErr.message : String(relayErr)}`,
        'Show Logs',
      )
      .then((choice) => {
        if (choice === 'Show Logs') Logger.show();
      });
    return;
  }

  // 2. Auto-run / auto-provision Cloudflare Tunnel for worldwide collaboration
  if (isLocalOrTryCloudflare && tunnelManager) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CoLive: Establishing Worldwide Cloudflare Tunnel...',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Checking Cloudflare Tunnel helper...' });
        try {
          const bin = await tunnelManager!.ensureCloudflared((msg) => progress.report({ message: msg }));
          if (bin) {
            progress.report({ message: 'Connecting to Cloudflare worldwide edge...' });
            publicServerUrl = await tunnelManager!.startTunnel(8787, bin);
            progress.report({ message: 'Connected to Cloudflare worldwide edge!' });
            Logger.info(`Worldwide Cloudflare tunnel online: ${publicServerUrl}`);
          } else {
            const osInfo = getOsInstallCommand();
            Logger.warn(`Cloudflare tunnel helper (cloudflared) not available on ${osInfo.platformName}. Falling back to local relay.`);
            vscode.window
              .showInformationMessage(
                `CoLive: Session is running locally on 127.0.0.1:8787. To share worldwide, install cloudflared for ${osInfo.platformName}.`,
                'Auto-Install Dependencies',
                'Copy Terminal Command',
                'Show Logs',
              )
              .then(async (choice) => {
                if (choice === 'Show Logs') Logger.show();
                if (choice === 'Copy Terminal Command') {
                  await vscode.env.clipboard.writeText(osInfo.command);
                  vscode.window.showInformationMessage(`Copied command for ${osInfo.platformName} to clipboard!`);
                }
                if (choice === 'Auto-Install Dependencies' && tunnelManager) {
                  await promptOrInstallDependencies(tunnelManager, true);
                }
              });
          }
        } catch (err) {
          const friendlyError = formatFriendlyErrorMessage(err);
          Logger.warn('Failed to start Cloudflare tunnel, falling back to local relay', err);
          vscode.window
            .showWarningMessage(
              `Cloudflare tunnel notice: ${friendlyError}. Session is continuing on local relay server.`,
              'Auto-Install Dependencies',
              'Show Logs',
            )
            .then(async (choice) => {
              if (choice === 'Show Logs') Logger.show();
              if (choice === 'Auto-Install Dependencies' && tunnelManager) {
                await promptOrInstallDependencies(tunnelManager, true);
              }
            });
        }
      },
    );
  }

  // Host hosting on this machine MUST connect locally to 127.0.0.1:8787.
  // This guarantees 0ms latency, zero internet hops, and completely prevents ENOTFOUND and 530 errors!
  if (isLocalOrTryCloudflare || publicServerUrl) {
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

    const stateSub = hostSession.onDidChangeState((e) => {
      if (e.current === 'ended') {
        stateSub.dispose();
        teardownActiveSessionUI(hostSession);
      }
    });

    await hostSession.start();
    updateSessionContext(hostSession);
    participantsTree?.setSession(hostSession, hostSession.presenceManager, hostSession.followController);
    commentsTree?.setCommentsManager(hostSession.commentsManager);
    chatProvider?.setSession(hostSession.connection, 'host', displayName);
  } catch (err) {
    Logger.error('Failed to start host session', err);
    updateSessionContext(null);
    const friendlyError = formatFriendlyErrorMessage(err, hostLocalServerUrl);
    vscode.window
      .showErrorMessage(
        `Failed to start CoLive session: ${friendlyError}`,
        'Install Dependencies',
        'Show Logs',
      )
      .then(async (choice) => {
        if (choice === 'Show Logs') Logger.show();
        if (choice === 'Install Dependencies' && tunnelManager) {
          await promptOrInstallDependencies(tunnelManager, true);
        }
      });
    if (activeSession) {
      activeSession.dispose();
    }
    teardownActiveSessionUI();
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
  guestToken?: string,
): Promise<void> {
  Logger.show(true);
  Logger.info(`--- Starting CoLive Guest Join (Session ID: ${sessionId}) ---`);

  const config = getExtensionConfig();
  const targetServerUrl = serverUrl || config.serverUrl;
  const displayName = await resolveDisplayName();
  Logger.info(`Guest target relay URL: ${targetServerUrl}, display name: ${displayName}`);

  const guestSession = new GuestSession(targetServerUrl, sessionId, secret, displayName, guestToken);
  guestSession.onJoinAccepted = (token: string) => {
    if (extensionContext) {
      extensionContext.globalState.update('colive.persistedGuestSession', {
        sessionId,
        secret,
        serverUrl: targetServerUrl,
        guestToken: token,
        displayName,
        savedAt: Date.now(),
      });
    }
  };

  try {
    activeSession = guestSession;
    statusBar?.setSession(guestSession);
    participantsTree?.setSession(guestSession);

    const stateSub = guestSession.onDidChangeState((e) => {
      if (e.current === 'ended') {
        stateSub.dispose();
        teardownActiveSessionUI(guestSession);
      }
    });

    await guestSession.join();
    updateSessionContext(guestSession);
    participantsTree?.setSession(guestSession, guestSession.presenceManager, guestSession.followController);
    commentsTree?.setCommentsManager(guestSession.commentsManager);
    chatProvider?.setSession(guestSession.connection, guestSession.guestId, displayName);
  } catch (err) {
    Logger.error('Failed to join session', err);
    updateSessionContext(null);
    const friendlyError = formatFriendlyErrorMessage(err, targetServerUrl);
    vscode.window
      .showErrorMessage(
        `Failed to join CoLive session: ${friendlyError}`,
        'Show Logs',
      )
      .then((choice) => {
        if (choice === 'Show Logs') Logger.show();
      });

    // Ensure guest session is disposed so its socket does not stay open on the server
    guestSession.dispose();
    teardownActiveSessionUI(guestSession);
  }
}

async function endCurrentSession(): Promise<void> {
  if (!activeSession) {
    teardownActiveSessionUI();
    return;
  }

  if (activeSession.getState() !== 'active') {
    const session = activeSession;
    try {
      session.dispose();
    } finally {
      teardownActiveSessionUI(session);
    }
    return;
  }

  const isHost = activeSession instanceof HostSession;
  const message = isHost ? Strings.confirmEndSession : Strings.confirmLeaveSession;
  const button = isHost ? Strings.endSessionButton : Strings.leaveSessionButton;

  const choice = await vscode.window.showWarningMessage(message, { modal: true }, button);
  if (choice === button) {
    const session = activeSession;
    try {
      await session.endSession();
    } finally {
      teardownActiveSessionUI(session);
    }
    vscode.window.showInformationMessage(Strings.sessionEnded);
  }
}

export function deactivate(): void {
  Logger.info('CoLive extension deactivating...');
  const isReloadTransition = Boolean(
    extensionContext?.globalState.get<PersistedGuestSession>('colive.persistedGuestSession'),
  );

  if (activeSession && !isReloadTransition) {
    activeSession.endSession();
    activeSession = null;
  }
  updateSessionContext(null);
  if (!isReloadTransition) {
    cleanupColiveWorkspaceFolders();
  }
  tunnelManager?.stopTunnel();
  statusBar?.dispose();
  participantsTree?.dispose();
  commentsTree?.dispose();
  chatProvider?.dispose();
  Logger.dispose();
}
