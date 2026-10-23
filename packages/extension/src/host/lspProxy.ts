import * as vscode from 'vscode';
import path from 'node:path';
import {
  CoLiveError,
  LspCompletionReq,
  LspCompletionRes,
  LspDefinitionReq,
  LspDefinitionRes,
  LspHoverReq,
  LspHoverRes,
  LspLocation,
  LspReferencesReq,
  LspReferencesRes,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { Logger } from '../logger.js';

/**
 * HostLspProxy answers LSP mirroring queries from guests by executing VS Code's
 * built-in language provider commands on the host machine.
 */
export class HostLspProxy implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly workspaceRoot: string,
    private readonly connection: ConnectionManager,
  ) {
    this.registerHandler();
  }

  private registerHandler(): void {
    const sub = this.connection.on('message', async (msg) => {
      try {
        if (msg.type === 'lsp.hover.req') {
          await this.handleHover(msg as LspHoverReq);
        } else if (msg.type === 'lsp.completion.req') {
          await this.handleCompletion(msg as LspCompletionReq);
        } else if (msg.type === 'lsp.definition.req') {
          await this.handleDefinition(msg as LspDefinitionReq);
        } else if (msg.type === 'lsp.references.req') {
          await this.handleReferences(msg as LspReferencesReq);
        }
      } catch (err) {
        Logger.warn('HostLspProxy failed to handle request', { type: msg.type, err });
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

  private resolveUri(relPath: string): vscode.Uri {
    const fullPath = path.resolve(this.workspaceRoot, relPath);
    return vscode.Uri.file(fullPath);
  }

  private async handleHover(req: LspHoverReq): Promise<void> {
    const uri = this.resolveUri(req.path);
    const position = new vscode.Position(req.position.line, req.position.character);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      position,
    );

    const contents: string[] = [];
    let range: { startLine: number; startChar: number; endLine: number; endChar: number } | undefined;

    if (hovers && hovers.length > 0) {
      for (const h of hovers) {
        if (h.range && !range) {
          range = {
            startLine: h.range.start.line,
            startChar: h.range.start.character,
            endLine: h.range.end.line,
            endChar: h.range.end.character,
          };
        }
        for (const c of h.contents) {
          if (typeof c === 'string') {
            contents.push(c);
          } else if (c && typeof c === 'object' && 'value' in c) {
            contents.push(c.value);
          }
        }
      }
    }

    const res: LspHoverRes = {
      v: PROTOCOL_VERSION,
      type: 'lsp.hover.res',
      id: req.id,
      contents,
      range,
    };
    this.connection.send(res);
  }

  private async handleCompletion(req: LspCompletionReq): Promise<void> {
    const uri = this.resolveUri(req.path);
    const position = new vscode.Position(req.position.line, req.position.character);

    const completions = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>(
      'vscode.executeCompletionItemProvider',
      uri,
      position,
      req.triggerCharacter,
    );

    const rawItems = Array.isArray(completions) ? completions : completions?.items || [];
    const items = rawItems.slice(0, 100).map((item) => ({
      label: typeof item.label === 'string' ? item.label : item.label.label,
      kind: item.kind,
      detail: item.detail,
      documentation:
        typeof item.documentation === 'string'
          ? item.documentation
          : item.documentation?.value,
      insertText: typeof item.insertText === 'string' ? item.insertText : undefined,
      sortText: item.sortText,
    }));

    const res: LspCompletionRes = {
      v: PROTOCOL_VERSION,
      type: 'lsp.completion.res',
      id: req.id,
      items,
    };
    this.connection.send(res);
  }

  private async handleDefinition(req: LspDefinitionReq): Promise<void> {
    const uri = this.resolveUri(req.path);
    const position = new vscode.Position(req.position.line, req.position.character);

    const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );

    const definitions: LspLocation[] = [];
    if (defs) {
      for (const d of defs) {
        let targetUri: vscode.Uri;
        let r: vscode.Range;
        if ('targetUri' in d) {
          targetUri = d.targetUri;
          r = d.targetRange;
        } else {
          targetUri = d.uri;
          r = d.range;
        }

        const rel = path.relative(this.workspaceRoot, targetUri.fsPath).replace(/\\/g, '/');
        if (!rel.startsWith('..')) {
          definitions.push({
            path: rel,
            range: {
              startLine: r.start.line,
              startChar: r.start.character,
              endLine: r.end.line,
              endChar: r.end.character,
            },
          });
        }
      }
    }

    const res: LspDefinitionRes = {
      v: PROTOCOL_VERSION,
      type: 'lsp.definition.res',
      id: req.id,
      definitions,
    };
    this.connection.send(res);
  }

  private async handleReferences(req: LspReferencesReq): Promise<void> {
    const uri = this.resolveUri(req.path);
    const position = new vscode.Position(req.position.line, req.position.character);

    const refs = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      uri,
      position,
    );

    const references: LspLocation[] = [];
    if (refs) {
      for (const ref of refs) {
        const rel = path.relative(this.workspaceRoot, ref.uri.fsPath).replace(/\\/g, '/');
        if (!rel.startsWith('..')) {
          references.push({
            path: rel,
            range: {
              startLine: ref.range.start.line,
              startChar: ref.range.start.character,
              endLine: ref.range.end.line,
              endChar: ref.range.end.character,
            },
          });
        }
      }
    }

    const res: LspReferencesRes = {
      v: PROTOCOL_VERSION,
      type: 'lsp.references.res',
      id: req.id,
      references,
    };
    this.connection.send(res);
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
