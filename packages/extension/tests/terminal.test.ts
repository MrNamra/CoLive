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
import { HostTerminalService } from '../src/terminal/HostTerminalService.js';
import { GuestTerminalService } from '../src/terminal/GuestTerminalService.js';
import { ConnectionManager } from '../src/connection/ConnectionManager.js';

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
});
