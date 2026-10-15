import * as vscode from 'vscode';
import {
  DiagnosticItem,
  DiagnosticsUpdate,
  normalizeWorkspacePath,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { trailingThrottle } from '../presence/throttle.js';

export function vsCodeSeverityToNumber(severity: vscode.DiagnosticSeverity): number {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 0;
    case vscode.DiagnosticSeverity.Warning:
      return 1;
    case vscode.DiagnosticSeverity.Information:
      return 2;
    case vscode.DiagnosticSeverity.Hint:
      return 3;
    default:
      return 0;
  }
}

export function numberToVsCodeSeverity(num: number): vscode.DiagnosticSeverity {
  switch (num) {
    case 0:
      return vscode.DiagnosticSeverity.Error;
    case 1:
      return vscode.DiagnosticSeverity.Warning;
    case 2:
      return vscode.DiagnosticSeverity.Information;
    case 3:
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

export function convertVsCodeDiagnosticsToItems(
  diagnostics: vscode.Diagnostic[],
): DiagnosticItem[] {
  return diagnostics.map((d) => ({
    range: {
      startLine: d.range.start.line,
      startChar: d.range.start.character,
      endLine: d.range.end.line,
      endChar: d.range.end.character,
    },
    severity: vsCodeSeverityToNumber(d.severity),
    message: d.message,
    source: d.source,
    code: typeof d.code === 'object' && d.code ? (d.code as any).value : (d.code as any),
  }));
}

export function convertItemsToVsCodeDiagnostics(
  items: DiagnosticItem[],
): vscode.Diagnostic[] {
  return items.map((item) => {
    const range = new vscode.Range(
      item.range.startLine,
      item.range.startChar,
      item.range.endLine,
      item.range.endChar,
    );
    const diag = new vscode.Diagnostic(
      range,
      item.message,
      numberToVsCodeSeverity(item.severity),
    );
    diag.source = item.source ? `CoLive (${item.source})` : 'CoLive (host)';
    if (item.code !== undefined) {
      diag.code = item.code;
    }
    return diag;
  });
}

/**
 * Host diagnostics broadcaster: monitors diagnostics changes on the host,
 * throttles sending by 500ms, and broadcasts to guests.
 */
export class HostDiagnosticsBroadcaster implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private throttledSend: (uri: vscode.Uri) => void;

  constructor(
    private readonly connection: ConnectionManager,
    private readonly workspaceRoot: string,
  ) {
    this.throttledSend = trailingThrottle((uri: vscode.Uri) => {
      this.broadcastFileDiagnostics(uri);
    }, 500);

    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        for (const uri of e.uris) {
          if (uri.scheme === 'file' && uri.fsPath.startsWith(this.workspaceRoot)) {
            this.throttledSend(uri);
          }
        }
      }),
    );
  }

  private broadcastFileDiagnostics(uri: vscode.Uri): void {
    const rel = uri.fsPath.slice(this.workspaceRoot.length).replace(/^[/\\]+/, '');
    const normPath = normalizeWorkspacePath(rel);

    const vsDiags = vscode.languages.getDiagnostics(uri);
    const items = convertVsCodeDiagnosticsToItems(vsDiags);

    const updateMsg: DiagnosticsUpdate = {
      v: PROTOCOL_VERSION,
      type: 'diagnostics.update',
      path: normPath,
      items,
    };

    this.connection.send(updateMsg);
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d?.dispose();
    }
    this.disposables = [];
  }
}

/**
 * Guest diagnostics receiver: receives host diagnostics updates and publishes
 * them into a DiagnosticCollection for the guest's virtual filesystem URIs.
 */
export class GuestDiagnosticsReceiver implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly connection: ConnectionManager,
    private readonly folderName: string,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection('CoLive (host)');
    this.disposables.push(this.collection);

    this.disposables.push(
      this.connection.onMessage((msg) => {
        if (msg.type === 'diagnostics.update') {
          this.handleDiagnosticsUpdate(msg);
        }
      }),
    );
  }

  private handleDiagnosticsUpdate(msg: DiagnosticsUpdate): void {
    const virtualUri = vscode.Uri.parse(`colive:/${encodeURIComponent(this.folderName)}/${msg.path}`);
    const diags = convertItemsToVsCodeDiagnostics(msg.items);
    this.collection.set(virtualUri, diags);
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d?.dispose();
    }
    this.disposables = [];
  }
}
