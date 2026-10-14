import * as vscode from 'vscode';
import crypto from 'node:crypto';
import {
  ColiveMessage,
  PROTOCOL_VERSION,
  TerminalClose,
  TerminalData,
  TerminalInput,
  TerminalOpenReq,
  TerminalOpenRes,
  TerminalResize,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';

export interface GuestTerminalInstance {
  terminalId: string;
  terminal: vscode.Terminal;
  writeEmitter: vscode.EventEmitter<string>;
  closeEmitter: vscode.EventEmitter<number | void>;
  dispose: () => void;
}

export class GuestTerminalService implements vscode.Disposable {
  private terminals = new Map<string, GuestTerminalInstance>();
  private pendingRequests = new Map<string, (res: TerminalOpenRes) => void>();
  private disposables: vscode.Disposable[] = [];
  private isReadOnly = false;

  constructor(private connectionManager: ConnectionManager) {
    this.disposables.push(
      this.connectionManager.onMessage((msg) => this.handleMessage(msg)),
    );
  }

  public setReadOnly(readOnly: boolean): void {
    this.isReadOnly = readOnly;
  }

  public async openSharedTerminal(name = 'CoLive Shared Terminal'): Promise<GuestTerminalInstance> {
    const reqId = `term_req_${crypto.randomBytes(6).toString('hex')}`;
    const openReq: TerminalOpenReq = {
      v: PROTOCOL_VERSION,
      type: 'terminal.open.req',
      id: reqId,
      name,
    };

    const responsePromise = new Promise<TerminalOpenRes>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error('Timed out waiting for host to open shared terminal'));
      }, 10_000);

      this.pendingRequests.set(reqId, (res) => {
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        resolve(res);
      });
    });

    this.connectionManager.send(openReq);
    const res = await responsePromise;
    const terminalId = res.terminalId;

    if (this.terminals.has(terminalId)) {
      const existing = this.terminals.get(terminalId)!;
      existing.terminal.show();
      return existing;
    }

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        writeEmitter.fire(
          `\x1b[36m[CoLive] Connected to Host Shared Terminal: ${name}\x1b[0m\r\n` +
          `\x1b[90mOutput is mirrored in real time.\x1b[0m\r\n\r\n`,
        );
      },
      close: () => {
        this.terminals.delete(terminalId);
      },
      handleInput: (data: string) => {
        if (this.isReadOnly) {
          vscode.window.showInformationMessage('CoLive Terminal is in read-only mode.');
          return;
        }
        const inputMsg: TerminalInput = {
          v: PROTOCOL_VERSION,
          type: 'terminal.input',
          terminalId,
          data,
        };
        this.connectionManager.send(inputMsg);
      },
      setDimensions: (dims: vscode.TerminalDimensions) => {
        const resizeMsg: TerminalResize = {
          v: PROTOCOL_VERSION,
          type: 'terminal.resize',
          terminalId,
          cols: dims.columns,
          rows: dims.rows,
        };
        this.connectionManager.send(resizeMsg);
      },
    };

    const terminal = vscode.window.createTerminal({
      name: `CoLive Guest: ${name}`,
      pty,
    });
    terminal.show();

    const instance: GuestTerminalInstance = {
      terminalId,
      terminal,
      writeEmitter,
      closeEmitter,
      dispose: () => {
        writeEmitter.dispose();
        closeEmitter.dispose();
        terminal.dispose();
        this.terminals.delete(terminalId);
      },
    };

    this.terminals.set(terminalId, instance);
    return instance;
  }

  private handleMessage(msg: ColiveMessage): void {
    if (msg.type === 'terminal.open.res') {
      const res = msg as TerminalOpenRes;
      const callback = this.pendingRequests.get(res.id);
      if (callback) callback(res);
      return;
    }

    if (msg.type === 'terminal.data') {
      const dataMsg = msg as TerminalData;
      const instance = this.terminals.get(dataMsg.terminalId);
      if (instance) {
        instance.writeEmitter.fire(dataMsg.data);
      }
      return;
    }

    if (msg.type === 'terminal.close') {
      const closeMsg = msg as TerminalClose;
      const instance = this.terminals.get(closeMsg.terminalId);
      if (instance) {
        instance.writeEmitter.fire('\r\n\x1b[33m[Host terminated shared terminal]\x1b[0m\r\n');
        instance.closeEmitter.fire(0);
        this.terminals.delete(closeMsg.terminalId);
      }
      return;
    }
  }

  public dispose(): void {
    for (const t of this.terminals.values()) {
      t.dispose();
    }
    this.terminals.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
