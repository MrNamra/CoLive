import * as vscode from 'vscode';
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

export interface DebugItemNode {
  id: string;
  label: string;
  description?: string;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  iconPath?: vscode.ThemeIcon;
  command?: vscode.Command;
  children?: DebugItemNode[];
}

/**
 * GuestDebugClient handles debug state mirroring, call stack and variable inspection,
 * and controls for the guest editor.
 */
export class GuestDebugClient implements vscode.TreeDataProvider<DebugItemNode>, vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private _onDidChangeTreeData = new vscode.EventEmitter<DebugItemNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  public state: 'inactive' | 'running' | 'stopped' = 'inactive';
  public sessionName?: string;
  public reason?: string;
  public threadId?: number;
  public stoppedFile?: string;
  public stoppedLine?: number;
  public breakpoints: DebugBreakpoint[] = [];

  constructor(
    private readonly workspaceName: string,
    private readonly connection: ConnectionManager,
  ) {
    this.registerConnectionEvents();
    this.registerCommands();
  }

  private registerConnectionEvents(): void {
    const sub = this.connection.on('message', async (msg) => {
      if (msg.type === 'debug.state') {
        const stateMsg = msg as DebugStateBroadcast;
        this.state = stateMsg.state;
        this.sessionName = stateMsg.sessionName;
        this.reason = stateMsg.reason;
        this.threadId = stateMsg.threadId;
        this.stoppedFile = stateMsg.file;
        this.stoppedLine = stateMsg.line;

        this._onDidChangeTreeData.fire();

        if (this.state === 'stopped' && this.stoppedFile && this.stoppedLine) {
          await this.navigateToStoppedLocation(this.stoppedFile, this.stoppedLine);
        }
      } else if (msg.type === 'debug.breakpoints') {
        const bpMsg = msg as DebugBreakpointsSync;
        this.breakpoints = bpMsg.breakpoints;
        this._onDidChangeTreeData.fire();
      }
    });

    this.disposables.push(sub);
  }

  private async navigateToStoppedLocation(relPath: string, line: number): Promise<void> {
    try {
      const uri = vscode.Uri.parse(`colive:/${this.workspaceName}/${relPath}`);
      const doc = await vscode.workspace.openTextDocument(uri);
      const targetLine = Math.max(0, line - 1);
      const pos = new vscode.Position(targetLine, 0);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(pos, pos),
        preserveFocus: false,
        preview: true,
      });
    } catch {
      // Ignored
    }
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('colive.debugContinue', async () => {
        await this.step('continue');
      }),
      vscode.commands.registerCommand('colive.debugStepOver', async () => {
        await this.step('next');
      }),
      vscode.commands.registerCommand('colive.debugStepInto', async () => {
        await this.step('stepIn');
      }),
      vscode.commands.registerCommand('colive.debugStepOut', async () => {
        await this.step('stepOut');
      }),
      vscode.commands.registerCommand('colive.debugPause', async () => {
        await this.step('pause');
      }),
    );
  }

  public async step(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'): Promise<boolean> {
    try {
      const req: DebugStepReq = {
        v: PROTOCOL_VERSION,
        type: 'debug.step.req',
        id: `step_${Math.random().toString(36).slice(2, 9)}`,
        action,
      };

      const res = await this.connection.request<DebugStepRes>(req, 5000);
      return res.success;
    } catch (err) {
      vscode.window.showErrorMessage(`Debug step action failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  public async getTreeItem(element: DebugItemNode): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.description = element.description;
    item.iconPath = element.iconPath;
    item.command = element.command;
    return item;
  }

  public async getChildren(element?: DebugItemNode): Promise<DebugItemNode[]> {
    if (!element) {
      // Top-level root categories
      let statusLabel = 'No active debug session';
      let statusIcon = new vscode.ThemeIcon('debug-stop');

      if (this.state === 'running') {
        statusLabel = `Running (${this.sessionName || 'Active'})`;
        statusIcon = new vscode.ThemeIcon('debug-start');
      } else if (this.state === 'stopped') {
        statusLabel = `Stopped at ${this.stoppedFile || 'code'}:${this.stoppedLine || 1} (${this.reason || 'breakpoint'})`;
        statusIcon = new vscode.ThemeIcon('debug-pause');
      }

      const rootNodes: DebugItemNode[] = [
        {
          id: 'status',
          label: statusLabel,
          iconPath: statusIcon,
          collapsibleState: vscode.TreeItemCollapsibleState.None,
        },
      ];

      if (this.state === 'stopped') {
        rootNodes.push(
          {
            id: 'callstack',
            label: 'Call Stack',
            iconPath: new vscode.ThemeIcon('list-tree'),
            collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
          },
          {
            id: 'variables',
            label: 'Variables',
            iconPath: new vscode.ThemeIcon('symbol-variable'),
            collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
          },
        );
      }

      if (this.breakpoints.length > 0) {
        rootNodes.push({
          id: 'breakpoints',
          label: `Breakpoints (${this.breakpoints.length})`,
          iconPath: new vscode.ThemeIcon('debug-breakpoint'),
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        });
      }

      return rootNodes;
    }

    if (element.id === 'callstack') {
      return this.fetchCallStack();
    }

    if (element.id === 'variables') {
      return this.fetchVariables();
    }

    if (element.id === 'breakpoints') {
      return this.breakpoints.map((bp) => ({
        id: `bp_${bp.id}`,
        label: `${bp.path}:${bp.line}`,
        description: bp.enabled ? 'Enabled' : 'Disabled',
        iconPath: new vscode.ThemeIcon(bp.enabled ? 'debug-breakpoint' : 'debug-breakpoint-disabled'),
        command: {
          command: 'vscode.open',
          title: 'Open File',
          arguments: [
            vscode.Uri.parse(`colive:/${this.workspaceName}/${bp.path}`),
            {
              selection: new vscode.Range(bp.line - 1, 0, bp.line - 1, 0),
            },
          ],
        },
      }));
    }

    return [];
  }

  private async fetchCallStack(): Promise<DebugItemNode[]> {
    try {
      const req: DebugStackReq = {
        v: PROTOCOL_VERSION,
        type: 'debug.stack.req',
        id: `stack_${Math.random().toString(36).slice(2, 9)}`,
        threadId: this.threadId,
      };

      const res = await this.connection.request<DebugStackRes>(req, 3000);
      if (!res.frames || res.frames.length === 0) {
        return [{ id: 'empty_stack', label: 'No frames available' }];
      }

      return res.frames.map((f: DebugStackFrame) => ({
        id: `frame_${f.id}`,
        label: f.name,
        description: f.file ? `${f.file}:${f.line || 1}` : undefined,
        iconPath: new vscode.ThemeIcon('debug-stackframe'),
        command: f.file
          ? {
              command: 'vscode.open',
              title: 'Open Frame',
              arguments: [
                vscode.Uri.parse(`colive:/${this.workspaceName}/${f.file}`),
                {
                  selection: new vscode.Range((f.line || 1) - 1, (f.column || 1) - 1, (f.line || 1) - 1, (f.column || 1) - 1),
                },
              ],
            }
          : undefined,
      }));
    } catch (err) {
      return [{ id: 'stack_err', label: 'Failed to load stack trace' }];
    }
  }

  private async fetchVariables(): Promise<DebugItemNode[]> {
    try {
      const req: DebugVariablesReq = {
        v: PROTOCOL_VERSION,
        type: 'debug.variables.req',
        id: `vars_${Math.random().toString(36).slice(2, 9)}`,
        frameId: 1000,
      };

      const res = await this.connection.request<DebugVariablesRes>(req, 3000);
      if (!res.variables || res.variables.length === 0) {
        return [{ id: 'empty_vars', label: 'No local variables' }];
      }

      return res.variables.map((v: DebugVariable) => ({
        id: `var_${v.name}`,
        label: `${v.name}: ${v.value}`,
        description: v.type,
        iconPath: new vscode.ThemeIcon('symbol-variable'),
      }));
    } catch (err) {
      return [{ id: 'vars_err', label: 'Failed to load variables' }];
    }
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this._onDidChangeTreeData.dispose();
  }
}
