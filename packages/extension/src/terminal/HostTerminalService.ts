import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export function resolveHostShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    // Windows: Check custom SHELL (e.g. Git Bash), PowerShell, or cmd.exe
    const envShell = process.env.SHELL;
    if (envShell && fs.existsSync(envShell)) {
      return { shell: envShell, args: ['-i'] };
    }
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const pwshPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(pwshPath)) {
      return { shell: pwshPath, args: ['-NoLogo'] };
    }
    const comSpec = process.env.COMSPEC || 'cmd.exe';
    return { shell: comSpec, args: [] };
  } else if (process.platform === 'darwin') {
    // macOS: Use user's SHELL or default zsh/bash with login + interactive flags
    const envShell = process.env.SHELL;
    if (envShell && fs.existsSync(envShell)) {
      return { shell: envShell, args: ['-l', '-i'] };
    }
    if (fs.existsSync('/bin/zsh')) {
      return { shell: '/bin/zsh', args: ['-l', '-i'] };
    }
    return { shell: '/bin/bash', args: ['-l', '-i'] };
  } else {
    // Linux / other Unix
    const envShell = process.env.SHELL;
    if (envShell && fs.existsSync(envShell)) {
      return { shell: envShell, args: ['-i'] };
    }
    if (fs.existsSync('/bin/bash')) {
      return { shell: '/bin/bash', args: ['-i'] };
    }
    return { shell: '/bin/sh', args: ['-i'] };
  }
}

export function resolveHostCwd(workspaceRoot: string): string {
  if (workspaceRoot && typeof workspaceRoot === 'string') {
    try {
      if (fs.existsSync(workspaceRoot) && fs.statSync(workspaceRoot).isDirectory()) {
        return workspaceRoot;
      }
    } catch {
      // Fall through to homedir
    }
  }
  return os.homedir();
}

