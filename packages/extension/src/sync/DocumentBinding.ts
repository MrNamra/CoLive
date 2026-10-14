import * as vscode from 'vscode';
import * as Y from 'yjs';
import { Logger } from '../logger.js';

export interface DocumentBindingOptions {
  document: vscode.TextDocument;
  ydoc: Y.Doc;
  ytext?: Y.Text;
  isReadOnly?: boolean;
  onDidLocalChange?: () => void;
}

/**
 * Bi-directional binding between a VS Code TextDocument and a Y.Text CRDT.
 * Handles local-to-CRDT translations, remote delta application, echo prevention,
 * UTF-16 offset mapping, and automatic drift recovery.
 */
export class DocumentBinding implements vscode.Disposable {
  public readonly document: vscode.TextDocument;
  public readonly ydoc: Y.Doc;
  public readonly ytext: Y.Text;

  private isReadOnly: boolean;
  private applyingRemote = false;
  private disposables: vscode.Disposable[] = [];
  private periodicCheckTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private onDidLocalChange?: () => void;
  private observer: (event: Y.YTextEvent, tr: Y.Transaction) => void;

  constructor(options: DocumentBindingOptions) {
    this.document = options.document;
    this.ydoc = options.ydoc;
    this.ytext = options.ytext ?? this.ydoc.getText('content');
    this.isReadOnly = options.isReadOnly ?? false;
    this.onDidLocalChange = options.onDidLocalChange;

    this.observer = this.handleYTextEvent.bind(this);
    this.ytext.observe(this.observer);

    // Initial synchronization check
    this.performInitialSync();

    // Listen to local VS Code text document changes
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(this.handleDocumentChange.bind(this)),
    );

    // Periodic safety check every 5 seconds for document drift
    this.periodicCheckTimer = setInterval(() => {
      if (!this.isDisposed && !this.applyingRemote) {
        this.verifyAndResync();
      }
    }, 5000);
  }

  public setReadOnly(isReadOnly: boolean): void {
    this.isReadOnly = isReadOnly;
  }

  private performInitialSync(): void {
    const editorText = this.document.getText();
    const ytextContent = this.ytext.toString();

    if (ytextContent.length === 0 && editorText.length > 0) {
      // Host or initial opener populating Y.Text from document
      const normalized = editorText.replace(/\r\n/g, '\n');
      this.ydoc.transact(() => {
        this.ytext.insert(0, normalized);
      }, 'disk');
    } else if (ytextContent.length > 0 && editorText !== ytextContent) {
      // Remote content exists; update local editor to match
      this.forceFullResync();
    }
  }

  /**
   * Handle changes originating in the local VS Code editor.
   */
  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (this.isDisposed || this.applyingRemote) return;
    if (event.document.uri.toString() !== this.document.uri.toString()) return;
    if (event.contentChanges.length === 0) return;

    if (this.isReadOnly) {
      Logger.warn(`Local edit rejected on read-only document: ${this.document.uri.path}`);
      this.forceFullResync();
      return;
    }

    // Sort descending by rangeOffset so subsequent offsets remain valid
    const changes = [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);

    this.ydoc.transact(() => {
      for (const change of changes) {
        if (change.rangeLength > 0) {
          this.ytext.delete(change.rangeOffset, change.rangeLength);
        }
        if (change.text.length > 0) {
          const normalized = change.text.replace(/\r\n/g, '\n');
          this.ytext.insert(change.rangeOffset, normalized);
        }
      }
    }, 'local-editor');

    if (this.onDidLocalChange) {
      this.onDidLocalChange();
    }
  }

  /**
   * Handle changes originating from remote peers or disk merges in Y.Text.
   */
  private handleYTextEvent(event: Y.YTextEvent, tr: Y.Transaction): void {
    if (this.isDisposed) return;
    if (tr.origin === 'local-editor') return; // Echo prevention: ignore local edits

    this.applyDeltaToDocument(event.delta);
  }

  private async applyDeltaToDocument(delta: Array<{ retain?: number; delete?: number; insert?: string | unknown }>): Promise<void> {
    const edits: Array<{ offset: number; length: number; text: string }> = [];
    let index = 0;

    for (let i = 0; i < delta.length; i++) {
      const item = delta[i];
      if (item.retain !== undefined) {
        index += item.retain;
      } else if (item.delete !== undefined) {
        const deleteLen = item.delete;
        let insertText = '';
        if (i + 1 < delta.length && delta[i + 1].insert !== undefined) {
          insertText = typeof delta[i + 1].insert === 'string' ? delta[i + 1].insert : '';
          i++; // Consumed insertion paired with deletion (replacement)
        }
        edits.push({ offset: index, length: deleteLen, text: insertText });
        index += deleteLen;
      } else if (item.insert !== undefined) {
        const insertText = typeof item.insert === 'string' ? item.insert : '';
        edits.push({ offset: index, length: 0, text: insertText });
      }
    }

    if (edits.length === 0) return;

    // Sort descending by offset so that edits apply cleanly
    edits.sort((a, b) => b.offset - a.offset);

    const textEdits: vscode.TextEdit[] = [];
    for (const edit of edits) {
      const startPos = this.document.positionAt(edit.offset);
      const endPos = this.document.positionAt(edit.offset + edit.length);
      textEdits.push(vscode.TextEdit.replace(new vscode.Range(startPos, endPos), edit.text));
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(this.document.uri, textEdits);

    this.applyingRemote = true;
    try {
      const success = await vscode.workspace.applyEdit(workspaceEdit);
      if (!success) {
        await this.forceFullResync();
      }
    } catch {
      await this.forceFullResync();
    } finally {
      this.applyingRemote = false;
      this.verifyAndResync();
    }
  }

  public async forceFullResync(): Promise<void> {
    const currentText = this.document.getText();
    const targetText = this.ytext.toString();
    if (currentText === targetText) return;

    const fullRange = new vscode.Range(
      this.document.positionAt(0),
      this.document.positionAt(currentText.length),
    );

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(this.document.uri, [vscode.TextEdit.replace(fullRange, targetText)]);

    this.applyingRemote = true;
    try {
      await vscode.workspace.applyEdit(workspaceEdit);
    } catch (err: unknown) {
      Logger.error('Failed to force full resync on document', err);
    } finally {
      this.applyingRemote = false;
    }
  }

  private verifyAndResync(): void {
    const editorLen = this.document.getText().length;
    const ytextLen = this.ytext.toString().length;
    if (this.document.getText() !== this.ytext.toString()) {
      Logger.warn(
        `Desynchronization detected for ${this.document.uri.path} (editor: ${editorLen} chars, crdt: ${ytextLen} chars). Resynchronizing.`,
      );
      this.forceFullResync();
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.periodicCheckTimer) {
      clearInterval(this.periodicCheckTimer);
      this.periodicCheckTimer = null;
    }

    this.ytext.unobserve(this.observer);

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
