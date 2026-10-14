import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  BINARY_FRAME_KINDS,
  decodeBinaryFrame,
  encodeBinaryFrame,
  normalizeWorkspacePath,
  Role,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { SyncManager } from '../sync/SyncManager.js';
import { throttleTrailing } from './throttle.js';
import { Logger } from '../logger.js';

export interface UserPresenceState {
  user: {
    id: string;
    name: string;
    color: string;
  };
  activeFile?: string;
  cursor?: {
    line: number;
    character: number;
    relPosBase64?: string;
  };
  selections?: Array<{
    anchor: { line: number; character: number };
    active: { line: number; character: number };
  }>;
  viewport?: {
    startLine: number;
    endLine: number;
  };
  lastActive: number;
  typingUntil: number;
}

export interface PresenceManagerOptions {
  connection: ConnectionManager;
  role: Role;
  userId: string;
  userName: string;
  userColor: string;
  workspaceRoot?: string;
  syncManager?: SyncManager;
}

/**
 * Manages user presence, remote cursors, selections, viewports, and typing indicators
 * across a collaboration session using the Yjs Awareness protocol.
 */
export class PresenceManager implements vscode.Disposable {
  private connection: ConnectionManager;
  private role: Role;
  private userId: string;
  private userName: string;
  private userColor: string;
  private workspaceRoot?: string;
  private syncManager?: SyncManager;

  public readonly awareness: awarenessProtocol.Awareness;
  private disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  private _onDidChangePresence = new vscode.EventEmitter<Map<string, UserPresenceState>>();
  public readonly onDidChangePresence = this._onDidChangePresence.event;

  // Throttled publish methods
  private throttledPublishSelection: () => void;
  private throttledPublishViewport: () => void;
  private lastBroadcastTime = 0;
  private pendingBroadcastUpdate: Uint8Array | null = null;
  private broadcastThrottleTimer: NodeJS.Timeout | null = null;

  constructor(options: PresenceManagerOptions) {
    this.connection = options.connection;
    this.role = options.role;
    this.userId = options.userId;
    this.userName = options.userName;
    this.userColor = options.userColor;
    this.workspaceRoot = options.workspaceRoot;
    this.syncManager = options.syncManager;

    const dummyDoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(dummyDoc);

    // Initial local presence state
    this.awareness.setLocalState({
      user: {
        id: this.userId,
        name: this.userName,
        color: this.userColor,
      },
      lastActive: Date.now(),
      typingUntil: 0,
    } as UserPresenceState);

    this.throttledPublishSelection = throttleTrailing(() => {
      this.publishSelection();
    }, 50);

    this.throttledPublishViewport = throttleTrailing(() => {
      this.publishViewport();
    }, 150);

    this.setupNetworkListeners();
    this.setupEditorListeners();
    this.setupAwarenessListener();

    // Publish initial active editor state if any
    this.publishActiveEditor(vscode.window.activeTextEditor);
  }

  public getStates(): Map<string, UserPresenceState> {
    const statesMap = new Map<string, UserPresenceState>();
    const now = Date.now();

    for (const state of this.awareness.getStates().values()) {
      const presence = state as UserPresenceState;
      if (presence?.user?.id) {
        // Mark stale (> 30s) or idle (> 60s)
        const isStale = now - presence.lastActive > 30_000;
        if (!isStale) {
          statesMap.set(presence.user.id, presence);
        }
      }
    }
    return statesMap;
  }

