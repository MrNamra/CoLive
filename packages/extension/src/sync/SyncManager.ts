import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  BINARY_FRAME_KINDS,
  decodeBinaryFrame,
  DocOpenReq,
  DocOpenRes,
  encodeBinaryFrame,
  hashDocId,
  normalizeWorkspacePath,
  PROTOCOL_VERSION,
  Role,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { DocumentBinding } from './DocumentBinding.js';
import { HostPersistence } from '../host/persistence.js';
import { Logger } from '../logger.js';

export interface SyncManagerOptions {
  connection: ConnectionManager;
  role: Role;
  workspaceRoot?: string;
  isReadOnly?: boolean;
}

interface ManagedDoc {
  docId: string;
  relPath: string;
  ydoc: Y.Doc;
  binding?: DocumentBinding;
  closeTimeout?: NodeJS.Timeout;
}

/**
 * Coordinates Yjs documents, bi-directional editor bindings, network binary frame routing,
 * host persistence, and document lifecycle.
 */
export class SyncManager implements vscode.Disposable {
  private connection: ConnectionManager;
  public readonly role: Role;
  private workspaceRoot?: string;
  private isReadOnly: boolean;

  private docs: Map<string, ManagedDoc> = new Map(); // Keyed by docId
  private pathToDocId: Map<string, string> = new Map(); // Keyed by normalized relPath
  private hostPersistence?: HostPersistence;
  private disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  constructor(options: SyncManagerOptions) {
    this.connection = options.connection;
    this.role = options.role;
    this.workspaceRoot = options.workspaceRoot;
    this.isReadOnly = options.isReadOnly ?? false;

    if (this.role === 'host' && this.workspaceRoot) {
      this.hostPersistence = new HostPersistence({
        workspaceRoot: this.workspaceRoot,
        connection: this.connection,
      });
      this.disposables.push(this.hostPersistence);
      this.setupHostRpcHandler();
    }

    this.setupNetworkListeners();
    this.setupEditorListeners();
  }

  public setReadOnly(isReadOnly: boolean): void {
    this.isReadOnly = isReadOnly;
    for (const managed of this.docs.values()) {
      managed.binding?.setReadOnly(isReadOnly);
    }
  }

  public getYText(relPath: string): Y.Text | undefined {
    const docId = this.pathToDocId.get(relPath);
    if (!docId) return undefined;
    const managed = this.docs.get(docId);
    return managed?.ydoc.getText('content');
  }

  public getDoc(docId: string): Y.Doc | undefined {
    return this.docs.get(docId)?.ydoc;
  }

  private setupNetworkListeners(): void {
    // 1. Incoming binary frames (CRDT updates)
    this.connection.on('binary', (data: Uint8Array) => {
      try {
        const decoded = decodeBinaryFrame(data);
        if (decoded.kind === BINARY_FRAME_KINDS.DOC_UPDATE) {
          this.handleIncomingDocUpdate(decoded.docId, decoded.payload);
        }
      } catch (err: unknown) {
        Logger.error('Failed to process incoming binary frame', err);
      }
    });

    // 2. Full state-vector resync on reconnect
    this.connection.on('reconnected', () => {
      Logger.info('Connection re-established. Initiating full state-vector resync for open docs.');
      for (const [docId, managed] of this.docs.entries()) {
        this.sendSyncStep1(docId, managed.ydoc);
      }
    });
  }

