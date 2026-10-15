import * as vscode from 'vscode';
import { ChatMessage, PROTOCOL_VERSION } from '@colive/protocol';
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
  private currentUserId = '';
  private currentUserName = '';
  private history: ChatMessageItem[] = [];
  private unreadCount = 0;
  private rateLimiter = new ChatRateLimiter(5);
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  public setSession(
    connection: ConnectionManager | null,
    userId: string,
    userName: string,
  ): void {
    this.connection = connection;
    this.currentUserId = userId;
    this.currentUserName = userName;
    this.history = [];
    this.unreadCount = 0;
    this.updateBadge();

    if (this.connection) {
      this.disposables.push(
        this.connection.on('message', (msg) => {
          if (msg.type === 'chat.message') {
            this.handleIncomingChatMessage(msg);
          }
        }) as unknown as vscode.Disposable,
      );
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

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
        case 'sendMessage': {
          await this.processOutgoingMessage(data.text);
          break;
        }
      }
    });

    // Replay session history
    for (const msg of this.history) {
      webviewView.webview.postMessage({ type: 'addMessage', message: msg });
    }
  }

  private async processOutgoingMessage(text: string): Promise<void> {
    if (!text || text.trim().length === 0) return;

    if (!this.rateLimiter.allow()) {
      this.view?.webview.postMessage({
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
      this.view?.webview.postMessage({
        type: 'addSystemMessage',
        text: 'Cannot send message: no active session.',
      });
      return;
    }

    const msg: ChatMessage = {
      v: PROTOCOL_VERSION,
      type: 'chat.message',
      fromId: this.currentUserId,
      fromName: this.currentUserName,
      text: trimmed,
      ts: Date.now(),
    };

    this.connection.send(msg);

    const item: ChatMessageItem = {
      id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromId: this.currentUserId,
      fromName: this.currentUserName,
      text: trimmed,
      ts: Date.now(),
      isSelf: true,
    };
    this.history.push(item);
    this.view?.webview.postMessage({ type: 'addMessage', message: item });
  }

  public async handleSlashCommand(commandText: string): Promise<boolean> {
    const parts = commandText.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const arg = parts.slice(1).join(' ');

    if (cmd === '/follow') {
      if (ALLOWED_SLASH_COMMANDS.has('colive.followParticipant')) {
        await vscode.commands.executeCommand('colive.followParticipant', arg || undefined);
        this.view?.webview.postMessage({
          type: 'addSystemMessage',
          text: `Executing /follow ${arg}...`,
        });
        return true;
      }
    }

    if (cmd === '/stopfollow') {
      if (ALLOWED_SLASH_COMMANDS.has('colive.stopFollowing')) {
        await vscode.commands.executeCommand('colive.stopFollowing');
        this.view?.webview.postMessage({
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
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
          const editor = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(lineNum, 0);
          editor.revealRange(new vscode.Range(pos, pos));
          this.view?.webview.postMessage({
            type: 'addSystemMessage',
            text: `Navigated to ${filePath}:${lineNum + 1}`,
          });
          return true;
        } catch (err) {
          this.view?.webview.postMessage({
            type: 'addSystemMessage',
            text: `Failed to open file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
          });
          return true;
        }
      }
    }

    return false;
  }

  private handleIncomingChatMessage(msg: ChatMessage): void {
    if (msg.fromId === this.currentUserId) return; // Skip own echoed messages

    const item: ChatMessageItem = {
      id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromId: msg.fromId,
      fromName: msg.fromName,
      text: msg.text,
      ts: msg.ts,
      isSelf: false,
    };

    this.history.push(item);
    this.view?.webview.postMessage({ type: 'addMessage', message: item });

    if (!this.view?.visible) {
      this.unreadCount++;
      this.updateBadge();
    }

    // Show notification for incoming chat messages
    const preview = msg.text.length > 60 ? `${msg.text.slice(0, 57)}...` : msg.text;
    vscode.window
      .showInformationMessage(`CoLive [${msg.fromName}]: ${preview}`, 'Open Chat')
      .then((action) => {
        if (action === 'Open Chat') {
          vscode.commands.executeCommand('colive.chatView.focus');
        }
      });
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

  private getHtmlForWebview(webview: vscode.Webview): string {
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
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .chat-msg {
      padding: 6px 10px;
      border-radius: 6px;
      max-width: 90%;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.4;
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
    }
    .msg-header {
      font-weight: bold;
      font-size: 11px;
      margin-bottom: 2px;
      opacity: 0.85;
    }
    .msg-body {
      white-space: pre-wrap;
    }
    .chat-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
    }
    #input-container {
      display: flex;
      padding: 8px;
      border-top: 1px solid var(--vscode-sideBar-border, #333);
      gap: 6px;
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
    }
    #send-btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div id="messages-container"></div>
  <div id="input-container">
    <input type="text" id="chat-input" placeholder="Type a message or /follow, /goto..." />
    <button id="send-btn">Send</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('messages-container');
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('send-btn');

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

    function appendMessage(item) {
      const el = document.createElement('div');
      el.className = 'chat-msg ' + (item.isSelf ? 'self' : 'remote');

      const header = document.createElement('div');
      header.className = 'msg-header';
      header.textContent = item.fromName;
      el.appendChild(header);

      const body = document.createElement('div');
      body.className = 'msg-body';
      body.innerHTML = linkify(item.text);
      el.appendChild(body);

      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
    }

    function appendSystemMessage(text) {
      const el = document.createElement('div');
      el.className = 'chat-msg system';
      el.textContent = text;
      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
    }

    function send() {
      const text = input.value;
      if (text.trim().length > 0) {
        vscode.postMessage({ type: 'sendMessage', text: text });
        input.value = '';
      }
    }

    btn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        send();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'addMessage') {
        appendMessage(msg.message);
      } else if (msg.type === 'addSystemMessage') {
        appendSystemMessage(msg.text);
      }
    });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
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
