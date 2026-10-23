import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
import {
  DebugBreakpointsSync,
  DebugStackReq,
  DebugStackRes,
  DebugStateBroadcast,
  DebugStepReq,
  DebugStepRes,
  DebugVariablesReq,
  DebugVariablesRes,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { HostDebugProxy } from '../src/host/debugProxy.js';
import { GuestDebugClient } from '../src/guest/debugClient.js';
import { ConnectionManager } from '../src/connection.js';

class MockConnectionManager extends EventEmitter {
  public sentMessages: unknown[] = [];
  public requestHandler?: (req: unknown) => Promise<unknown>;

  public send(msg: unknown): void {
    this.sentMessages.push(msg);
  }

  public override on(event: string | symbol, listener: (...args: any[]) => void): any {
    super.on(event, listener);
    return {
      dispose: () => {
        super.off(event, listener);
      },
    };
  }

  public async request<T = unknown>(req: unknown): Promise<T> {
    if (this.requestHandler) {
      return (await this.requestHandler(req)) as T;
    }
    throw new Error('No mock request handler installed');
  }
}

describe('Phase 2: Shared Interactive Debugging', () => {
  const workspaceRoot = '/test/workspace';
  let mockConn: MockConnectionManager;

  beforeEach(() => {
    mockConn = new MockConnectionManager();
    vi.restoreAllMocks();
  });

  describe('HostDebugProxy', () => {
    it('broadcasts debug state when active session starts and ends', () => {
      const proxy = new HostDebugProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      // Trigger session start
      vscode.onDidChangeActiveDebugSessionEmitter.fire({ name: 'Node.js Launch' });
      expect(mockConn.sentMessages.some((m: any) => m.type === 'debug.state' && m.state === 'running')).toBe(true);

      // Trigger session termination
      vscode.onDidChangeActiveDebugSessionEmitter.fire(undefined);
      expect(mockConn.sentMessages.some((m: any) => m.type === 'debug.state' && m.state === 'inactive')).toBe(true);

      proxy.dispose();
    });

    it('handles debug.stack.req by returning DAP stack frames', async () => {
      vscode.debug.activeDebugSession = {
        name: 'Node.js Launch',
        customRequest: async (command: string) => {
          if (command === 'stackTrace') {
            return {
              stackFrames: [
                {
                  id: 101,
                  name: 'processRequest',
                  source: { path: '/test/workspace/src/server.ts' },
                  line: 45,
                  column: 8,
                },
              ],
            };
          }
          return undefined;
        },
      } as any;

      const proxy = new HostDebugProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      const stackReq: DebugStackReq = {
        v: PROTOCOL_VERSION,
        type: 'debug.stack.req',
        id: 'stack_1',
        threadId: 1,
      };

      mockConn.emit('message', stackReq);
      await new Promise((r) => setTimeout(r, 10));

      const res = mockConn.sentMessages.find((m: any) => m.type === 'debug.stack.res') as DebugStackRes;
      expect(res).toBeDefined();
      expect(res.frames.length).toBe(1);
      expect(res.frames[0]!.id).toBe(101);
      expect(res.frames[0]!.name).toBe('processRequest');
      expect(res.frames[0]!.file).toBe('src/server.ts');
      expect(res.frames[0]!.line).toBe(45);

      proxy.dispose();
      vscode.debug.activeDebugSession = undefined;
    });

    it('handles debug.variables.req by querying scopes and variables', async () => {
      vscode.debug.activeDebugSession = {
        name: 'Node.js Launch',
        customRequest: async (command: string, args: any) => {
          if (command === 'scopes') {
            return {
              scopes: [{ name: 'Locals', variablesReference: 1001 }],
            };
          }
          if (command === 'variables' && args.variablesReference === 1001) {
            return {
              variables: [
                { name: 'count', value: '42', type: 'number' },
                { name: 'user', value: '{"name":"Alice"}', type: 'object' },
              ],
            };
          }
          return undefined;
        },
      } as any;

      const proxy = new HostDebugProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      const varsReq: DebugVariablesReq = {
        v: PROTOCOL_VERSION,
        type: 'debug.variables.req',
        id: 'vars_1',
        frameId: 101,
      };

      mockConn.emit('message', varsReq);
      await new Promise((r) => setTimeout(r, 10));

      const res = mockConn.sentMessages.find((m: any) => m.type === 'debug.variables.res') as DebugVariablesRes;
      expect(res).toBeDefined();
      expect(res.variables.length).toBe(2);
      expect(res.variables[0]!.name).toBe('count');
      expect(res.variables[0]!.value).toBe('42');
      expect(res.variables[1]!.name).toBe('user');

      proxy.dispose();
      vscode.debug.activeDebugSession = undefined;
    });

    it('handles debug.step.req and invokes VS Code stepping commands', async () => {
      const executeCommandSpy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

      const proxy = new HostDebugProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      const stepReq: DebugStepReq = {
        v: PROTOCOL_VERSION,
        type: 'debug.step.req',
        id: 'step_1',
        action: 'stepIn',
      };

      mockConn.emit('message', stepReq);
      await new Promise((r) => setTimeout(r, 10));

      expect(executeCommandSpy).toHaveBeenCalledWith('workbench.action.debug.stepInto');
      const res = mockConn.sentMessages.find((m: any) => m.type === 'debug.step.res') as DebugStepRes;
      expect(res).toBeDefined();
      expect(res.success).toBe(true);

      proxy.dispose();
    });

    it('synchronizes breakpoints when workspace breakpoints change', () => {
      vscode.debug.breakpoints = [
        {
          id: 'bp_node_1',
          enabled: true,
          location: {
            uri: vscode.Uri.file('/test/workspace/src/app.ts'),
            range: new vscode.Range(20, 0, 20, 0),
          },
        },
      ] as any;

      const proxy = new HostDebugProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      vscode.onDidChangeBreakpointsEmitter.fire(undefined);

      const bpMsg = mockConn.sentMessages.find((m: any) => m.type === 'debug.breakpoints') as DebugBreakpointsSync;
      expect(bpMsg).toBeDefined();
      expect(bpMsg.breakpoints.length).toBe(1);
      expect(bpMsg.breakpoints[0]!.path).toBe('src/app.ts');
      expect(bpMsg.breakpoints[0]!.line).toBe(21);

      proxy.dispose();
      vscode.debug.breakpoints = [];
    });
  });

  describe('GuestDebugClient', () => {
    it('updates debug state and creates tree items on stopped state', async () => {
      const client = new GuestDebugClient('CoLive: Shared', mockConn as unknown as ConnectionManager);

      // Initially inactive
      let roots = await client.getChildren();
      expect(roots[0]!.label).toContain('No active debug session');

      // Send stopped state
      const stateBroadcast: DebugStateBroadcast = {
        v: PROTOCOL_VERSION,
        type: 'debug.state',
        state: 'stopped',
        sessionName: 'Mocha Tests',
        reason: 'breakpoint',
        threadId: 2,
        file: 'src/calc.ts',
        line: 15,
      };

      mockConn.emit('message', stateBroadcast);

      expect(client.state).toBe('stopped');
      expect(client.stoppedFile).toBe('src/calc.ts');
      expect(client.stoppedLine).toBe(15);

      roots = await client.getChildren();
      expect(roots.some((r) => r.id === 'status' && r.label.includes('Stopped at src/calc.ts:15'))).toBe(true);
      expect(roots.some((r) => r.id === 'callstack')).toBe(true);
      expect(roots.some((r) => r.id === 'variables')).toBe(true);

      client.dispose();
    });

    it('dispatches step requests over connection', async () => {
      mockConn.requestHandler = async (req: any) => {
        if (req.type === 'debug.step.req') {
          return {
            v: PROTOCOL_VERSION,
            type: 'debug.step.res',
            id: req.id,
            success: true,
          };
        }
        throw new Error('Unknown request');
      };

      const client = new GuestDebugClient('CoLive: Shared', mockConn as unknown as ConnectionManager);

      const success = await client.step('continue');
      expect(success).toBe(true);

      client.dispose();
    });
  });
});
