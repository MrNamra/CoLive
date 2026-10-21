import * as vscode from 'vscode';
import crypto from 'node:crypto';
import {
  ChatMessage,
  ChatSyncReq,
  ChatSyncRes,
  ChatClear,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';

export interface ChatMessageItem {
  id: string;
  fromId: string;
  fromName: string;
  text: string;
  ts: number;
  isSelf: boolean;
}

/**
 * Strict allowlist of commands executable via slash commands in chat.
 */
export const ALLOWED_SLASH_COMMANDS = new Set([
  'colive.followParticipant',
  'colive.stopFollowing',
]);

/**
 * Escapes HTML characters to prevent XSS.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safely linkifies http/https URLs into anchor tags with rel="noopener noreferrer".
 * All other text is strictly escaped.
 */
export function safeLinkify(rawText: string): string {
  const urlRegex = /(https?:\/\/[^\s<>'"]+)/g;
  const parts = rawText.split(urlRegex);

  return parts
    .map((part) => {
      if (part.match(/^https?:\/\//)) {
        const escapedUrl = escapeHtml(part);
        return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="chat-link">${escapedUrl}</a>`;
      }
      return escapeHtml(part);
    })
    .join('');
}

export class ChatRateLimiter {
  private timestamps: number[] = [];
  private maxMsgsPerSecond: number;

  constructor(maxMsgsPerSecond = 5) {
    this.maxMsgsPerSecond = maxMsgsPerSecond;
  }

  public allow(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);
    if (this.timestamps.length >= this.maxMsgsPerSecond) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'colive.chatView';

  private view?: vscode.WebviewView;
  private connection: ConnectionManager | null = null;
  private sessionDisposable: vscode.Disposable | null = null;
  private sessionDisposables: vscode.Disposable[] = [];
  private disconnectedAt: number | null = null;
  private currentUserId = '';
  private currentUserName = '';
  private history: ChatMessageItem[] = [];
  private unreadCount = 0;
  private rateLimiter = new ChatRateLimiter(5);
  private disposables: vscode.Disposable[] = [];
  private isWebviewReady = false;
  private pendingWebviewMessages: Array<any> = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  public setSession(
    connection: ConnectionManager | null,
    userId: string,
    userName: string,
  ): void {
    if (this.sessionDisposable) {
      this.sessionDisposable.dispose();
      this.sessionDisposable = null;
    }
    for (const d of this.sessionDisposables) {
      d.dispose();
    }
    this.sessionDisposables = [];

    const isResuming = this.currentUserId === userId && this.currentUserName === userName && this.history.length > 0;
    this.connection = connection;
    this.currentUserId = userId;
    this.currentUserName = userName;

    if (!isResuming) {
      this.history = [];
      this.unreadCount = 0;
      this.updateBadge();
    }

    if (this.connection) {
      const messageHandler = (msg: any) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'chat.message') {
          this.handleIncomingChatMessage(msg as ChatMessage);
        } else if (msg.type === 'chat.sync.res') {
          this.handleChatSyncResponse(msg as ChatSyncRes);
        } else if (msg.type === 'chat.sync.req') {
          this.handleChatSyncRequest(msg as ChatSyncReq);
        } else if (msg.type === 'chat.clear') {
          this.clearChatLocally(false);
        }
      };

      if (typeof (this.connection as any).onMessage === 'function') {
        this.sessionDisposables.push(this.connection.onMessage(messageHandler));
      } else if (typeof (this.connection as any).on === 'function') {
        this.connection.on('message', messageHandler);
        this.sessionDisposables.push({
          dispose: () => this.connection?.off('message', messageHandler),
        });
      }

      if (typeof (this.connection as any).on === 'function') {
        this.sessionDisposables.push(
          this.connection.on('stateChange', (state) => {
            if (state === 'reconnecting') {
              if (!this.disconnectedAt) {
                this.disconnectedAt = Date.now();
              }
            } else if (state === 'connected' && this.disconnectedAt) {
              this.syncMissedMessages();
            }
          }),
        );
        this.sessionDisposables.push(
          this.connection.on('reconnected', () => {
            this.syncMissedMessages();
          }),
        );
      }

      this.postToWebview({
        type: 'setHistory',
        messages: isResuming ? this.history : [],
      });
      this.postToWebview({
        type: 'setSessionState',
        inSession: true,
        userName: this.currentUserName,
      });
      if (!isResuming) {
        this.postToWebview({
          type: 'addSystemMessage',
          text: `Connected as ${userName || userId}. Start chatting below!`,
        });
      }
    } else {
      this.postToWebview({
        type: 'setSessionState',
        inSession: false,
      });
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    this.isWebviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.unreadCount = 0;
        this.updateBadge();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'ready': {
          this.isWebviewReady = true;
          this.view?.webview.postMessage({
            type: 'setSessionState',
            inSession: !!this.connection,
            userName: this.currentUserName,
          });
          this.view?.webview.postMessage({
            type: 'setHistory',
            messages: this.history,
          });
          while (this.pendingWebviewMessages.length > 0) {
            const p = this.pendingWebviewMessages.shift();
            this.view?.webview.postMessage(p);
          }
          break;
        }
        case 'deleteMessage': {
          if (data.id) {
            this.deleteMessageLocally(data.id);
          }
          break;
        }
        case 'clearChat': {
          this.clearChatLocally();
          break;
        }
        case 'sendMessage': {
          await this.processOutgoingMessage(data.text);
          break;
        }
        case 'openLink': {
          if (data.url) {
            try {
              await vscode.env.openExternal(vscode.Uri.parse(data.url));
            } catch {
              // Ignore invalid url
            }
          }
          break;
        }
      }
    });
  }

  public clearChatLocally(broadcast = true): void {
    this.history = [];
    this.unreadCount = 0;
    this.updateBadge();
    this.postToWebview({ type: 'setHistory', messages: [] });
    if (broadcast && this.connection) {
      const clearMsg: ChatClear = {
        v: PROTOCOL_VERSION,
        type: 'chat.clear',
        fromId: this.currentUserId,
      };
      this.connection.send(clearMsg);
    }
  }

  public deleteMessageLocally(id: string): void {
    const idx = this.history.findIndex((m) => m.id === id);
    if (idx !== -1) {
      this.history.splice(idx, 1);
      this.postToWebview({ type: 'deleteMessage', id });
    }
  }

  private postToWebview(msg: any): void {
    if (this.view && this.isWebviewReady) {
      this.view.webview.postMessage(msg);
    } else {
      this.pendingWebviewMessages.push(msg);
    }
  }

  private async processOutgoingMessage(text: string): Promise<void> {
    if (!text || text.trim().length === 0) return;

    if (!this.rateLimiter.allow()) {
      this.postToWebview({
        type: 'addSystemMessage',
        text: 'Rate limit exceeded: maximum 5 messages per second.',
      });
      return;
    }

    const trimmed = text.trim();

    // Check slash commands
    if (trimmed.startsWith('/')) {
      const handled = await this.handleSlashCommand(trimmed);
      if (handled) return;
    }

    if (!this.connection) {
      this.postToWebview({
        type: 'addSystemMessage',
        text: 'Cannot send message: no active session. Please share or join a session first.',
      });
      return;
    }

    const msgId = `chat_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();

    const msg: ChatMessage = {
      v: PROTOCOL_VERSION,
      type: 'chat.message',
      id: msgId,
      messageId: msgId,
      fromId: this.currentUserId,
      fromName: this.currentUserName || 'You',
      text: trimmed,
      ts: now,
    };

    this.connection.send(msg);

    const item: ChatMessageItem = {
      id: msgId,
      fromId: this.currentUserId,
      fromName: this.currentUserName || 'You',
      text: trimmed,
      ts: now,
      isSelf: true,
    };
    this.history.push(item);
    this.postToWebview({ type: 'addMessage', message: item });
  }

  public async handleSlashCommand(commandText: string): Promise<boolean> {
    const parts = commandText.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const arg = parts.slice(1).join(' ');

    if (cmd === '/clear') {
      this.clearChatLocally();
      return true;
    }

    if (cmd === '/help' || cmd === '/?') {
      this.postToWebview({
        type: 'addSystemMessage',
        text: 'Available commands: /follow [name], /stopfollow, /goto <file>[:line], /clear, /help',
      });
      return true;
    }

    if (cmd === '/follow') {
      if (ALLOWED_SLASH_COMMANDS.has('colive.followParticipant')) {
        await vscode.commands.executeCommand('colive.followParticipant', arg || undefined);
        this.postToWebview({
          type: 'addSystemMessage',
          text: `Executing /follow ${arg}...`,
        });
        return true;
      }
    }

    if (cmd === '/stopfollow') {
      if (ALLOWED_SLASH_COMMANDS.has('colive.stopFollowing')) {
        await vscode.commands.executeCommand('colive.stopFollowing');
        this.postToWebview({
          type: 'addSystemMessage',
          text: 'Stopped following.',
        });
        return true;
      }
    }

    if (cmd === '/goto') {
      // Format: /goto file:line or /goto path/to/file.ts:42
      const match = arg.match(/^(.+?)(?::(\d+))?$/);
      if (match) {
        const filePath = match[1];
        const lineNum = match[2] ? parseInt(match[2], 10) - 1 : 0;
        try {
          let fileUri: vscode.Uri;
          if (filePath.startsWith('/') || filePath.match(/^[a-zA-Z]:/)) {
            fileUri = vscode.Uri.file(filePath);
          } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            fileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath);
          } else {
            fileUri = vscode.Uri.file(filePath);
          }
          const doc = await vscode.workspace.openTextDocument(fileUri);
          const editor = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(lineNum, 0);
          editor.revealRange(new vscode.Range(pos, pos));
          this.postToWebview({
            type: 'addSystemMessage',
            text: `Navigated to ${filePath}:${lineNum + 1}`,
          });
          return true;
        } catch (err) {
          this.postToWebview({
            type: 'addSystemMessage',
            text: `Failed to open file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
          });
          return true;
        }
      }
    }

    return false;
  }

  public handleIncomingChatMessage(msg: ChatMessage): void {
    const msgId = msg.id || msg.messageId || `chat_${msg.ts}_${msg.fromId}`;

    // Deduplication check: match with existing messages by unique ID
    const alreadyPresent = this.history.some((m) => m.id === msgId);
    if (alreadyPresent) {
      // Message is already present - do not show multiple times!
      return;
    }

    const isSelf = msg.fromId === this.currentUserId;
    const item: ChatMessageItem = {
      id: msgId,
      fromId: msg.fromId,
      fromName: msg.fromName,
      text: msg.text,
      ts: msg.ts,
      isSelf,
    };

    this.history.push(item);
    this.history.sort((a, b) => a.ts - b.ts);
    this.postToWebview({ type: 'addMessage', message: item });

    if (!isSelf && !this.view?.visible) {
      this.unreadCount++;
      this.updateBadge();

      // Show notification for incoming chat messages only when chat is not open
      const preview = msg.text.length > 60 ? `${msg.text.slice(0, 57)}...` : msg.text;
      vscode.window
        .showInformationMessage(`CoLive [${msg.fromName}]: ${preview}`, 'Open Chat')
        .then((action) => {
          if (action === 'Open Chat') {
            vscode.commands.executeCommand('colive.chatView.focus');
          }
        });
    }
  }

  public syncMissedMessages(): void {
    if (!this.connection) return;
    const retryPeriodStart = this.disconnectedAt || (Date.now() - 30000);
    const lastItem = this.history[this.history.length - 1];
    // Check during the retry period: since retryPeriodStart - 2000ms overlap
    const since = Math.max(0, retryPeriodStart - 2000);

    const syncReq: ChatSyncReq = {
      v: PROTOCOL_VERSION,
      type: 'chat.sync.req',
      id: `sync_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      since,
      lastMessageId: lastItem?.id,
      fromId: this.currentUserId,
    };
    this.connection.send(syncReq);
    this.disconnectedAt = null;
  }

  public handleChatSyncResponse(res: ChatSyncRes): void {
    if (Array.isArray(res.messages)) {
      for (const msg of res.messages) {
        this.handleIncomingChatMessage(msg);
      }
    }
  }

  public handleChatSyncRequest(req: ChatSyncReq): void {
    if (req.fromId && req.fromId === this.currentUserId) return;
    const since = req.since || 0;
    const missed = this.history.filter((m) => m.ts >= since);
    if (missed.length > 0 && this.connection) {
      const syncRes: ChatSyncRes = {
        v: PROTOCOL_VERSION,
        type: 'chat.sync.res',
        id: req.id,
        messages: missed.map((m) => ({
          v: PROTOCOL_VERSION,
          type: 'chat.message',
          id: m.id,
          messageId: m.id,
          fromId: m.fromId,
          fromName: m.fromName,
          text: m.text,
          ts: m.ts,
        })),
      };
      this.connection.send(syncRes);
    }
  }

  private updateBadge(): void {
    if (this.view) {
      if (this.unreadCount > 0) {
        this.view.badge = {
          value: this.unreadCount,
          tooltip: `${this.unreadCount} unread message${this.unreadCount > 1 ? 's' : ''}`,
        };
      } else {
        this.view.badge = undefined;
      }
    }
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CoLive Chat</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    #messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 10px 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .empty-state {
      margin: auto;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      padding: 24px 16px;
      line-height: 1.5;
    }
    .chat-msg {
      position: relative;
      padding: 6px 10px;
      border-radius: 6px;
      max-width: 88%;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.4;
    }
    .chat-msg:hover .msg-delete-btn {
      opacity: 0.8;
      visibility: visible;
    }
    .chat-msg.self {
      align-self: flex-end;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .chat-msg.remote {
      align-self: flex-start;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      color: var(--vscode-foreground);
    }
    .chat-msg.system {
      align-self: center;
      background: none;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 11px;
      text-align: center;
      max-width: 95%;
    }
    .msg-header {
      font-weight: 600;
      font-size: 11px;
      margin-bottom: 2px;
      opacity: 0.85;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .msg-meta {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .msg-time {
      font-weight: normal;
      font-size: 10px;
      opacity: 0.7;
    }
    .msg-delete-btn {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      font-size: 11px;
      line-height: 1;
      padding: 1px 3px;
      border-radius: 3px;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s;
    }
    .msg-delete-btn:hover {
      opacity: 1 !important;
      background-color: rgba(255, 255, 255, 0.2);
    }
    .chat-msg.remote .msg-delete-btn:hover {
      background-color: rgba(0, 0, 0, 0.15);
    }
    .msg-body {
      white-space: pre-wrap;
    }
    .chat-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      cursor: pointer;
    }
    #chat-toolbar {
      display: flex;
      justify-content: flex-end;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-sideBar-border, rgba(128, 128, 128, 0.15));
      background-color: var(--vscode-sideBar-background);
    }
    .toolbar-btn {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .toolbar-btn:hover {
      color: var(--vscode-foreground);
      background-color: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
    }
    #input-container {
      display: flex;
      padding: 8px;
      border-top: 1px solid var(--vscode-sideBar-border, rgba(128, 128, 128, 0.2));
      gap: 6px;
      background-color: var(--vscode-sideBar-background);
    }
    #chat-input {
      flex: 1;
      padding: 6px 8px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
    }
    #chat-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    #send-btn {
      padding: 6px 12px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }
    #send-btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div id="chat-toolbar">
    <button id="clear-btn" class="toolbar-btn" type="button" title="Clear chat history locally">Clear Chat</button>
  </div>
  <div id="messages-container">
    <div id="empty-state" class="empty-state">No messages yet. Send a message to chat with your team!</div>
  </div>
  <div id="input-container">
    <input type="text" id="chat-input" placeholder="Type a message or /follow, /goto..." autocomplete="off" />
    <button id="send-btn" type="button">Send</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('messages-container');
    let emptyState = document.getElementById('empty-state');
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('send-btn');
    const clearBtn = document.getElementById('clear-btn');
    let inSession = false;

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function linkify(str) {
      const urlRegex = /(https?:\\/\\/[^\\s<>'"]+)/g;
      return str.split(urlRegex).map(part => {
        if (part.match(/^https?:\\/\\//)) {
          const esc = escapeHtml(part);
          return '<a href="' + esc + '" target="_blank" rel="noopener noreferrer" class="chat-link">' + esc + '</a>';
        }
        return escapeHtml(part);
      }).join('');
    }

    function formatTime(ts) {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    function hideEmptyState() {
      if (emptyState && emptyState.parentNode) {
        emptyState.remove();
      }
    }

    function showEmptyState(text) {
      hideEmptyState();
      emptyState = document.createElement('div');
      emptyState.id = 'empty-state';
      emptyState.className = 'empty-state';
      emptyState.textContent = text || (inSession ? 'No messages yet. Send a message to chat with your team!' : 'Join or share a session to chat with participants.');
      container.appendChild(emptyState);
    }

    function appendMessage(item) {
      if (!item || !item.id) return;
      if (document.getElementById(item.id)) {
        // Message with this id already present in DOM - do NOT render multiple times!
        return;
      }
      hideEmptyState();
      const el = document.createElement('div');
      el.id = item.id;
      el.setAttribute('data-id', item.id);
      el.className = 'chat-msg ' + (item.isSelf ? 'self' : 'remote');

      const header = document.createElement('div');
      header.className = 'msg-header';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = item.fromName;
      header.appendChild(nameSpan);

      const metaSpan = document.createElement('span');
      metaSpan.className = 'msg-meta';

      if (item.ts) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'msg-time';
        timeSpan.textContent = formatTime(item.ts);
        metaSpan.appendChild(timeSpan);
      }

      const delBtn = document.createElement('button');
      delBtn.className = 'msg-delete-btn';
      delBtn.type = 'button';
      delBtn.title = 'Delete message locally';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteMessage', id: item.id });
      });
      metaSpan.appendChild(delBtn);

      header.appendChild(metaSpan);
      el.appendChild(header);

      const body = document.createElement('div');
      body.className = 'msg-body';
      body.innerHTML = linkify(item.text);
      el.appendChild(body);

      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
    }

    function appendSystemMessage(text) {
      hideEmptyState();
      const el = document.createElement('div');
      el.className = 'chat-msg system';
      el.textContent = text;
      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
    }

    function send() {
      const text = input.value;
      if (text && text.trim().length > 0) {
        vscode.postMessage({ type: 'sendMessage', text: text });
        input.value = '';
      }
    }

    btn.addEventListener('click', send);
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'clearChat' });
      });
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        send();
      }
    });

    document.addEventListener('click', (e) => {
      const target = e.target.closest('a');
      if (target && target.href) {
        vscode.postMessage({ type: 'openLink', url: target.href });
        e.preventDefault();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'setSessionState') {
        inSession = !!msg.inSession;
        if (!inSession && container.children.length === 0) {
          showEmptyState('Join or share a session to chat with participants.');
        }
      } else if (msg.type === 'setHistory') {
        container.innerHTML = '';
        if (msg.messages && msg.messages.length > 0) {
          const seen = new Set();
          for (const item of msg.messages) {
            if (item && item.id && !seen.has(item.id)) {
              seen.add(item.id);
              appendMessage(item);
            }
          }
        } else {
          showEmptyState();
        }
      } else if (msg.type === 'addMessage') {
        appendMessage(msg.message);
      } else if (msg.type === 'deleteMessage') {
        const targetEl = document.getElementById(msg.id);
        if (targetEl) {
          targetEl.remove();
        }
        if (container.children.length === 0) {
          showEmptyState();
        }
      } else if (msg.type === 'addSystemMessage') {
        appendSystemMessage(msg.text);
      }
    });

    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    if (this.sessionDisposable) {
      this.sessionDisposable.dispose();
      this.sessionDisposable = null;
    }
    for (const d of this.sessionDisposables) {
      d.dispose();
    }
    this.sessionDisposables = [];
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