  private setupAwarenessListener(): void {
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated).concat(removed);
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
      this.queueBroadcastUpdate(update);
      this._onDidChangePresence.fire(this.getStates());
    });
  }

  private queueBroadcastUpdate(update: Uint8Array): void {
    const now = Date.now();
    const minInterval = 50; // max 20 msgs/s

    if (now - this.lastBroadcastTime >= minInterval) {
      this.lastBroadcastTime = now;
      this.sendAwarenessFrame(update);
    } else {
      this.pendingBroadcastUpdate = update;
      if (!this.broadcastThrottleTimer) {
        this.broadcastThrottleTimer = setTimeout(() => {
          this.broadcastThrottleTimer = null;
          this.lastBroadcastTime = Date.now();
          if (this.pendingBroadcastUpdate) {
            this.sendAwarenessFrame(this.pendingBroadcastUpdate);
            this.pendingBroadcastUpdate = null;
          }
        }, minInterval - (now - this.lastBroadcastTime));
      }
    }
  }

  private sendAwarenessFrame(payload: Uint8Array): void {
    const frame = encodeBinaryFrame(BINARY_FRAME_KINDS.AWARENESS, '', payload);
    this.connection.sendBinary(frame);
  }

  private setupNetworkListeners(): void {
    this.connection.on('binary', (data: Uint8Array) => {
      try {
        const decoded = decodeBinaryFrame(data);
        if (decoded.kind === BINARY_FRAME_KINDS.AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoded.payload, 'remote');
        }
      } catch (err: unknown) {
        Logger.error('Failed to apply awareness update', err);
      }
    });

    this.connection.on('reconnected', () => {
      // Re-announce presence after reconnect
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);
      this.sendAwarenessFrame(update);
    });
  }

  private normalizeDocumentPath(doc: vscode.TextDocument): string | undefined {
    if (this.role === 'host' && doc.uri.scheme === 'file') {
      if (!this.workspaceRoot) return undefined;
      const fsPath = doc.uri.fsPath;
      if (!fsPath.startsWith(this.workspaceRoot)) return undefined;
      const rel = fsPath.slice(this.workspaceRoot.length).replace(/^[/\\]+/, '');
      return normalizeWorkspacePath(rel);
    } else if (this.role === 'guest' && doc.uri.scheme === 'colive') {
      let p = doc.uri.path.replace(/^\/+/, '');
      const firstSlash = p.indexOf('/');
      if (firstSlash >= 0) p = p.slice(firstSlash + 1);
      return normalizeWorkspacePath(p);
    }
    return undefined;
  }

  private setupEditorListeners(): void {
    // 1. Active editor change
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.publishActiveEditor(editor);
      }),
    );

    // 2. Selection / cursor change
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.throttledPublishSelection();
        }
      }),
    );

    // 3. Visible ranges change (viewport)
    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.throttledPublishViewport();
        }
      }),
    );

    // 4. Typing indicator on document change
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document === e.document) {
          this.recordTyping();
        }
      }),
    );
  }

  public recordTyping(): void {
    const currentState = (this.awareness.getLocalState() as UserPresenceState) || {};
    this.awareness.setLocalState({
      ...currentState,
      lastActive: Date.now(),
      typingUntil: Date.now() + 1500, // typing for 1.5 s
    });
  }

  private publishActiveEditor(editor?: vscode.TextEditor): void {
    if (!editor) {
      const current = (this.awareness.getLocalState() as UserPresenceState) || {};
      this.awareness.setLocalState({
        ...current,
        activeFile: undefined,
        cursor: undefined,
        selections: undefined,
        viewport: undefined,
        lastActive: Date.now(),
      });
      return;
    }

    const relPath = this.normalizeDocumentPath(editor.document);
    this.updatePresenceForEditor(editor, relPath);
  }

  private publishSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const relPath = this.normalizeDocumentPath(editor.document);
    this.updatePresenceForEditor(editor, relPath);
  }

  private publishViewport(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const relPath = this.normalizeDocumentPath(editor.document);
    this.updatePresenceForEditor(editor, relPath);
  }

  private updatePresenceForEditor(editor: vscode.TextEditor, relPath?: string): void {
    const primarySel = editor.selection;
    const cursorPos = primarySel ? { line: primarySel.active.line, character: primarySel.active.character } : undefined;

    let relPosBase64: string | undefined;
    if (cursorPos && relPath && this.syncManager) {
      const ytext = this.syncManager.getYText(relPath);
      if (ytext) {
        const offset = editor.document.offsetAt(primarySel.active);
        const relPos = Y.createRelativePositionFromTypeIndex(ytext, offset);
        const encoded = Y.encodeRelativePosition(relPos);
        relPosBase64 = Buffer.from(encoded).toString('base64');
      }
    }

    const selections = editor.selections.map((s) => ({
      anchor: { line: s.anchor.line, character: s.anchor.character },
      active: { line: s.active.line, character: s.active.character },
    }));

    const visibleRange = editor.visibleRanges[0];
    const viewport = visibleRange
      ? { startLine: visibleRange.start.line, endLine: visibleRange.end.line }
      : undefined;

    const current = (this.awareness.getLocalState() as UserPresenceState) || {};
    this.awareness.setLocalState({
      ...current,
      user: {
        id: this.userId,
        name: this.userName,
        color: this.userColor,
      },
      activeFile: relPath,
      cursor: cursorPos ? { ...cursorPos, relPosBase64 } : undefined,
      selections,
      viewport,
      lastActive: Date.now(),
    });
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.broadcastThrottleTimer) {
      clearTimeout(this.broadcastThrottleTimer);
      this.broadcastThrottleTimer = null;
    }

    // Set local state to null to signal leaving
    this.awareness.setLocalState(null);

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this._onDidChangePresence.dispose();
  }
}
