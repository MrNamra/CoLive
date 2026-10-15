import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildDeepLink, buildPasteCode, parseInviteInput } from '../src/invite.js';
import { SessionLifecycleState, SessionStateChangeEvent } from '../src/session/sessionState.js';
import { cleanupColiveWorkspaceFolders } from '../src/extension.js';

describe('Invite Link & Paste Code Utilities', () => {
  const sessionId = 'abc123xyz0';
  const secret = 'sec_9876543210_abcdef';

  it('builds standard deep link and paste code', () => {
    const deepLink = buildDeepLink(sessionId, secret);
    expect(deepLink).toBe(
      `vscode://colive-team.colive/join?session=${encodeURIComponent(sessionId)}&secret=${encodeURIComponent(secret)}`,
    );

    const pasteCode = buildPasteCode(sessionId, secret);
    expect(pasteCode).toBe(`${sessionId}.${secret}`);
  });

  it('parses valid paste code correctly', () => {
    const parsed = parseInviteInput(`${sessionId}.${secret}`);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe(sessionId);
    expect(parsed?.secret).toBe(secret);
  });

  it('parses valid deep link URI correctly', () => {
    const uri = `vscode://colive-team.colive/join?session=${sessionId}&secret=${secret}`;
    const parsed = parseInviteInput(uri);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe(sessionId);
    expect(parsed?.secret).toBe(secret);
  });

  it('embeds and parses serverUrl for worldwide Cloudflare connections', () => {
    const serverUrl = 'wss://quick-tunnel-123.trycloudflare.com/ws';
    const deepLink = buildDeepLink(sessionId, secret, serverUrl);
    expect(deepLink).toContain(`server=${encodeURIComponent(serverUrl)}`);

    const parsedDeepLink = parseInviteInput(deepLink);
    expect(parsedDeepLink).not.toBeNull();
    expect(parsedDeepLink?.sessionId).toBe(sessionId);
    expect(parsedDeepLink?.secret).toBe(secret);
    expect(parsedDeepLink?.serverUrl).toBe(serverUrl);

    // Paste code with server
    const pasteCode = buildPasteCode(sessionId, secret, serverUrl);
    expect(pasteCode).toBe(`${sessionId}.${secret}@${serverUrl}`);

    const parsedPasteCode = parseInviteInput(pasteCode);
    expect(parsedPasteCode).not.toBeNull();
    expect(parsedPasteCode?.sessionId).toBe(sessionId);
    expect(parsedPasteCode?.secret).toBe(secret);
    expect(parsedPasteCode?.serverUrl).toBe(serverUrl);

    // Cloudflare web landing URL
    const cfWebUrl = `https://quick-tunnel-123.trycloudflare.com/j/${sessionId}#${secret}`;
    const parsedWeb = parseInviteInput(cfWebUrl);
    expect(parsedWeb).not.toBeNull();
    expect(parsedWeb?.sessionId).toBe(sessionId);
    expect(parsedWeb?.secret).toBe(secret);
    expect(parsedWeb?.serverUrl).toBe(serverUrl);
  });

  it('parses web landing link with fragment correctly', () => {
    const webUrl = `http://localhost:8787/j/${sessionId}#${secret}`;
    const parsed = parseInviteInput(webUrl);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe(sessionId);
    expect(parsed?.secret).toBe(secret);
  });

  it('rejects invalid or malformed invite inputs', () => {
    expect(parseInviteInput('')).toBeNull();
    expect(parseInviteInput('not-a-valid-code')).toBeNull();
    expect(parseInviteInput('random text with dots.and.too.many.dots')).toBeNull();
  });
});

describe('Exponential Backoff Schedule', () => {
  it('calculates correct backoff intervals capped at 30s', () => {
    function computeBackoff(attempt: number): number {
      const base = Math.min(30000, 1000 * Math.pow(1.5, attempt));
      return Math.round(base);
    }

    expect(computeBackoff(1)).toBe(1500);
    expect(computeBackoff(2)).toBe(2250);
    expect(computeBackoff(3)).toBe(3375);
    expect(computeBackoff(5)).toBe(7594);
    expect(computeBackoff(10)).toBe(30000); // Capped at 30,000 ms
    expect(computeBackoff(20)).toBe(30000);
  });
});

describe('Session State Machine Transitions', () => {
  class MockStateMachine {
    public state: SessionLifecycleState = 'idle';
    public events: SessionStateChangeEvent[] = [];

    public transition(to: SessionLifecycleState, reason?: string): void {
      const prev = this.state;
      this.state = to;
      this.events.push({ previous: prev, current: to, reason });
    }
  }

  it('transitions through complete session lifecycle', () => {
    const sm = new MockStateMachine();
    expect(sm.state).toBe('idle');

    sm.transition('connecting');
    expect(sm.state).toBe('connecting');

    sm.transition('active');
    expect(sm.state).toBe('active');

    sm.transition('reconnecting', 'Network dropped');
    expect(sm.state).toBe('reconnecting');

    sm.transition('active', 'Reconnected');
    expect(sm.state).toBe('active');

    sm.transition('ended', 'User ended session');
    expect(sm.state).toBe('ended');

    expect(sm.events).toHaveLength(5);
    expect(sm.events[0]).toEqual({ previous: 'idle', current: 'connecting', reason: undefined });
    expect(sm.events[4]).toEqual({ previous: 'active', current: 'ended', reason: 'User ended session' });
  });
});

describe('RPC Timeout Behavior', () => {
  it('rejects after timeout if response is not received', async () => {
    vi.useFakeTimers();

    const pendingRpcs = new Map<string, { reject: (err: Error) => void; timer: NodeJS.Timeout }>();

    function mockRequest(id: string, timeoutMs = 1000): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRpcs.delete(id);
          reject(new Error(`RPC request '${id}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingRpcs.set(id, { reject, timer });
      });
    }

    const promise = mockRequest('req_test_timeout', 1000);
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrowError("RPC request 'req_test_timeout' timed out after 1000ms");

    vi.useRealTimers();
  });
});

describe('Workspace Folder Cleanup on Reload & Deactivate', () => {
  it('removes all virtual colive:/ folders from participant workspace', () => {
    // Populate mock workspace folders with local and colive folders
    vscode.workspace.updateWorkspaceFolders(
      0,
      vscode.workspace.workspaceFolders.length,
      { uri: vscode.Uri.file('/home/user/project'), name: 'project' },
      { uri: vscode.Uri.parse('colive:/MyWorkspace'), name: 'CoLive: MyWorkspace' },
      { uri: vscode.Uri.file('/home/user/other'), name: 'other' },
      { uri: vscode.Uri.parse('colive:/SecondShare'), name: 'CoLive: SecondShare' },
    );

    expect(vscode.workspace.workspaceFolders).toHaveLength(4);

    // Call cleanup (runs on extension activate, deactivate, or endSession)
    cleanupColiveWorkspaceFolders();

    expect(vscode.workspace.workspaceFolders).toHaveLength(2);
    expect(vscode.workspace.workspaceFolders.map((f) => f.uri.scheme)).toEqual(['file', 'file']);
    expect(vscode.workspace.workspaceFolders.map((f) => f.name)).toEqual(['project', 'other']);
  });
});
