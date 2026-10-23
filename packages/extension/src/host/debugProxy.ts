import * as vscode from 'vscode';
import path from 'node:path';
import {
  DebugBreakpoint,
  DebugBreakpointsSync,
  DebugStackFrame,
  DebugStackReq,
  DebugStackRes,
  DebugStateBroadcast,
  DebugStepReq,
  DebugStepRes,
  DebugVariable,
  DebugVariablesReq,
  DebugVariablesRes,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { Logger } from '../logger.js';

/**
 * HostDebugProxy intercepts active debug sessions on the host, broadcasts execution state,
 * and handles guest stepping, stack inspection, and breakpoint synchronization.
 */
export class HostDebugProxy implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private activeThreadId?: number;

  constructor(
    private readonly workspaceRoot: string,
    private readonly connection: ConnectionManager,
  ) {
    this.registerDebugLifecycle();
    this.registerRpcHandlers();
    this.registerBreakpointSync();
  }

  private registerDebugLifecycle(): void {
    // 1. Watch active session changes
    this.disposables.push(
      vscode.debug.onDidChangeActiveDebugSession((session) => {
        if (!session) {
          this.activeThreadId = undefined;
          this.broadcastDebugState('inactive');
        } else {
          this.broadcastDebugState('running', session.name);
        }
      }),
    );

    // 2. DAP message interception via DebugAdapterTracker
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session: vscode.DebugSession) => ({
          onDidSendMessage: async (message: unknown) => {
            if (message && typeof message === 'object' && 'type' in message) {
              const dapMsg = message as { type: string; event?: string; body?: Record<string, unknown> };
              if (dapMsg.type === 'event') {
                if (dapMsg.event === 'stopped') {
                  const threadId = typeof dapMsg.body?.threadId === 'number' ? dapMsg.body.threadId : undefined;
                  const reason = typeof dapMsg.body?.reason === 'string' ? dapMsg.body.reason : 'paused';
                  this.activeThreadId = threadId;
                  await this.handleStopped(session, threadId, reason);
                } else if (dapMsg.event === 'continued') {
                  this.broadcastDebugState('running', session.name);
                } else if (dapMsg.event === 'terminated') {
                  this.activeThreadId = undefined;
                  this.broadcastDebugState('inactive', session.name);
                }
              }
            }
          },
        }),
      }),
    );
  }

  private async handleStopped(
    session: vscode.DebugSession,
    threadId: number | undefined,
    reason: string,
  ): Promise<void> {
    let topFile: string | undefined;
    let topLine: number | undefined;

    try {
      if (threadId !== undefined) {
        const stackRes = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
        const topFrame = stackRes?.stackFrames?.[0];
        if (topFrame) {
          topLine = topFrame.line;
          const sourcePath = topFrame.source?.path;
          if (sourcePath) {
            topFile = path.relative(this.workspaceRoot, sourcePath).replace(/\\/g, '/');
          }
        }
      }
    } catch {
      // Ignored
    }

    const broadcast: DebugStateBroadcast = {
      v: PROTOCOL_VERSION,
      type: 'debug.state',
      state: 'stopped',
      sessionName: session.name,
      reason,
      threadId,
      file: topFile,
      line: topLine,
    };
    this.connection.send(broadcast);
  }

  private broadcastDebugState(
    state: 'inactive' | 'running' | 'stopped',
    sessionName?: string,
    reason?: string,
  ): void {
    const broadcast: DebugStateBroadcast = {
      v: PROTOCOL_VERSION,
      type: 'debug.state',
      state,
      sessionName,
      reason,
      threadId: this.activeThreadId,
    };
    this.connection.send(broadcast);
  }

  private registerRpcHandlers(): void {
    const sub = this.connection.on('message', async (msg) => {
      try {
        if (msg.type === 'debug.stack.req') {
          await this.handleStack(msg as DebugStackReq);
        } else if (msg.type === 'debug.variables.req') {
          await this.handleVariables(msg as DebugVariablesReq);
        } else if (msg.type === 'debug.step.req') {
          await this.handleStep(msg as DebugStepReq);
        }
      } catch (err) {
        Logger.warn('HostDebugProxy RPC failed', { type: msg.type, err });
        this.connection.send({
          v: PROTOCOL_VERSION,
          type: 'error',
          id: 'id' in msg ? msg.id : undefined,
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.disposables.push(sub);
  }

  private async handleStack(req: DebugStackReq): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    const frames: DebugStackFrame[] = [];

    if (session) {
      try {
        const threadId = req.threadId ?? this.activeThreadId ?? 1;
        const res = await session.customRequest('stackTrace', { threadId });
        const rawFrames = res?.stackFrames || [];
        for (const f of rawFrames) {
          let relFile: string | undefined;
          if (f.source?.path) {
            relFile = path.relative(this.workspaceRoot, f.source.path).replace(/\\/g, '/');
          }
          frames.push({
            id: f.id,
            name: f.name,
            file: relFile,
            line: f.line,
            column: f.column,
          });
        }
      } catch {
        // Ignored
      }
    }

    const response: DebugStackRes = {
      v: PROTOCOL_VERSION,
      type: 'debug.stack.res',
      id: req.id,
      frames,
    };
    this.connection.send(response);
  }

  private async handleVariables(req: DebugVariablesReq): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    const variables: DebugVariable[] = [];

    if (session) {
      try {
        let varRef = req.variablesReference;
        if (!varRef) {
          // If variablesReference was not provided directly, inspect scopes for the frame
          const scopesRes = await session.customRequest('scopes', { frameId: req.frameId });
          const scopes = scopesRes?.scopes || [];
          if (scopes.length > 0 && scopes[0]?.variablesReference) {
            varRef = scopes[0].variablesReference;
          }
        }

        if (varRef) {
          const varsRes = await session.customRequest('variables', { variablesReference: varRef });
          const rawVars = varsRes?.variables || [];
          for (const v of rawVars.slice(0, 50)) {
            variables.push({
              name: v.name,
              value: String(v.value),
              type: v.type,
              variablesReference: v.variablesReference > 0 ? v.variablesReference : undefined,
            });
          }
        }
      } catch {
        // Ignored
      }
    }

    const response: DebugVariablesRes = {
      v: PROTOCOL_VERSION,
      type: 'debug.variables.res',
      id: req.id,
      variables,
    };
    this.connection.send(response);
  }

  private async handleStep(req: DebugStepReq): Promise<void> {
    try {
      switch (req.action) {
        case 'continue':
          await vscode.commands.executeCommand('workbench.action.debug.continue');
          break;
        case 'next':
          await vscode.commands.executeCommand('workbench.action.debug.stepOver');
          break;
        case 'stepIn':
          await vscode.commands.executeCommand('workbench.action.debug.stepInto');
          break;
        case 'stepOut':
          await vscode.commands.executeCommand('workbench.action.debug.stepOut');
          break;
        case 'pause':
          await vscode.commands.executeCommand('workbench.action.debug.pause');
          break;
        case 'restart':
          await vscode.commands.executeCommand('workbench.action.debug.restart');
          break;
        case 'stop':
          await vscode.commands.executeCommand('workbench.action.debug.stop');
          break;
      }

      const res: DebugStepRes = {
        v: PROTOCOL_VERSION,
        type: 'debug.step.res',
        id: req.id,
        success: true,
      };
      this.connection.send(res);
    } catch (err) {
      const res: DebugStepRes = {
        v: PROTOCOL_VERSION,
        type: 'debug.step.res',
        id: req.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this.connection.send(res);
    }
  }

  private registerBreakpointSync(): void {
    // Sync host breakpoints to all guests
    this.disposables.push(
      vscode.debug.onDidChangeBreakpoints(() => {
        this.syncBreakpointsToSession();
      }),
    );

    // Initial sync
    this.syncBreakpointsToSession();
  }

  private syncBreakpointsToSession(): void {
    const breakpoints: DebugBreakpoint[] = [];
    for (const bp of vscode.debug.breakpoints) {
      if ('location' in bp) {
        const sourceBp = bp as vscode.SourceBreakpoint;
        const rel = path.relative(this.workspaceRoot, sourceBp.location.uri.fsPath).replace(/\\/g, '/');
        if (!rel.startsWith('..')) {
          breakpoints.push({
            id: bp.id,
            path: rel,
            line: sourceBp.location.range.start.line + 1,
            enabled: bp.enabled,
            condition: sourceBp.condition,
            hitCondition: sourceBp.hitCondition,
            logMessage: sourceBp.logMessage,
          });
        }
      }
    }

    const syncMsg: DebugBreakpointsSync = {
      v: PROTOCOL_VERSION,
      type: 'debug.breakpoints',
      breakpoints,
    };
    this.connection.send(syncMsg);
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