export function normalizeTerminalInput(data: string): string {
  if (process.platform === 'win32') {
    // Windows console / PowerShell stdin expects \r\n (CRLF)
    return data.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  }
  // Linux / macOS shells expect \n (LF)
  return data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export interface HostTerminalSession {
  terminalId: string;
  name: string;
  terminal: vscode.Terminal;
  childProcess: ChildProcessWithoutNullStreams;
  scrollbackLines: string[];
  guestWriteAllowed: boolean;
  dispose: () => void;
}

export class HostTerminalService implements vscode.Disposable {
  private terminals = new Map<string, HostTerminalSession>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private connectionManager: ConnectionManager,
    private workspaceRoot: string,
  ) {
    this.disposables.push(
      this.connectionManager.onMessage((msg) => this.handleMessage(msg)),
    );
  }

  public shareTerminal(name = 'CoLive Shared Terminal'): HostTerminalSession {
    const terminalId = `term_${crypto.randomBytes(6).toString('hex')}`;
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();

    const { shell, args: shellArgs } = resolveHostShell();
    const targetCwd = resolveHostCwd(this.workspaceRoot);

    const child = spawn(shell, shellArgs, {
      cwd: targetCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLIVE_TERMINAL: '1',
      },
    });

    const scrollbackLines: string[] = [];
    const MAX_SCROLLBACK_LINES = 2000;

    let outputBuffer = '';
    let flushTimer: NodeJS.Timeout | null = null;

    const flushOutput = () => {
      if (!outputBuffer) return;
      const data = outputBuffer;
      outputBuffer = '';
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      // Update scrollback lines
      const splitLines = data.split('\n');
      for (const line of splitLines) {
        scrollbackLines.push(line);
        if (scrollbackLines.length > MAX_SCROLLBACK_LINES) {
          scrollbackLines.shift();
        }
      }

      // Emit locally to host pseudoterminal
      writeEmitter.fire(data);

      // Broadcast to all participants in session
      const terminalDataMsg: TerminalData = {
        v: PROTOCOL_VERSION,
        type: 'terminal.data',
        terminalId,
        data,
      };
      this.connectionManager.send(terminalDataMsg);
    };

    const queueOutput = (chunk: string) => {
      outputBuffer += chunk;
      // 4KB threshold flush
      if (outputBuffer.length >= 4096) {
        flushOutput();
      } else if (!flushTimer) {
        // 16ms frame threshold debounce flush
        flushTimer = setTimeout(flushOutput, 16);
      }
    };

    child.stdout.on('data', (d: Buffer) => queueOutput(d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => queueOutput(d.toString('utf-8')));

    child.on('error', (err) => {
      queueOutput(`\r\n\x1b[31m[Failed to run shell: ${err.message}]\x1b[0m\r\n`);
      flushOutput();
    });

    child.on('exit', (code) => {
      flushOutput();
      const closeMsg: TerminalClose = {
        v: PROTOCOL_VERSION,
        type: 'terminal.close',
        terminalId,
      };
      this.connectionManager.send(closeMsg);
      writeEmitter.fire(`\r\n\x1b[33m[Process exited with code ${code ?? 0}]\x1b[0m\r\n`);
      closeEmitter.fire(code ?? 0);
      this.terminals.delete(terminalId);
    });

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        writeEmitter.fire(
          `\x1b[32m[CoLive] Shared Terminal started (${name})\x1b[0m\r\n` +
          `\x1b[90mGuests can view output in real-time. Use 'CoLive: Toggle Terminal Guest Permissions' to allow typing.\x1b[0m\r\n\r\n`,
        );
      },
      close: () => {
        child.kill();
        if (flushTimer) clearTimeout(flushTimer);
      },
      handleInput: (data: string) => {
        if (!child.stdin.destroyed) {
          child.stdin.write(normalizeTerminalInput(data));
        }
      },
      setDimensions: (_dims: vscode.TerminalDimensions) => {
        // Host terminal dimensions
      },
    };

    const terminal = vscode.window.createTerminal({
      name: `CoLive Host: ${name}`,
      pty,
    });
    terminal.show();

    const session: HostTerminalSession = {
      terminalId,
      name,
      terminal,
      childProcess: child,
      scrollbackLines,
      guestWriteAllowed: false, // Read-only by default for guests
      dispose: () => {
        if (flushTimer) clearTimeout(flushTimer);
        child.kill();
        writeEmitter.dispose();
        closeEmitter.dispose();
        terminal.dispose();
        this.terminals.delete(terminalId);
      },
    };

    this.terminals.set(terminalId, session);
    return session;
  }

  public toggleGuestWrite(terminalId: string, allowed?: boolean): boolean {
    const term = this.terminals.get(terminalId);
    if (!term) return false;
    term.guestWriteAllowed = allowed !== undefined ? allowed : !term.guestWriteAllowed;
    return term.guestWriteAllowed;
  }

  public getActiveTerminals(): HostTerminalSession[] {
    return Array.from(this.terminals.values());
  }

  private handleMessage(msg: ColiveMessage): void {
    // 1. Guest requesting to open a shared terminal
    if (msg.type === 'terminal.open.req') {
      const req = msg as TerminalOpenReq;
      // Find terminal by name or use the first active shared terminal
      let activeTerm =
        (req.name ? Array.from(this.terminals.values()).find((t) => t.name === req.name) : undefined) ||
        this.terminals.values().next().value;

      if (!activeTerm) {
        // Auto-create shared terminal so guest or host can access it immediately
        activeTerm = this.shareTerminal(req.name || 'CoLive Shared Terminal');
      }

      // Send terminal.open.res with terminalId
      const resMsg: TerminalOpenRes = {
        v: PROTOCOL_VERSION,
        type: 'terminal.open.res',
        id: req.id,
        terminalId: activeTerm.terminalId,
      };
      this.connectionManager.send(resMsg);

      // Replay scrollback buffer so guest immediately sees prior output
      if (activeTerm.scrollbackLines.length > 0) {
        const replayData = activeTerm.scrollbackLines.join('\n');
        this.connectionManager.send({
          v: PROTOCOL_VERSION,
          type: 'terminal.data',
          terminalId: activeTerm.terminalId,
          data: replayData,
        });
      }
      return;
    }

    // 2. Guest sending terminal input
    if (msg.type === 'terminal.input') {
      const inputMsg = msg as TerminalInput;
      const term = this.terminals.get(inputMsg.terminalId);
      if (term) {
        if (!term.guestWriteAllowed) {
          this.connectionManager.send({
            v: PROTOCOL_VERSION,
            type: 'terminal.data',
            terminalId: term.terminalId,
            data: '\r\n\x1b[33m[Host has set this shared terminal to read-only. Ask host to allow typing.]\x1b[0m\r\n',
          });
          return;
        }
        if (!term.childProcess.stdin.destroyed) {
          term.childProcess.stdin.write(normalizeTerminalInput(inputMsg.data));
        }
      }
      return;
    }

    // 3. Guest sending terminal resize
    if (msg.type === 'terminal.resize') {
      const resizeMsg = msg as TerminalResize;
      const term = this.terminals.get(resizeMsg.terminalId);
      if (term) {
        // Bound dimensions to reasonable host limits
        const boundedCols = Math.min(Math.max(resizeMsg.cols, 20), 240);
        const boundedRows = Math.min(Math.max(resizeMsg.rows, 5), 100);
        // If child process or pseudo-tty supports resize
        if ('setWindowSize' in term.childProcess.stdout && typeof (term.childProcess.stdout as any).setWindowSize === 'function') {
          (term.childProcess.stdout as any).setWindowSize(boundedCols, boundedRows);
        }
      }
      return;
    }
  }

  public dispose(): void {
    for (const term of this.terminals.values()) {
      term.dispose();
    }
    this.terminals.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
