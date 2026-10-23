import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import * as vscode from 'vscode';
import {
  CommentOp,
  CommentThreadData,
  Role,
  Permission,
} from '@colive/protocol';
import {
  validateCommentOp,
  parseMentions,
  generateInitialsAvatarSvg,
  sanitizeCommentMarkdown,
} from '../src/comments/commentValidator.js';
import { CommentsManager } from '../src/comments/CommentsManager.js';
import {
  escapeHtml,
  safeLinkify,
  ChatRateLimiter,
  ALLOWED_SLASH_COMMANDS,
  ChatViewProvider,
} from '../src/chat/chatViewProvider.js';
import {
  convertVsCodeDiagnosticsToItems,
  convertItemsToVsCodeDiagnostics,
  vsCodeSeverityToNumber,
  numberToVsCodeSeverity,
} from '../src/diagnostics/diagnosticsService.js';

describe('Milestone 8: Comments, Chat, Diagnostics', () => {
  describe('Comment Op Validator', () => {
    const hostUser = { id: 'host', role: 'host' as Role, displayName: 'Host', permission: 'readWrite' as Permission };
    const guestUser = { id: 'guest1', role: 'guest' as Role, displayName: 'Alice', permission: 'readWrite' as Permission };
    const readOnlyGuest = { id: 'guest2', role: 'guest' as Role, displayName: 'Bob', permission: 'readOnly' as Permission };

    const sampleThread: CommentThreadData = {
      id: 'th_1',
      path: 'src/main.ts',
      range: { startLine: 2, startChar: 0, endLine: 2, endChar: 10 },
      authorId: 'guest1',
      createdAt: Date.now(),
      resolved: false,
      comments: [
        {
          id: 'cmt_1',
          authorId: 'guest1',
          authorName: 'Alice',
          body: 'Initial comment',
          createdAt: Date.now(),
        },
      ],
    };

    it('validates thread creation properly', () => {
      const validCreate: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'create',
        threadId: 'th_2',
        path: 'src/app.ts',
        range: { startLine: 0, startChar: 0, endLine: 0, endChar: 5 },
        body: 'Hello world',
      };

      const res = validateCommentOp(validCreate, guestUser, true);
      expect(res.valid).toBe(true);

      // Missing path
      const noPath: CommentOp = { ...validCreate, path: '' };
      expect(validateCommentOp(noPath, guestUser, true).valid).toBe(false);

      // Missing body
      const noBody: CommentOp = { ...validCreate, body: '   ' };
      expect(validateCommentOp(noBody, guestUser, true).valid).toBe(false);

      // Exceeds 4000 characters
      const hugeBody: CommentOp = { ...validCreate, body: 'a'.repeat(4001) };
      expect(validateCommentOp(hugeBody, guestUser, true).valid).toBe(false);
    });

    it('enforces readOnly comments permission', () => {
      const op: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'create',
        threadId: 'th_3',
        path: 'src/index.ts',
        range: { startLine: 1, startChar: 0, endLine: 1, endChar: 5 },
        body: 'Read-only attempt',
      };

      // Disallow read-only comments
      const rejected = validateCommentOp(op, readOnlyGuest, false);
      expect(rejected.valid).toBe(false);

      // Allow read-only comments
      const allowed = validateCommentOp(op, readOnlyGuest, true);
      expect(allowed.valid).toBe(true);

      // Host is always allowed even if permission setting is false
      const hostAllowed = validateCommentOp(op, hostUser, false);
      expect(hostAllowed.valid).toBe(true);
    });

    it('validates replies and verifies thread existence', () => {
      const validReply: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'reply',
        threadId: 'th_1',
        body: 'Nice reply',
      };

      expect(validateCommentOp(validReply, guestUser, true, sampleThread).valid).toBe(true);

      // Non-existent thread
      expect(validateCommentOp(validReply, guestUser, true, undefined).valid).toBe(false);
    });

    it('restricts edit and delete to comment author or host', () => {
      const editOp: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'edit',
        threadId: 'th_1',
        commentId: 'cmt_1',
        body: 'Updated text',
      };

      // Author can edit
      expect(validateCommentOp(editOp, guestUser, true, sampleThread).valid).toBe(true);

      // Another guest cannot edit
      const otherGuest = { id: 'other', role: 'guest' as Role, displayName: 'Eve', permission: 'readWrite' as Permission };
      expect(validateCommentOp(editOp, otherGuest, true, sampleThread).valid).toBe(false);

      // Host can edit any comment
      expect(validateCommentOp(editOp, hostUser, true, sampleThread).valid).toBe(true);

      // Host can delete any comment
      const deleteOp: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'delete',
        threadId: 'th_1',
        commentId: 'cmt_1',
      };
      expect(validateCommentOp(deleteOp, hostUser, true, sampleThread).valid).toBe(true);

      // Deleting entire thread without commentId
      const deleteThreadOp: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'delete',
        threadId: 'th_1',
      };
      // Author can delete their own thread
      expect(validateCommentOp(deleteThreadOp, guestUser, true, sampleThread).valid).toBe(true);
      // Host can delete any thread
      expect(validateCommentOp(deleteThreadOp, hostUser, true, sampleThread).valid).toBe(true);
      // Other guest cannot delete someone else's thread
      expect(validateCommentOp(deleteThreadOp, otherGuest, true, sampleThread).valid).toBe(false);
    });

    it('validates resolve and unresolve operations', () => {
      const resolveOp: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'resolve',
        threadId: 'th_1',
      };
      expect(validateCommentOp(resolveOp, guestUser, true, sampleThread).valid).toBe(true);
      expect(validateCommentOp(resolveOp, guestUser, true, undefined).valid).toBe(false);
    });
  });

  describe('Mention Parsing and Avatars', () => {
    it('parses @mentions case-insensitively from text', () => {
      const text = 'Hey @alex and @Bob please take a look at @Charlie and @nonexistent';
      const participants = ['Alex', 'Bob', 'Charlie'];

      const mentions = parseMentions(text, participants);
      expect(mentions).toContain('Alex');
      expect(mentions).toContain('Bob');
      expect(mentions).toContain('Charlie');
      expect(mentions).not.toContain('nonexistent');
    });

    it('generates SVG initials avatar', () => {
      const svgUri = generateInitialsAvatarSvg('John Doe', '#E6194B');
      expect(svgUri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
      expect(decodeURIComponent(svgUri)).toContain('JD');
      expect(decodeURIComponent(svgUri)).toContain('#E6194B');
    });

    it('sanitizes markdown comments against script and command: URIs', () => {
      const dangerous = 'Click [here](command:workbench.action.terminal.new) or <script>alert(1)</script>';
      const safe = sanitizeCommentMarkdown(dangerous);
      expect(safe).not.toContain('command:');
      expect(safe).not.toContain('<script>');
      expect(safe).toContain('Click here');
    });
  });

  describe('Anchor Resolution after Edits with Y.RelativePosition', () => {
    it('shifts thread start/end anchors when text is inserted before the comment', () => {
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('content');
      ytext.insert(0, 'function calculateTotal(items) {\n  return 0;\n}');

      // Anchor comment at 'calculateTotal' (index 9 to 23)
      const startRel = Y.createRelativePositionFromTypeIndex(ytext, 9);
      const endRel = Y.createRelativePositionFromTypeIndex(ytext, 23);

      // Concurrent insert at line 0: "export " (length 7)
      ytext.insert(0, 'export ');

      const resolvedStart = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc);
      const resolvedEnd = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc);

      expect(resolvedStart).not.toBeNull();
      expect(resolvedEnd).not.toBeNull();
      expect(resolvedStart!.index).toBe(16); // 9 + 7
      expect(resolvedEnd!.index).toBe(30);   // 23 + 7

      expect(ytext.toString().slice(resolvedStart!.index, resolvedEnd!.index)).toBe('calculateTotal');
    });
  });

  describe('Chat XSS Protection, Slash Commands, and Rate Limiting', () => {
    it('escapes HTML tags and prevents script injection', () => {
      const xss1 = '<img src=x onerror=alert(1)>';
      const escaped = escapeHtml(xss1);
      expect(escaped).toBe('&lt;img src=x onerror=alert(1)&gt;');
      expect(escaped).not.toContain('<img');

      const xss2 = '<script>evil()</script>';
      expect(escapeHtml(xss2)).toBe('&lt;script&gt;evil()&lt;/script&gt;');
    });

    it('safely linkifies http/https URLs and ignores javascript: links', () => {
      const text = 'Check out https://github.com and javascript:alert(1)';
      const linkified = safeLinkify(text);

      expect(linkified).toContain('<a href="https://github.com" target="_blank" rel="noopener noreferrer"');
      expect(linkified).not.toContain('<a href="javascript:');
    });

    it('rate limits chat to at most 5 messages per second', () => {
      const limiter = new ChatRateLimiter(5);

      for (let i = 0; i < 5; i++) {
        expect(limiter.allow()).toBe(true);
      }

      // 6th message in same second should be blocked
      expect(limiter.allow()).toBe(false);
    });

    it('verifies strict slash-command allowlist', () => {
      expect(ALLOWED_SLASH_COMMANDS.has('colive.followParticipant')).toBe(true);
      expect(ALLOWED_SLASH_COMMANDS.has('colive.stopFollowing')).toBe(true);
      expect(ALLOWED_SLASH_COMMANDS.has('workbench.action.terminal.sendSequence')).toBe(false);
      expect(ALLOWED_SLASH_COMMANDS.has('vscode.openFolder')).toBe(false);
    });

    it('shows notification on incoming chat message from other users', async () => {
      const showInfoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
      const provider = new ChatViewProvider(vscode.Uri.file('/extension'));
      const mockConn = {
        on: vi.fn(),
        send: vi.fn(),
      } as any;
      provider.setSession(mockConn, 'user_self', 'Self');

      // @ts-expect-error accessing private method for test
      provider.handleIncomingChatMessage({
        v: 1,
        type: 'chat.message',
        fromId: 'user_other',
        fromName: 'Alice',
        text: 'Hello from Alice!',
        ts: Date.now(),
      });

      expect(showInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('CoLive [Alice]: Hello from Alice!'),
        'Open Chat',
      );
    });

    it('does not show notification when chat view is open and visible', async () => {
      const showInfoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
      showInfoSpy.mockClear();

      const provider = new ChatViewProvider(vscode.Uri.file('/extension'));
      const mockConn = {
        onMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        send: vi.fn(),
      } as any;
      provider.setSession(mockConn, 'user_self', 'Self');

      // Mock open chat view (visible = true)
      (provider as any).view = {
        visible: true,
        webview: { postMessage: vi.fn() },
      };

      // @ts-expect-error accessing private method for test
      provider.handleIncomingChatMessage({
        v: 1,
        type: 'chat.message',
        fromId: 'user_other',
        fromName: 'Alice',
        text: 'Hello while chat is open!',
        ts: Date.now(),
      });

      expect(showInfoSpy).not.toHaveBeenCalled();
      provider.dispose();
    });

    it('buffers messages until webview signals ready, then flushes history', async () => {
      const provider = new ChatViewProvider(vscode.Uri.file('/extension'));
      const mockConn = {
        onMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        send: vi.fn(),
      } as any;
      provider.setSession(mockConn, 'user_self', 'Self');

      // Incoming message before webview is resolved
      provider.handleIncomingChatMessage({
        v: 1,
        type: 'chat.message',
        fromId: 'user_bob',
        fromName: 'Bob',
        text: 'Pre-load message',
        ts: Date.now(),
      });

      const postedMessages: any[] = [];
      let messageHandler: ((data: any) => Promise<void>) | undefined;

      const mockWebviewView: any = {
        webview: {
          options: {},
          html: '',
          onDidReceiveMessage: vi.fn((fn) => {
            messageHandler = fn;
            return { dispose: vi.fn() };
          }),
          postMessage: vi.fn((msg) => {
            postedMessages.push(msg);
            return Promise.resolve(true);
          }),
        },
        onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
        visible: true,
      };

      provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

      // Webview sends 'ready' handshake
      expect(messageHandler).toBeDefined();
      await messageHandler!({ type: 'ready' });

      // Check that history was delivered
      const historyMsg = postedMessages.find((m) => m.type === 'setHistory');
      expect(historyMsg).toBeDefined();
      expect(historyMsg.messages.length).toBe(1);
      expect(historyMsg.messages[0].text).toBe('Pre-load message');

      provider.dispose();
    });

    it('handles /help and /clear slash commands', async () => {
      const provider = new ChatViewProvider(vscode.Uri.file('/extension'));
      const handledHelp = await provider.handleSlashCommand('/help');
      expect(handledHelp).toBe(true);

      const handledClear = await provider.handleSlashCommand('/clear');
      expect(handledClear).toBe(true);
    });

    it('deletes message locally and clears entire chat', () => {
      const provider = new ChatViewProvider(vscode.Uri.file('/extension'));
      const mockConn = {
        onMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        send: vi.fn(),
      } as any;
      provider.setSession(mockConn, 'user_self', 'Self');

      provider.handleIncomingChatMessage({
        v: 1,
        type: 'chat.message',
        fromId: 'user_1',
        fromName: 'Alice',
        text: 'Message 1',
        ts: Date.now(),
      });
      provider.handleIncomingChatMessage({
        v: 1,
        type: 'chat.message',
        fromId: 'user_2',
        fromName: 'Bob',
        text: 'Message 2',
        ts: Date.now(),
      });

      expect((provider as any).history.length).toBe(2);
      const firstId = (provider as any).history[0].id;

      // Delete first message
      provider.deleteMessageLocally(firstId);
      expect((provider as any).history.length).toBe(1);
      expect((provider as any).history[0].text).toBe('Message 2');

      // Clear all
      provider.clearChatLocally();
      expect((provider as any).history.length).toBe(0);

      provider.dispose();
    });

    it('skips echoed messages from self', () => {
      const showInfoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
      showInfoSpy.mockClear();

      const provider = new ChatViewProvider(vscode.Uri.file('/extension'));
      provider.setSession({ onMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }) } as any, 'user_me', 'Me');

      provider.handleIncomingChatMessage({
        v: 1,
        type: 'chat.message',
        fromId: 'user_me',
        fromName: 'Me',
        text: 'Echo message',
        ts: Date.now(),
      });

      expect(showInfoSpy).not.toHaveBeenCalled();
      provider.dispose();
    });

    it('deduplicates messages matching an existing unique id so they never appear multiple times', () => {
      const provider = new ChatViewProvider(vscode.Uri.file('/extension'));
      provider.setSession({ onMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }) } as any, 'user_self', 'Self');

      const uniqueId = 'msg_unique_12345';
      const msg = {
        v: 1,
        type: 'chat.message' as const,
        id: uniqueId,
        messageId: uniqueId,
        fromId: 'user_alice',
        fromName: 'Alice',
        text: 'Hello, this is unique!',
        ts: Date.now(),
      };

      // First delivery: should be added
      provider.handleIncomingChatMessage(msg);
      expect((provider as any).history.length).toBe(1);
      expect((provider as any).history[0].id).toBe(uniqueId);

      // Second delivery with identical ID (e.g. from sync or retry): matched, considered already present!
      provider.handleIncomingChatMessage(msg);
      expect((provider as any).history.length).toBe(1); // Still 1, NOT duplicated

      // Different ID: should be added
      provider.handleIncomingChatMessage({
        ...msg,
        id: 'msg_unique_67890',
        messageId: 'msg_unique_67890',
        text: 'Second message',
      });
      expect((provider as any).history.length).toBe(2);

      provider.dispose();
    });

    it('syncs missed messages sent during retry period upon reconnection and handles chat.clear', () => {
      const provider = new ChatViewProvider(vscode.Uri.file('/extension'));
      const sentMessages: any[] = [];
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};

      const mockConn = {
        send: vi.fn((m) => sentMessages.push(m)),
        onMessage: vi.fn((fn) => {
          (listeners['message'] ||= []).push(fn);
          return { dispose: () => {} };
        }),
        on: vi.fn((evt, fn) => {
          (listeners[evt] ||= []).push(fn);
          return { dispose: () => {} };
        }),
      } as any;

      provider.setSession(mockConn, 'user_guest', 'Guest');

      // Add one initial message
      provider.handleIncomingChatMessage({
        v: 1,
        type: 'chat.message',
        id: 'msg_initial',
        fromId: 'user_host',
        fromName: 'Host',
        text: 'Welcome',
        ts: Date.now() - 5000,
      });
      expect((provider as any).history.length).toBe(1);

      // Simulate connection dropping into reconnecting state for 1 second
      for (const fn of listeners['stateChange'] || []) {
        fn('reconnecting');
      }

      // Simulate connection reconnected
      for (const fn of listeners['reconnected'] || []) {
        fn();
      }

      // Client should have sent chat.sync.req for missed messages during retry period
      const syncReq = sentMessages.find((m) => m.type === 'chat.sync.req');
      expect(syncReq).toBeDefined();
      expect(syncReq.lastMessageId).toBe('msg_initial');

      // Server responds with missed message sent during that 1 second
      const missedMsg = {
        v: 1,
        type: 'chat.message' as const,
        id: 'msg_sent_during_retry',
        fromId: 'user_host',
        fromName: 'Host',
        text: 'Message sent while guest was reconnecting',
        ts: Date.now(),
      };

      for (const fn of listeners['message'] || []) {
        fn({
          v: 1,
          type: 'chat.sync.res',
          id: syncReq.id,
          messages: [missedMsg],
        });
      }

      // Missed message should now be in guest history
      expect((provider as any).history.length).toBe(2);
      expect((provider as any).history[1].id).toBe('msg_sent_during_retry');
      expect((provider as any).history[1].text).toBe('Message sent while guest was reconnecting');

      // Simulate chat.clear: removes chat from history across participants
      for (const fn of listeners['message'] || []) {
        fn({
          v: 1,
          type: 'chat.clear',
        });
      }
      expect((provider as any).history.length).toBe(0);

      provider.dispose();
    });
  });

  describe('Diagnostics Conversion and Mapping', () => {
    it('converts VS Code diagnostics to protocol items and back', () => {
      const range = new vscode.Range(5, 2, 5, 12);
      const original = new vscode.Diagnostic(range, 'Type error: variable unused', vscode.DiagnosticSeverity.Error);
      original.source = 'typescript';
      original.code = 6133;

      const items = convertVsCodeDiagnosticsToItems([original]);
      expect(items.length).toBe(1);
      expect(items[0]).toEqual({
        range: { startLine: 5, startChar: 2, endLine: 5, endChar: 12 },
        severity: 0,
        message: 'Type error: variable unused',
        source: 'typescript',
        code: 6133,
      });

      const convertedBack = convertItemsToVsCodeDiagnostics(items);
      expect(convertedBack.length).toBe(1);
      expect(convertedBack[0].message).toBe('Type error: variable unused');
      expect(convertedBack[0].severity).toBe(vscode.DiagnosticSeverity.Error);
      expect(convertedBack[0].source).toContain('typescript');
      expect(convertedBack[0].code).toBe(6133);
    });

    it('correctly maps all 4 severity levels', () => {
      expect(vsCodeSeverityToNumber(vscode.DiagnosticSeverity.Error)).toBe(0);
      expect(vsCodeSeverityToNumber(vscode.DiagnosticSeverity.Warning)).toBe(1);
      expect(vsCodeSeverityToNumber(vscode.DiagnosticSeverity.Information)).toBe(2);
      expect(vsCodeSeverityToNumber(vscode.DiagnosticSeverity.Hint)).toBe(3);

      expect(numberToVsCodeSeverity(0)).toBe(vscode.DiagnosticSeverity.Error);
      expect(numberToVsCodeSeverity(1)).toBe(vscode.DiagnosticSeverity.Warning);
      expect(numberToVsCodeSeverity(2)).toBe(vscode.DiagnosticSeverity.Information);
      expect(numberToVsCodeSeverity(3)).toBe(vscode.DiagnosticSeverity.Hint);
    });
  });

  describe('Guest and Host Comment Lifecycle and Minimization', () => {
    function createMockConnection() {
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const sentMessages: any[] = [];
      return {
        sentMessages,
        send: vi.fn((m) => sentMessages.push(m)),
        sendJson: vi.fn((m) => sentMessages.push(m)),
        request: vi.fn(),
        onMessage: vi.fn((fn) => {
          (listeners['message'] ||= []).push(fn);
          return { dispose: () => {} };
        }),
        on: vi.fn((evt, fn) => {
          (listeners[evt] ||= []).push(fn);
          return { dispose: () => {} };
        }),
        emitMessage: (msg: any) => {
          for (const fn of listeners['message'] || []) {
            fn(msg);
          }
        },
      };
    }

    it('retains guest comments when collapsed/minimized and keeps them in active threads and tree view', async () => {
      const mockConn = createMockConnection();
      const guestManager = new CommentsManager({
        connection: mockConn as any,
        role: 'guest',
        userId: 'guest_alice',
        userName: 'Alice',
        userColor: '#3CB44B',
        permission: 'readWrite',
        folderName: 'Shared',
      });

      // Mock open editor on guest colive filesystem
      const guestDocUri = vscode.Uri.parse('colive:/Shared/src/index.ts');
      const mockDoc = {
        uri: guestDocUri,
        lineCount: 20,
        positionAt: (idx: number) => new vscode.Position(0, idx),
      };
      (vscode.window as any).activeTextEditor = {
        document: mockDoc,
      };
      (vscode.window as any).visibleTextEditors = [{ document: mockDoc }];

      // Guest creates a thread in editor
      const threadId = 'th_guest_1';
      const range = new vscode.Range(2, 0, 2, 10);
      const vsComment: vscode.Comment = {
        author: { name: 'Alice' },
        body: new vscode.MarkdownString('Guest inline feedback'),
        mode: vscode.CommentMode.Preview,
      };

      // In VS Code, createCommentController creates a thread
      const thread = (guestManager as any).commentController.createCommentThread(guestDocUri, range, [vsComment]);
      thread.canReply = true;
      thread.contextValue = 'unresolved';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

      guestManager.registerActiveThread(threadId, thread);

      await guestManager.dispatchOp({
        v: 1,
        type: 'comment.op',
        op: 'create',
        threadId,
        commentId: 'cmt_1',
        path: 'src/index.ts',
        range: { startLine: 2, startChar: 0, endLine: 2, endChar: 10 },
        body: 'Guest inline feedback',
        authorId: 'guest_alice',
        authorName: 'Alice',
      });

      // Verify thread is in guest's local state and sent over network
      expect(guestManager.getAllThreads().length).toBe(1);
      expect(guestManager.getThreadIdByVsThread(thread)).toBe(threadId);
      expect(mockConn.sentMessages.some((m) => m.type === 'comment.op' && m.op === 'create')).toBe(true);

      // User collapses/minimizes the comment thread in the UI
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

      // Sync runs (e.g. on editor focus or text change)
      guestManager.syncCommentThreads();

      // Crucial test: Thread must NOT be disposed, and collapsibleState must remain Collapsed (not forced Expanded)
      expect(thread.isDisposed).toBe(false);
      expect(thread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Collapsed);
      expect(guestManager.getAllThreads().length).toBe(1);

      // Verify expandThread can re-expand it when opened from comments tree
      guestManager.expandThread(threadId);
      expect(thread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);

      guestManager.dispose();
    });

    it('syncs existing comments from host to guest on connection via comment.sync.req', async () => {
      const hostConn = createMockConnection();
      const hostManager = new CommentsManager({
        connection: hostConn as any,
        role: 'host',
        userId: 'host_id',
        userName: 'Host',
        userColor: '#E6194B',
        permission: 'readWrite',
        workspaceRoot: '/workspace',
      });

      // Host creates an existing comment
      await hostManager.dispatchOp({
        v: 1,
        type: 'comment.op',
        op: 'create',
        threadId: 'th_existing',
        commentId: 'cmt_exist',
        path: 'src/main.ts',
        range: { startLine: 5, startChar: 0, endLine: 5, endChar: 15 },
        body: 'Pre-existing comment by host',
      });

      expect(hostManager.getAllThreads().length).toBe(1);

      // Host handles comment.sync.req from connecting guest
      hostConn.emitMessage({
        v: 1,
        type: 'comment.sync.req',
        id: 'sync_req_1',
      });

      const syncRes = hostConn.sentMessages.find((m) => m.type === 'comment.sync.res');
      expect(syncRes).toBeDefined();
      expect(syncRes.threads.length).toBe(1);
      expect(syncRes.threads[0].id).toBe('th_existing');
      expect(syncRes.threads[0].comments[0].body).toBe('Pre-existing comment by host');

      // Guest initializes and applies the sync response
      const guestConn = createMockConnection();
      guestConn.request = vi.fn().mockResolvedValue(syncRes);

      const guestManager = new CommentsManager({
        connection: guestConn as any,
        role: 'guest',
        userId: 'guest_bob',
        userName: 'Bob',
        userColor: '#3CB44B',
        permission: 'readWrite',
        folderName: 'Shared',
      });

      await guestManager.requestCommentsSync();

      // Guest now has host's pre-existing comments
      expect(guestManager.getAllThreads().length).toBe(1);
      expect(guestManager.getAllThreads()[0].id).toBe('th_existing');

      hostManager.dispose();
      guestManager.dispose();
    });

    it('relays host comments to guest and guest replies in real-time', async () => {
      const hostConn = createMockConnection();
      const guestConn = createMockConnection();

      const hostManager = new CommentsManager({
        connection: hostConn as any,
        role: 'host',
        userId: 'host_user',
        userName: 'Host',
        userColor: '#E6194B',
        permission: 'readWrite',
        workspaceRoot: '/workspace',
      });

      const guestManager = new CommentsManager({
        connection: guestConn as any,
        role: 'guest',
        userId: 'guest_user',
        userName: 'Guest',
        userColor: '#3CB44B',
        permission: 'readWrite',
        folderName: 'Shared',
      });

      // Host creates comment
      const createOp: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'create',
        threadId: 'th_shared_1',
        commentId: 'cmt_h1',
        path: 'src/app.ts',
        range: { startLine: 1, startChar: 0, endLine: 1, endChar: 5 },
        body: 'Check this line',
        authorId: 'host_user',
        authorName: 'Host',
      };

      await hostManager.dispatchOp(createOp);

      // Guest receives host's comment.op
      guestConn.emitMessage(createOp);

      expect(guestManager.getAllThreads().length).toBe(1);
      expect(guestManager.getAllThreads()[0].comments[0].body).toBe('Check this line');

      // Guest replies to host's thread
      const replyOp: CommentOp = {
        v: 1,
        type: 'comment.op',
        op: 'reply',
        threadId: 'th_shared_1',
        commentId: 'cmt_g1',
        body: 'Looks good to me!',
        authorId: 'guest_user',
        authorName: 'Guest',
      };

      await guestManager.dispatchOp(replyOp);

      // Host receives guest's reply
      hostConn.emitMessage(replyOp);

      expect(hostManager.getAllThreads()[0].comments.length).toBe(2);
      expect(hostManager.getAllThreads()[0].comments[1].body).toBe('Looks good to me!');

      hostManager.dispose();
      guestManager.dispose();
    });

    it('allows host to discard/delete a comment thread after minimizing and reopening it', async () => {
      const hostConn = createMockConnection();
      const hostManager = new CommentsManager({
        connection: hostConn as any,
        role: 'host',
        userId: 'host_admin',
        userName: 'Admin',
        userColor: '#E6194B',
        permission: 'readWrite',
        workspaceRoot: '/workspace',
      });

      const docUri = vscode.Uri.file('/workspace/index.ts');
      const mockDoc = {
        uri: docUri,
        lineCount: 15,
        positionAt: (idx: number) => new vscode.Position(0, idx),
      };
      (vscode.window as any).activeTextEditor = { document: mockDoc };
      (vscode.window as any).visibleTextEditors = [{ document: mockDoc }];

      const threadId = 'th_host_min';
      const range = new vscode.Range(3, 0, 3, 10);
      const vsComment: vscode.Comment = {
        author: { name: 'Admin' },
        body: new vscode.MarkdownString('Host comment to minimize'),
        mode: vscode.CommentMode.Preview,
        contextValue: 'canDelete',
      };

      const thread = (hostManager as any).commentController.createCommentThread(docUri, range, [vsComment]);
      thread.canReply = true;
      thread.contextValue = 'unresolved';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

      hostManager.registerActiveThread(threadId, thread);

      await hostManager.dispatchOp({
        v: 1,
        type: 'comment.op',
        op: 'create',
        threadId,
        commentId: 'cmt_min_1',
        path: 'index.ts',
        range: { startLine: 3, startChar: 0, endLine: 3, endChar: 10 },
        body: 'Host comment to minimize',
        authorId: 'host_admin',
        authorName: 'Admin',
      });

      expect(hostManager.getAllThreads().length).toBe(1);

      // Step 1: Host minimizes (collapses) the comment thread
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      hostManager.syncCommentThreads();
      expect(thread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Collapsed);

      // Step 2: Host reopens (expands) the comment thread
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      hostManager.syncCommentThreads();
      expect(thread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);

      // Step 3: Host discards that comment thread (op: delete)
      await hostManager.dispatchOp({
        v: 1,
        type: 'comment.op',
        op: 'delete',
        threadId,
        authorId: 'host_admin',
        authorName: 'Admin',
      });

      // Synchronize and verify thread is disposed and removed
      hostManager.syncCommentThreads();
      expect(hostManager.getAllThreads().length).toBe(0);
      expect(thread.isDisposed).toBe(true);

      hostManager.dispose();
    });

    it('allows discarding an unsubmitted draft comment thread after minimizing and reopening it', async () => {
      const hostConn = createMockConnection();
      const hostManager = new CommentsManager({
        connection: hostConn as any,
        role: 'host',
        userId: 'host_admin',
        userName: 'Admin',
        userColor: '#E6194B',
        permission: 'readWrite',
        workspaceRoot: '/workspace',
      });

      const docUri = vscode.Uri.file('/workspace/index.ts');
      const mockDoc = {
        uri: docUri,
        lineCount: 15,
        positionAt: (idx: number) => new vscode.Position(0, idx),
      };
      (vscode.window as any).activeTextEditor = { document: mockDoc };
      (vscode.window as any).visibleTextEditors = [{ document: mockDoc }];

      // User clicked '+' on gutter: draft thread with empty comments
      const draftThread = (hostManager as any).commentController.createCommentThread(
        docUri,
        new vscode.Range(5, 0, 5, 0),
        [],
      );
      draftThread.canReply = true;
      draftThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

      // User minimizes (collapses) the draft
      draftThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

      // User reopens the draft
      draftThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

      // User discards the draft
      draftThread.dispose();
      expect(draftThread.isDisposed).toBe(true);

      hostManager.dispose();
    });

    it('clears all comments from CoLive panel tree view upon session disconnect', async () => {
      const mockConn = createMockConnection();
      const hostManager = new CommentsManager({
        connection: mockConn as any,
        role: 'host',
        userId: 'host_id',
        userName: 'Host',
        userColor: '#E6194B',
        permission: 'readWrite',
        workspaceRoot: '/workspace',
      });

      await hostManager.dispatchOp({
        v: 1,
        type: 'comment.op',
        op: 'create',
        threadId: 'th_panel_1',
        commentId: 'cmt_panel_1',
        path: 'src/file.ts',
        range: { startLine: 1, startChar: 0, endLine: 1, endChar: 10 },
        body: 'Panel comment',
        authorId: 'host_id',
        authorName: 'Host',
      });

      const { CommentsTreeProvider } = await import('../src/comments/commentsTree.js');
      const treeProvider = new CommentsTreeProvider();
      treeProvider.setCommentsManager(hostManager);

      // Verify tree view shows the file and comments while in session
      const itemsInSession = await treeProvider.getChildren();
      expect(itemsInSession.length).toBe(1);
      expect(itemsInSession[0].filePath).toBe('src/file.ts');

      // Session disconnects: commentsManager is unlinked and cleared
      treeProvider.setCommentsManager(null);

      // Verify tree view is completely empty
      const itemsAfterDisconnect = await treeProvider.getChildren();
      expect(itemsAfterDisconnect.length).toBe(0);

      // Verify hostManager dispose clears its internal map and active threads
      hostManager.dispose();
      expect(hostManager.getAllThreads().length).toBe(0);

      treeProvider.dispose();
    });

    it('safely handles commands when invoked without arguments (e.g. keybindings or bare executions)', async () => {
      // In VS Code, bare command execution or missing context must not throw Cannot read properties of undefined
      const createCommentCmd = (vscode.commands as any)._registeredCommands?.get('colive.createComment');
      const replyCommentCmd = (vscode.commands as any)._registeredCommands?.get('colive.replyComment');

      if (createCommentCmd) {
        await expect(createCommentCmd(undefined)).resolves.not.toThrow();
        await expect(createCommentCmd({})).resolves.not.toThrow();
      }

      if (replyCommentCmd) {
        await expect(replyCommentCmd(undefined)).resolves.not.toThrow();
        await expect(replyCommentCmd({})).resolves.not.toThrow();
      }
    });
  });
});


