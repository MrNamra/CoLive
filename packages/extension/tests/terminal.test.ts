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
} from '../src/terminal/HostTerminalService.js';
import { GuestTerminalService } from '../src/terminal/GuestTerminalService.js';
import { ConnectionManager } from '../src/connection.js';

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
});