  private setupEditorListeners(): void {
    // Auto-bind when text document opens
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        this.handleEditorDocumentOpened(doc);
      }),
    );

    // Auto-schedule release when text document closes
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.handleEditorDocumentClosed(doc);
      }),
    );
  }

  private setupHostRpcHandler(): void {
    this.connection.on('message', async (msg) => {
      if (msg.type === 'doc.open.req') {
        const req = msg as DocOpenReq;
        try {
          const relPath = normalizeWorkspacePath(req.path);
          const docId = hashDocId(relPath);
          await this.ensureManagedDoc(relPath, docId);

          const res: DocOpenRes = {
            v: PROTOCOL_VERSION,
            type: 'doc.open.res',
            id: req.id,
            docId,
            initialStateVectorRequired: true,
          };
          this.connection.sendJson(res);
        } catch (err: unknown) {
          Logger.error(`Host failed to handle doc.open.req for ${req.path}`, err);
        }
      }
    });
  }

  private extractRelativePath(doc: vscode.TextDocument): string | null {
    if (this.role === 'host' && doc.uri.scheme === 'file') {
      if (!this.workspaceRoot) return null;
      const fsPath = doc.uri.fsPath;
      if (!fsPath.startsWith(this.workspaceRoot)) return null;
      const rel = fsPath.slice(this.workspaceRoot.length).replace(/^[/\\]+/, '');
      return normalizeWorkspacePath(rel);
    } else if (this.role === 'guest' && doc.uri.scheme === 'colive') {
      let p = doc.uri.path.replace(/^\/+/, '');
      const firstSlash = p.indexOf('/');
      if (firstSlash >= 0) p = p.slice(firstSlash + 1);
      return normalizeWorkspacePath(p);
    }
    return null;
  }

  public async handleEditorDocumentOpened(doc: vscode.TextDocument): Promise<DocumentBinding | null> {
    const relPath = this.extractRelativePath(doc);
    if (!relPath) return null;

    let docId = this.pathToDocId.get(relPath);
    if (!docId) {
      if (this.role === 'guest') {
        try {
          const res = await this.connection.request<DocOpenRes>({
            v: PROTOCOL_VERSION,
            type: 'doc.open.req',
            id: `open_${Math.random().toString(36).slice(2, 9)}`,
            path: relPath,
          });
          docId = res.docId;
        } catch (err: unknown) {
          Logger.error(`Failed to request doc.open for ${relPath}`, err);
          return null;
        }
      } else {
        docId = hashDocId(relPath);
      }
    }

    const managed = await this.ensureManagedDoc(relPath, docId);

    // Cancel any pending close release timer
    if (managed.closeTimeout) {
      clearTimeout(managed.closeTimeout);
      managed.closeTimeout = undefined;
    }

    if (!managed.binding) {
      managed.binding = new DocumentBinding({
        document: doc,
        ydoc: managed.ydoc,
        isReadOnly: this.isReadOnly,
      });
    }

    // If guest, send Sync Step 1 to request host document state
    if (this.role === 'guest') {
      this.sendSyncStep1(docId, managed.ydoc);
    }

    return managed.binding;
  }

  private handleEditorDocumentClosed(doc: vscode.TextDocument): void {
    const relPath = this.extractRelativePath(doc);
    if (!relPath) return;

    const docId = this.pathToDocId.get(relPath);
    if (!docId) return;

    const managed = this.docs.get(docId);
    if (!managed) return;

    if (managed.binding) {
      managed.binding.dispose();
      managed.binding = undefined;
    }

    // Inform relay of doc close
    this.connection.sendJson({
      v: PROTOCOL_VERSION,
      type: 'doc.close',
      docId,
    });

    // Release Y.Doc 30 s after no local editor has it open
    if (managed.closeTimeout) {
      clearTimeout(managed.closeTimeout);
    }

    managed.closeTimeout = setTimeout(() => {
      this.releaseDoc(docId);
    }, 30_000);
  }

  public async ensureManagedDoc(relPath: string, docId: string): Promise<ManagedDoc> {
    let managed = this.docs.get(docId);
    if (managed) return managed;

    const ydoc = new Y.Doc();

    // Hook local / disk updates to transmit to network
    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'local-editor' || origin === 'disk') {
        const encoder = encoding.createEncoder();
        sync.writeUpdate(encoder, update);
        const payload = encoding.toUint8Array(encoder);

        const frame = encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, docId, payload);
        this.connection.sendBinary(frame);

        if (this.role === 'host' && this.hostPersistence) {
          this.hostPersistence.scheduleSave(relPath, docId, ydoc);
        }
      }
    });

    managed = {
      docId,
      relPath,
      ydoc,
    };

    this.docs.set(docId, managed);
    this.pathToDocId.set(relPath, docId);

    return managed;
  }

  private sendSyncStep1(docId: string, ydoc: Y.Doc): void {
    const encoder = encoding.createEncoder();
    sync.writeSyncStep1(encoder, ydoc);
    const frame = encodeBinaryFrame(
      BINARY_FRAME_KINDS.DOC_UPDATE,
      docId,
      encoding.toUint8Array(encoder),
    );
    this.connection.sendBinary(frame);
  }

  private handleIncomingDocUpdate(docId: string, payload: Uint8Array): void {
    const managed = this.docs.get(docId);
    if (!managed) {
      // Document not currently open
      return;
    }

    const replyEncoder = encoding.createEncoder();
    sync.readSyncMessage(decoding.createDecoder(payload), replyEncoder, managed.ydoc, 'remote');

    if (encoding.length(replyEncoder) > 0) {
      const replyFrame = encodeBinaryFrame(
        BINARY_FRAME_KINDS.DOC_UPDATE,
        docId,
        encoding.toUint8Array(replyEncoder),
      );
      this.connection.sendBinary(replyFrame);
    }
  }

  private releaseDoc(docId: string): void {
    const managed = this.docs.get(docId);
    if (!managed) return;

    if (managed.closeTimeout) {
      clearTimeout(managed.closeTimeout);
    }
    managed.binding?.dispose();
    managed.ydoc.destroy();

    this.docs.delete(docId);
    this.pathToDocId.delete(managed.relPath);
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const managed of this.docs.values()) {
      if (managed.closeTimeout) {
        clearTimeout(managed.closeTimeout);
      }
      managed.binding?.dispose();
      managed.ydoc.destroy();
    }
    this.docs.clear();
    this.pathToDocId.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
