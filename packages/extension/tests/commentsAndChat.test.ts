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
});
