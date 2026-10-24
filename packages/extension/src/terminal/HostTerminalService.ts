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

export function formatTerminalOutput(data: string): string {
  // Convert any \n into \r\n to prevent the terminal staircase effect in pseudoterminals
  return data.replace(/\r*\n/g, '\r\n');
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
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closedTerm) => {
        for (const [id, session] of this.terminals.entries()) {
          if (session.terminal === closedTerm) {
            this.closeTerminal(id);
          }
        }
      }),
    );
    // Broadcast active terminal to new participants so their terminal mirrors immediately
    this.disposables.push(
      this.connectionManager.onMessage((msg) => {
        if (msg.type === 'server.participantJoined') {
          for (const term of this.terminals.values()) {
            const welcome =
              `\x1b[32m[CoLive] Shared Terminal active (${term.name})\x1b[0m\r\n` +
              `\x1b[90mOutput is mirrored in real time.\x1b[0m\r\n\r\n`;
            const replay =
              term.scrollbackLines.length > 0
                ? term.scrollbackLines.join('\r\n') + '\r\n'
                : welcome;
            this.connectionManager.send({
              v: PROTOCOL_VERSION,
              type: 'terminal.data',
              terminalId: term.terminalId,
              data: replay,
            });
          }
        }
      }),
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
        COLUMNS: '120',
        LINES: '30',
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

      // Format output with \r\n to prevent the terminal staircase effect
      const formatted = formatTerminalOutput(data);

      // Update scrollback lines
      const splitLines = formatted.split('\r\n');
      for (const line of splitLines) {
        scrollbackLines.push(line);
        if (scrollbackLines.length > MAX_SCROLLBACK_LINES) {
          scrollbackLines.shift();
        }
      }

      // Emit locally to host pseudoterminal
      writeEmitter.fire(formatted);

      // Broadcast to all participants in session
      const terminalDataMsg: TerminalData = {
        v: PROTOCOL_VERSION,
        type: 'terminal.data',
        terminalId,
        data: formatted,
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
      if (this.terminals.has(terminalId)) {
        this.terminals.delete(terminalId);
        const closeMsg: TerminalClose = {
          v: PROTOCOL_VERSION,
          type: 'terminal.close',
          terminalId,
        };
        this.connectionManager.send(closeMsg);
      }
      writeEmitter.fire(`\r\n\x1b[33m[Process exited with code ${code ?? 0}]\x1b[0m\r\n`);
      closeEmitter.fire(code ?? 0);
    });

    const killChildProcess = () => {
      try {
        if (!child.killed) {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              if (!child.killed) child.kill('SIGKILL');
            } catch {
              // Already dead
            }
          }, 300);
        }
      } catch {
        // Already dead
      }
    };

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        const welcome =
          `\x1b[32m[CoLive] Shared Terminal started (${name})\x1b[0m\r\n` +
          `\x1b[90mGuests can view output in real-time. Use 'CoLive: Toggle Terminal Guest Permissions' to allow typing.\x1b[0m\r\n\r\n`;
        writeEmitter.fire(welcome);
        // Broadcast initial terminal creation to all guests so mirrored terminal opens immediately
        this.connectionManager.send({
          v: PROTOCOL_VERSION,
          type: 'terminal.data',
          terminalId,
          data: welcome,
        });
      },
      close: () => {
        this.closeTerminal(terminalId);
      },
      handleInput: (data: string) => {
        if (!child.stdin.destroyed) {
          child.stdin.write(normalizeTerminalInput(data));
        }
      },
      setDimensions: (dims: vscode.TerminalDimensions) => {
        if (dims && dims.columns && dims.rows) {
          if ('setWindowSize' in child.stdout && typeof (child.stdout as any).setWindowSize === 'function') {
            (child.stdout as any).setWindowSize(dims.columns, dims.rows);
          }
        }
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
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        killChildProcess();
        writeEmitter.dispose();
        closeEmitter.dispose();
        try {
          terminal.dispose();
        } catch {
          // Already disposed
        }
        this.terminals.delete(terminalId);
      },
    };

    this.terminals.set(terminalId, session);
    return session;
  }

  public closeTerminal(terminalId: string): void {
    const session = this.terminals.get(terminalId);
    if (!session) return;

    this.terminals.delete(terminalId);

    // Notify all participants in session that host closed the terminal
    const closeMsg: TerminalClose = {
      v: PROTOCOL_VERSION,
      type: 'terminal.close',
      terminalId,
    };
    this.connectionManager.send(closeMsg);

    session.dispose();
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
        // Do not silently spawn an unmonitored shell if host closed the terminal!
        // Notify host that guest requested terminal, and reject request with informative error
        vscode.window
          .showInformationMessage(
            'CoLive: A guest requested access to a shared terminal.',
            'Share Terminal',
          )
          .then((action) => {
            if (action === 'Share Terminal') {
              this.shareTerminal(req.name || 'CoLive Shared Terminal');
            }
          });

        const errorMsg: ColiveMessage = {
          v: PROTOCOL_VERSION,
          type: 'error',
          id: req.id,
          message: 'No active shared terminal. The host has not started a shared terminal or has closed it.',
        };
        this.connectionManager.send(errorMsg);
        return;
      }

      // Send terminal.open.res with terminalId
      const resMsg: TerminalOpenRes = {
        v: PROTOCOL_VERSION,
        type: 'terminal.open.res',
        id: req.id,
        terminalId: activeTerm.terminalId,
      };
      this.connectionManager.send(resMsg);

      // Replay scrollback buffer so guest immediately sees prior output formatted with CRLF
      if (activeTerm.scrollbackLines.length > 0) {
        const replayData = activeTerm.scrollbackLines.join('\r\n') + '\r\n';
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
      if (!term) {
        // Terminal is closed on host: inform guest and drop input
        this.connectionManager.send({
          v: PROTOCOL_VERSION,
          type: 'terminal.close',
          terminalId: inputMsg.terminalId,
        });
        return;
      }
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
