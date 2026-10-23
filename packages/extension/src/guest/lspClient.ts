import * as vscode from 'vscode';
import {
  LspCompletionReq,
  LspCompletionRes,
  LspDefinitionReq,
  LspDefinitionRes,
  LspHoverReq,
  LspHoverRes,
  LspReferencesReq,
  LspReferencesRes,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { Logger } from '../logger.js';

/**
 * GuestLspClient registers VS Code language feature providers for the 'colive' scheme
 * and forwards IntelliSense queries to the host machine.
 */
export class GuestLspClient implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly workspaceName: string,
    private readonly connection: ConnectionManager,
  ) {
    this.registerProviders();
  }

  private extractRelativePath(uri: vscode.Uri): string {
    let p = uri.path.replace(/^\/+/, '');
    const firstSlash = p.indexOf('/');
    if (firstSlash >= 0) {
      p = p.slice(firstSlash + 1);
    }
    return p;
  }

  private registerProviders(): void {
    const documentSelector: vscode.DocumentSelector = { scheme: 'colive' };

    // 1. Hover Provider
    const hoverProvider: vscode.HoverProvider = {
      provideHover: async (document, position) => {
        const relPath = this.extractRelativePath(document.uri);
        if (!relPath) return undefined;

        try {
          const req: LspHoverReq = {
            v: PROTOCOL_VERSION,
            type: 'lsp.hover.req',
            id: `hover_${Math.random().toString(36).slice(2, 9)}`,
            path: relPath,
            position: { line: position.line, character: position.character },
          };

          const res = await this.connection.request<LspHoverRes>(req, 3000);
          if (!res.contents || res.contents.length === 0) {
            return undefined;
          }

          const markdowns = res.contents.map((c) => new vscode.MarkdownString(c));
          let range: vscode.Range | undefined;
          if (res.range) {
            range = new vscode.Range(
              res.range.startLine,
              res.range.startChar,
              res.range.endLine,
              res.range.endChar,
            );
          }

          return new vscode.Hover(markdowns, range);
        } catch {
          return undefined;
        }
      },
    };

    // 2. Completion Item Provider
    const completionProvider: vscode.CompletionItemProvider = {
      provideCompletionItems: async (document, position, _token, context) => {
        const relPath = this.extractRelativePath(document.uri);
        if (!relPath) return undefined;

        try {
          const req: LspCompletionReq = {
            v: PROTOCOL_VERSION,
            type: 'lsp.completion.req',
            id: `comp_${Math.random().toString(36).slice(2, 9)}`,
            path: relPath,
            position: { line: position.line, character: position.character },
            triggerCharacter: context.triggerCharacter,
          };

          const res = await this.connection.request<LspCompletionRes>(req, 3000);
          if (!res.items || res.items.length === 0) {
            return undefined;
          }

          const items = res.items.map((item) => {
            const ci = new vscode.CompletionItem(item.label, item.kind as vscode.CompletionItemKind);
            ci.detail = item.detail;
            if (item.documentation) {
              ci.documentation = new vscode.MarkdownString(item.documentation);
            }
            if (item.insertText) {
              ci.insertText = item.insertText;
            }
            if (item.sortText) {
              ci.sortText = item.sortText;
            }
            return ci;
          });

          return new vscode.CompletionList(items, false);
        } catch {
          return undefined;
        }
      },
    };

    // 3. Definition Provider
    const definitionProvider: vscode.DefinitionProvider = {
      provideDefinition: async (document, position) => {
        const relPath = this.extractRelativePath(document.uri);
        if (!relPath) return undefined;

        try {
          const req: LspDefinitionReq = {
            v: PROTOCOL_VERSION,
            type: 'lsp.definition.req',
            id: `def_${Math.random().toString(36).slice(2, 9)}`,
            path: relPath,
            position: { line: position.line, character: position.character },
          };

          const res = await this.connection.request<LspDefinitionRes>(req, 4000);
          if (!res.definitions || res.definitions.length === 0) {
            return undefined;
          }

          return res.definitions.map((d) => {
            const guestUri = vscode.Uri.parse(`colive:/${this.workspaceName}/${d.path}`);
            const range = new vscode.Range(
              d.range.startLine,
              d.range.startChar,
              d.range.endLine,
              d.range.endChar,
            );
            return new vscode.Location(guestUri, range);
          });
        } catch {
          return undefined;
        }
      },
    };

    // 4. Reference Provider
    const referenceProvider: vscode.ReferenceProvider = {
      provideReferences: async (document, position, context) => {
        const relPath = this.extractRelativePath(document.uri);
        if (!relPath) return undefined;

        try {
          const req: LspReferencesReq = {
            v: PROTOCOL_VERSION,
            type: 'lsp.references.req',
            id: `refs_${Math.random().toString(36).slice(2, 9)}`,
            path: relPath,
            position: { line: position.line, character: position.character },
            includeDeclaration: context.includeDeclaration,
          };

          const res = await this.connection.request<LspReferencesRes>(req, 5000);
          if (!res.references || res.references.length === 0) {
            return undefined;
          }

          return res.references.map((r) => {
            const guestUri = vscode.Uri.parse(`colive:/${this.workspaceName}/${r.path}`);
            const range = new vscode.Range(
              r.range.startLine,
              r.range.startChar,
              r.range.endLine,
              r.range.endChar,
            );
            return new vscode.Location(guestUri, range);
          });
        } catch {
          return undefined;
        }
      },
    };

    this.disposables.push(
      vscode.languages.registerHoverProvider(documentSelector, hoverProvider),
      vscode.languages.registerCompletionItemProvider(
        documentSelector,
        completionProvider,
        '.',
        ':',
        '(',
        '"',
        "'",
        '/',
        '<',
        '@',
      ),
      vscode.languages.registerDefinitionProvider(documentSelector, definitionProvider),
      vscode.languages.registerReferenceProvider(documentSelector, referenceProvider),
    );
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
