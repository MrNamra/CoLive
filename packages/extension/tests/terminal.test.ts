import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  ColiveMessage,
  PROTOCOL_VERSION,
  TerminalClose,
  TerminalData,
  TerminalOpenReq,
  TerminalOpenRes,
} from '@colive/protocol';
import os from 'node:os';
import {
  HostTerminalService,
  resolveHostCwd,
  resolveHostShell,
  normalizeTerminalInput,
  formatTerminalOutput,
} from '../src/terminal/HostTerminalService.js';
import { GuestTerminalService } from '../src/terminal/GuestTerminalService.js';
import { ConnectionManager } from '../src/connection.js';
import { onDidCloseTerminalEmitter } from './mocks/vscode.js';

describe('Milestone 11: Shared Terminal (Host & Guest Pseudoterminals)', () => {
  let mockConnectionHost: ConnectionManager;
  let mockConnectionGuest: ConnectionManager;
  let hostSentMessages: ColiveMessage[];
  let guestSentMessages: ColiveMessage[];
  let hostMessageListeners: ((msg: ColiveMessage) => void)[];
  let guestMessageListeners: ((msg: ColiveMessage) => void)[];

  beforeEach(() => {
    hostSentMessages = [];
    guestSentMessages = [];
    hostMessageListeners = [];
    guestMessageListeners = [];

    mockConnectionHost = {
      send: vi.fn((msg: ColiveMessage) => {
        hostSentMessages.push(msg);
      }),
      onMessage: vi.fn((listener: (msg: ColiveMessage) => void) => {
        hostMessageListeners.push(listener);
        return { dispose: () => {} };
      }),
    } as unknown as ConnectionManager;

    mockConnectionGuest = {
      send: vi.fn((msg: ColiveMessage) => {
        guestSentMessages.push(msg);
      }),
      onMessage: vi.fn((listener: (msg: ColiveMessage) => void) => {
        guestMessageListeners.push(listener);
        return { dispose: () => {} };
      }),
    } as unknown as ConnectionManager;
  });

  it('HostTerminalService shares a terminal, manages scrollback, and toggles guest write permission', async () => {
    const hostService = new HostTerminalService(mockConnectionHost, process.cwd());
    const termSession = hostService.shareTerminal('Build Terminal');

    expect(termSession.terminalId).toBeDefined();
    expect(termSession.name).toBe('Build Terminal');
    expect(termSession.guestWriteAllowed).toBe(false); // Read-only by default

    // Toggle guest write permission
    const allowed = hostService.toggleGuestWrite(termSession.terminalId, true);
    expect(allowed).toBe(true);
    expect(termSession.guestWriteAllowed).toBe(true);

    const revoked = hostService.toggleGuestWrite(termSession.terminalId, false);
    expect(revoked).toBe(false);
    expect(termSession.guestWriteAllowed).toBe(false);

    // Simulate guest terminal open request
    termSession.scrollbackLines.push('line 1: compiling...');
    termSession.scrollbackLines.push('line 2: done.');

    const openReq: TerminalOpenReq = {
      v: PROTOCOL_VERSION,
      type: 'terminal.open.req',
      id: 'req_open_1',
      name: 'Build Terminal',
    };

    // Dispatch message to host service
    for (const l of hostMessageListeners) l(openReq);

    // Verify host responded with terminal.open.res and replayed scrollback
    const resMsg = hostSentMessages.find((m) => m.type === 'terminal.open.res') as TerminalOpenRes;
    expect(resMsg).toBeDefined();
    expect(resMsg.terminalId).toBe(termSession.terminalId);

    const replayDataMsg = hostSentMessages.find((m) => m.type === 'terminal.data') as TerminalData;
    expect(replayDataMsg).toBeDefined();
    expect(replayDataMsg.data).toContain('compiling');
    expect(replayDataMsg.data).toContain('done.');

    hostService.dispose();
  });

  it('GuestTerminalService connects, displays output, handles input gating and close', async () => {
    const guestService = new GuestTerminalService(mockConnectionGuest);

    // Initiate opening terminal
    const openPromise = guestService.openSharedTerminal('Test Terminal');

    // Guest should have sent terminal.open.req
    const openReq = guestSentMessages.find((m) => m.type === 'terminal.open.req') as TerminalOpenReq;
    expect(openReq).toBeDefined();
    expect(openReq.name).toBe('Test Terminal');

    // Simulate host replying with terminal.open.res
    const resMsg: TerminalOpenRes = {
      v: PROTOCOL_VERSION,
      type: 'terminal.open.res',
      id: openReq.id,
      terminalId: 'term_12345',
    };
    for (const l of guestMessageListeners) l(resMsg);

    const guestTerminal = await openPromise;
    expect(guestTerminal.terminalId).toBe('term_12345');

    // Test receiving terminal data
    let written = '';
    guestTerminal.writeEmitter.event((data) => {
      written += data;
    });

    const dataMsg: TerminalData = {
      v: PROTOCOL_VERSION,
      type: 'terminal.data',
      terminalId: 'term_12345',
      data: 'echo "hello from host"\r\n',
    };
    for (const l of guestMessageListeners) l(dataMsg);

    expect(written).toContain('hello from host');

    // Test read-only gating: when read-only, handleInput should drop input
    guestService.setReadOnly(true);
    // @ts-expect-error accessing private / internal pty method
    const pty = (vscode.window.createTerminal as any).mock?.results?.[0]?.value?.pty;
    if (pty?.handleInput) {
      guestSentMessages = [];
      pty.handleInput('ls -la\r');
      expect(guestSentMessages.length).toBe(0); // Blocked in read-only mode

      // Allow write mode
      guestService.setReadOnly(false);
      pty.handleInput('ls -la\r');
      expect(guestSentMessages.length).toBe(1);
      expect(guestSentMessages[0]!.type).toBe('terminal.input');
    }

    // Test terminal.close
    let closed = false;
    guestTerminal.closeEmitter.event(() => {
      closed = true;
    });

    const closeMsg: TerminalClose = {
      v: PROTOCOL_VERSION,
      type: 'terminal.close',
      terminalId: 'term_12345',
    };
    for (const l of guestMessageListeners) l(closeMsg);

    expect(closed).toBe(true);

    guestService.dispose();
  });

  it('resolveHostCwd falls back to home directory for virtual paths or non-existent folders', () => {
    // A virtual scheme path like "/CoLive: admin1" does not exist physically on disk
    const virtualPath = '/CoLive: admin1';
    const resolvedVirtual = resolveHostCwd(virtualPath);
    expect(resolvedVirtual).toBe(os.homedir());

    // A real directory returns itself
    const realPath = process.cwd();
    const resolvedReal = resolveHostCwd(realPath);
    expect(resolvedReal).toBe(realPath);
  });

  it('resolveHostShell returns a shell command and arguments', () => {
    const { shell, args } = resolveHostShell();
    expect(typeof shell).toBe('string');
    expect(shell.length).toBeGreaterThan(0);
    expect(Array.isArray(args)).toBe(true);
  });

  it('normalizeTerminalInput normalizes carriage returns and newlines cleanly', () => {
    const normalizedEnter = normalizeTerminalInput('ls -la\r');
    if (process.platform === 'win32') {
      expect(normalizedEnter).toBe('ls -la\r\n');
    } else {
      expect(normalizedEnter).toBe('ls -la\n');
    }

    const normalizedMultiLine = normalizeTerminalInput('first\r\nsecond\r');
    if (process.platform === 'win32') {
      expect(normalizedMultiLine).toBe('first\r\nsecond\r\n');
    } else {
      expect(normalizedMultiLine).toBe('first\nsecond\n');
    }
  });

  it('formatTerminalOutput converts unadorned \\n to \\r\\n preventing the terminal staircase effect', () => {
    // Raw output from child_process pipe lacks \r on Linux/macOS
    const rawStaircaseOutput = 'admin1$ ls\nCHANGELOG.md\nCODE_OF_CONDUCT.md\nREADME.md\n';
    const formatted = formatTerminalOutput(rawStaircaseOutput);
    expect(formatted).toBe('admin1$ ls\r\nCHANGELOG.md\r\nCODE_OF_CONDUCT.md\r\nREADME.md\r\n');

    // Already formatted \r\n should not produce double \r
    const validCrlf = 'line 1\r\nline 2\r\n';
    expect(formatTerminalOutput(validCrlf)).toBe('line 1\r\nline 2\r\n');

    // Standalone \r without \n (used in CLI spinners and progress bars) should be preserved
    const spinnerOutput = 'downloading...\r[====    ] 50%\r[========] 100%\n';
    expect(formatTerminalOutput(spinnerOutput)).toBe('downloading...\r[====    ] 50%\r[========] 100%\r\n');
  });

  it('GuestTerminalService automatically creates and mirrors terminal when terminal.data arrives', () => {
    const guestService = new GuestTerminalService(mockConnectionGuest);

    // Host sends terminal.data for a newly shared terminal
    const dataMsg: TerminalData = {
      v: PROTOCOL_VERSION,
      type: 'terminal.data',
      terminalId: 'term_auto_mirror_1',
      data: 'admin1$ ls\nfile1\nfile2\n',
    };

    for (const l of guestMessageListeners) l(dataMsg);

    // Verify guest has created a terminal instance for this terminalId
    // @ts-expect-error accessing private terminals map for test verification
    const instance = guestService.terminals.get('term_auto_mirror_1');
    expect(instance).toBeDefined();
    expect(instance.terminal).toBeDefined();

    guestService.dispose();
  });

  it('GuestTerminalService.createSharedPseudoterminal returns pty and connects to host', async () => {
    const guestService = new GuestTerminalService(mockConnectionGuest);
    const ptyPromise = guestService.createSharedPseudoterminal('Profile Terminal');

    const openReq = guestSentMessages.find((m) => m.type === 'terminal.open.req') as TerminalOpenReq;
    expect(openReq).toBeDefined();
    expect(openReq.name).toBe('Profile Terminal');

    for (const l of guestMessageListeners) {
      l({
        v: PROTOCOL_VERSION,
        type: 'terminal.open.res',
        id: openReq.id,
        terminalId: 'term_profile_99',
      } as TerminalOpenRes);
    }

    const result = await ptyPromise;
    expect(result.terminalId).toBe('term_profile_99');
    expect(result.pty).toBeDefined();
    expect(typeof result.pty.open).toBe('function');
    expect(typeof result.pty.close).toBe('function');

    guestService.dispose();
  });

  it('HostTerminalService broadcasts close and disposes child process when host closes terminal window', async () => {
    const hostService = new HostTerminalService(mockConnectionHost, process.cwd());
    const termSession = hostService.shareTerminal('Host Closes Me');

    expect(hostService.getActiveTerminals().length).toBe(1);

    // Simulate host closing the terminal window in VS Code
    onDidCloseTerminalEmitter.fire(termSession.terminal);

    // Verify terminal.close was broadcast to participants
    const closeMsg = hostSentMessages.find(
      (m) => m.type === 'terminal.close' && (m as TerminalClose).terminalId === termSession.terminalId,
    );
    expect(closeMsg).toBeDefined();

    // Verify terminal was removed from active terminals
    expect(hostService.getActiveTerminals().length).toBe(0);

    hostService.dispose();
  });

  it('HostTerminalService rejects input and sends close when guest inputs to a closed terminal', async () => {
    const hostService = new HostTerminalService(mockConnectionHost, process.cwd());

    // Guest sends input to non-existent or closed terminal
    for (const l of hostMessageListeners) {
      l({
        v: PROTOCOL_VERSION,
        type: 'terminal.input',
        terminalId: 'dead_terminal_id',
        data: 'cat /etc/passwd\n',
      });
    }

    const closeMsg = hostSentMessages.find(
      (m) => m.type === 'terminal.close' && (m as TerminalClose).terminalId === 'dead_terminal_id',
    );
    expect(closeMsg).toBeDefined();

    hostService.dispose();
  });

  it('HostTerminalService rejects terminal.open.req with error if host has not started a shared terminal', async () => {
    const hostService = new HostTerminalService(mockConnectionHost, process.cwd());

    // Guest sends open request when host has no active terminal
    const openReq: TerminalOpenReq = {
      v: PROTOCOL_VERSION,
      type: 'terminal.open.req',
      id: 'req_unmonitored',
      name: 'Unmonitored Shell',
    };
    for (const l of hostMessageListeners) l(openReq);

    // Host must reject with error rather than spawning an unmonitored shell
    const errorMsg = hostSentMessages.find((m) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect((errorMsg as any).id).toBe('req_unmonitored');
    expect(hostService.getActiveTerminals().length).toBe(0);

    hostService.dispose();
  });
});
