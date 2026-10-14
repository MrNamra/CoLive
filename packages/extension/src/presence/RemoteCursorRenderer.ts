import * as vscode from 'vscode';
import * as Y from 'yjs';
import { PresenceManager, UserPresenceState } from './PresenceManager.js';
import { SyncManager } from '../sync/SyncManager.js';
import { normalizeWorkspacePath } from '@colive/protocol';

interface ParticipantDecorations {
  selectionType: vscode.TextEditorDecorationType;
  caretType: vscode.TextEditorDecorationType;
  labelType: vscode.TextEditorDecorationType;
  lastPosition?: { line: number; character: number };
  labelFadeTimeout?: NodeJS.Timeout;
}

export function hexToRgba(hexColor: string, alpha: number): string {
  const hex = hexColor.replace(/^#/, '');
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getContrastingTextColor(hexColor: string): '#000000' | '#ffffff' {
  const hex = hexColor.replace(/^#/, '');
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#000000' : '#ffffff';
}

export function clampPositionToDocument(pos: vscode.Position, doc: vscode.TextDocument): vscode.Position {
  const lineCount = Math.max(1, doc.lineCount);
  const clampedLine = Math.max(0, Math.min(pos.line, lineCount - 1));
  const lineText = doc.lineAt(clampedLine).text;
  const clampedChar = Math.max(0, Math.min(pos.character, lineText.length));
  return new vscode.Position(clampedLine, clampedChar);
}

/**
 * Renders remote carets, selection highlights, and participant name labels
 * with contrast luminance, overview ruler lanes, relative position resolution,
 * and boundary clamping.
 */
export class RemoteCursorRenderer implements vscode.Disposable {
  private presenceManager: PresenceManager;
  private syncManager?: SyncManager;
  private currentUserId: string;
  private workspaceRoot?: string;

  private participantDecorations: Map<string, ParticipantDecorations> = new Map();
  private disposables: vscode.Disposable[] = [];
  private renderScheduled = false;
  private isDisposed = false;

  constructor(
    presenceManager: PresenceManager,
    currentUserId: string,
    syncManager?: SyncManager,
    workspaceRoot?: string,
  ) {
    this.presenceManager = presenceManager;
    this.currentUserId = currentUserId;
    this.syncManager = syncManager;
    this.workspaceRoot = workspaceRoot;

    this.disposables.push(
      this.presenceManager.onDidChangePresence(() => {
        this.scheduleRender();
      }),
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.scheduleRender();
      }),
    );

    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges(() => {
        this.scheduleRender();
      }),
    );

    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderScheduled || this.isDisposed) return;
    this.renderScheduled = true;

    setTimeout(() => {
      this.renderScheduled = false;
      this.renderAll();
    }, 16); // 1 tick (~60fps)
  }

  public renderAll(): void {
    if (this.isDisposed) return;
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) return;

    const currentDoc = activeEditor.document;
    const currentRelPath = this.normalizeDocumentPath(currentDoc);
    if (!currentRelPath) return;

    const presenceStates = this.presenceManager.getStates();
    const activeParticipantIds = new Set<string>();

    for (const [userId, state] of presenceStates.entries()) {
      if (userId === this.currentUserId) continue; // Skip local user
      activeParticipantIds.add(userId);

      const decorations = this.getOrCreateDecorations(userId, state.user.name, state.user.color);

      // Only render if the remote user has the same file active
      if (state.activeFile === currentRelPath) {
        this.renderParticipant(activeEditor, decorations, state);
      } else {
        this.clearParticipantDecorations(activeEditor, decorations);
      }
    }

    // Cleanup decorations for departed participants
    for (const [userId, decs] of this.participantDecorations.entries()) {
      if (!activeParticipantIds.has(userId)) {
        this.disposeParticipantDecorations(decs);
        this.participantDecorations.delete(userId);
      }
    }
  }

  private renderParticipant(
    editor: vscode.TextEditor,
    decs: ParticipantDecorations,
    state: UserPresenceState,
  ): void {
    const doc = editor.document;
    let caretPos: vscode.Position | undefined;

    // 1. Resolve cursor position (prefer Y.RelativePosition if available)
    if (state.cursor) {
      if (state.cursor.relPosBase64 && this.syncManager && state.activeFile) {
        try {
          const ydoc = this.syncManager.getDoc(state.activeFile);
          if (ydoc) {
            const rawBytes = Buffer.from(state.cursor.relPosBase64, 'base64');
            const relPos = Y.decodeRelativePosition(rawBytes);
            const abs = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
            if (abs) {
              caretPos = doc.positionAt(abs.index);
            }
          }
        } catch {
          // Fall through to plain line & character
        }
      }

      if (!caretPos) {
        caretPos = this.clampPosition(doc, state.cursor.line, state.cursor.character);
      }
    }

    // 2. Render Caret & Label
    if (caretPos) {
      const caretRange = new vscode.Range(caretPos, caretPos);
      editor.setDecorations(decs.caretType, [caretRange]);

      // Detect cursor movement to refresh name label visibility
      const hasMoved =
        !decs.lastPosition ||
        decs.lastPosition.line !== caretPos.line ||
        decs.lastPosition.character !== caretPos.character;

      if (hasMoved) {
        decs.lastPosition = { line: caretPos.line, character: caretPos.character };
        editor.setDecorations(decs.labelType, [caretRange]);

        if (decs.labelFadeTimeout) {
          clearTimeout(decs.labelFadeTimeout);
        }
        // Fade name label after 3 seconds of inactivity
        decs.labelFadeTimeout = setTimeout(() => {
          if (!this.isDisposed && vscode.window.activeTextEditor === editor) {
            editor.setDecorations(decs.labelType, []);
          }
        }, 3000);
      }
    } else {
      editor.setDecorations(decs.caretType, []);
      editor.setDecorations(decs.labelType, []);
    }

    // 3. Render Selection highlights
    const selectionRanges: vscode.Range[] = [];
    if (state.selections) {
      for (const sel of state.selections) {
        const p1 = this.clampPosition(doc, sel.anchor.line, sel.anchor.character);
        const p2 = this.clampPosition(doc, sel.active.line, sel.active.character);
        if (!p1.isEqual(p2)) {
          selectionRanges.push(new vscode.Range(p1, p2));
        }
      }
    }
    editor.setDecorations(decs.selectionType, selectionRanges);
  }

  public clampPosition(doc: vscode.TextDocument, line: number, character: number): vscode.Position {
    return clampPositionToDocument(new vscode.Position(line, character), doc);
  }

  public render(): void {
    this.renderAll();
  }

  public onParticipantLeft(userId: string): void {
    const decs = this.participantDecorations.get(userId);
    if (decs) {
      this.disposeParticipantDecorations(decs);
      this.participantDecorations.delete(userId);
    }
  }

  public getUserCount(): number {
    return this.participantDecorations.size;
  }

  private clearParticipantDecorations(editor: vscode.TextEditor, decs: ParticipantDecorations): void {
    editor.setDecorations(decs.caretType, []);
    editor.setDecorations(decs.labelType, []);
    editor.setDecorations(decs.selectionType, []);
  }

  private getOrCreateDecorations(
    userId: string,
    name: string,
    color: string,
  ): ParticipantDecorations {
    let decs = this.participantDecorations.get(userId);
    if (decs) return decs;

    const selectionColor = hexToRgba(color, 0.25);
    const textColor = getContrastingTextColor(color);

    const selectionType = vscode.window.createTextEditorDecorationType({
      backgroundColor: selectionColor,
    });

    const caretType = vscode.window.createTextEditorDecorationType({
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      borderColor: color,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    const labelType = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: ` ${name} `,
        backgroundColor: color,
        color: textColor,
        fontWeight: 'bold',
        fontSize: '11px',
        margin: '0 0 0 3px',
      },
    });

    decs = {
      selectionType,
      caretType,
      labelType,
    };
    this.participantDecorations.set(userId, decs);
    return decs;
  }

  private disposeParticipantDecorations(decs: ParticipantDecorations): void {
    if (decs.labelFadeTimeout) {
      clearTimeout(decs.labelFadeTimeout);
    }
    decs.selectionType.dispose();
    decs.caretType.dispose();
    decs.labelType.dispose();
  }

  private normalizeDocumentPath(doc: vscode.TextDocument): string | undefined {
    if (doc.uri.scheme === 'file') {
      if (!this.workspaceRoot) return undefined;
      const fsPath = doc.uri.fsPath;
      if (!fsPath.startsWith(this.workspaceRoot)) return undefined;
      const rel = fsPath.slice(this.workspaceRoot.length).replace(/^[/\\]+/, '');
      return normalizeWorkspacePath(rel);
    } else if (doc.uri.scheme === 'colive') {
      let p = doc.uri.path.replace(/^\/+/, '');
      const firstSlash = p.indexOf('/');
      if (firstSlash >= 0) p = p.slice(firstSlash + 1);
      return normalizeWorkspacePath(p);
    }
    return undefined;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const decs of this.participantDecorations.values()) {
      this.disposeParticipantDecorations(decs);
    }
    this.participantDecorations.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
