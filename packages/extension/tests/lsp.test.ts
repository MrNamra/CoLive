import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
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
import { HostLspProxy } from '../src/host/lspProxy.js';
import { GuestLspClient } from '../src/guest/lspClient.js';
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

describe('Phase 2: Language Feature Proxying (LSP Mirroring)', () => {
  const workspaceRoot = '/test/workspace';
  let mockConn: MockConnectionManager;

  beforeEach(() => {
    mockConn = new MockConnectionManager();
    vi.restoreAllMocks();
  });

  describe('HostLspProxy', () => {
    it('handles lsp.hover.req by querying host hover provider and returning serialized contents', async () => {
      const executeCommandSpy = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (cmd, ..._args) => {
        if (cmd === 'vscode.executeHoverProvider') {
          return [
            new vscode.Hover(['**function calculateSum(a: number, b: number): number**', 'Calculates sum'], new vscode.Range(2, 4, 2, 16)),
          ];
        }
        return undefined;
      });

      const proxy = new HostLspProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      const hoverReq: LspHoverReq = {
        v: PROTOCOL_VERSION,
        type: 'lsp.hover.req',
        id: 'hover_test_1',
        path: 'src/calc.ts',
        position: { line: 2, character: 6 },
      };

      mockConn.emit('message', hoverReq);

      // Wait a microtask for async message handling
      await new Promise((r) => setTimeout(r, 10));

      expect(executeCommandSpy).toHaveBeenCalledWith('vscode.executeHoverProvider', expect.anything(), expect.anything());
      expect(mockConn.sentMessages.length).toBe(1);

      const res = mockConn.sentMessages[0] as LspHoverRes;
      expect(res.type).toBe('lsp.hover.res');
      expect(res.id).toBe('hover_test_1');
      expect(res.contents).toContain('**function calculateSum(a: number, b: number): number**');
      expect(res.contents).toContain('Calculates sum');
      expect(res.range).toEqual({ startLine: 2, startChar: 4, endLine: 2, endChar: 16 });

      proxy.dispose();
    });

    it('handles lsp.completion.req by querying host completion provider and returning serialized items', async () => {
      vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (cmd) => {
        if (cmd === 'vscode.executeCompletionItemProvider') {
          const item1 = new vscode.CompletionItem('toString', vscode.CompletionItemKind.Method);
          item1.detail = '() => string';
          item1.documentation = new vscode.MarkdownString('Converts to string representation');
          return new vscode.CompletionList([item1], false);
        }
        return undefined;
      });

      const proxy = new HostLspProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      const compReq: LspCompletionReq = {
        v: PROTOCOL_VERSION,
        type: 'lsp.completion.req',
        id: 'comp_test_1',
        path: 'src/main.ts',
        position: { line: 10, character: 5 },
        triggerCharacter: '.',
      };

      mockConn.emit('message', compReq);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockConn.sentMessages.length).toBe(1);
      const res = mockConn.sentMessages[0] as LspCompletionRes;
      expect(res.type).toBe('lsp.completion.res');
      expect(res.id).toBe('comp_test_1');
      expect(res.items.length).toBe(1);
      expect(res.items[0]!.label).toBe('toString');
      expect(res.items[0]!.detail).toBe('() => string');
      expect(res.items[0]!.documentation).toBe('Converts to string representation');

      proxy.dispose();
    });

    it('handles lsp.definition.req by converting host file paths to workspace relative paths', async () => {
      vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (cmd) => {
        if (cmd === 'vscode.executeDefinitionProvider') {
          return [
            {
              targetUri: vscode.Uri.file('/test/workspace/src/types.ts'),
              targetRange: new vscode.Range(15, 0, 15, 20),
            },
          ];
        }
        return undefined;
      });

      const proxy = new HostLspProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      const defReq: LspDefinitionReq = {
        v: PROTOCOL_VERSION,
        type: 'lsp.definition.req',
        id: 'def_test_1',
        path: 'src/main.ts',
        position: { line: 5, character: 12 },
      };

      mockConn.emit('message', defReq);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockConn.sentMessages.length).toBe(1);
      const res = mockConn.sentMessages[0] as LspDefinitionRes;
      expect(res.type).toBe('lsp.definition.res');
      expect(res.definitions.length).toBe(1);
      expect(res.definitions[0]!.path).toBe('src/types.ts');
      expect(res.definitions[0]!.range).toEqual({
        startLine: 15,
        startChar: 0,
        endLine: 15,
        endChar: 20,
      });

      proxy.dispose();
    });

    it('handles lsp.references.req and maps references to workspace relative paths', async () => {
      vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (cmd) => {
        if (cmd === 'vscode.executeReferenceProvider') {
          return [
            new vscode.Location(vscode.Uri.file('/test/workspace/src/app.ts'), new vscode.Range(8, 2, 8, 14)),
          ];
        }
        return undefined;
      });

      const proxy = new HostLspProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      const refsReq: LspReferencesReq = {
        v: PROTOCOL_VERSION,
        type: 'lsp.references.req',
        id: 'refs_test_1',
        path: 'src/calc.ts',
        position: { line: 1, character: 10 },
      };

      mockConn.emit('message', refsReq);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockConn.sentMessages.length).toBe(1);
      const res = mockConn.sentMessages[0] as LspReferencesRes;
      expect(res.type).toBe('lsp.references.res');
      expect(res.references.length).toBe(1);
      expect(res.references[0]!.path).toBe('src/app.ts');
      expect(res.references[0]!.range.startLine).toBe(8);

      proxy.dispose();
    });

    it('gracefully sends internal error when execution fails', async () => {
      vi.spyOn(vscode.commands, 'executeCommand').mockRejectedValue(new Error('Language server crashed'));

      const proxy = new HostLspProxy(workspaceRoot, mockConn as unknown as ConnectionManager);

      const hoverReq: LspHoverReq = {
        v: PROTOCOL_VERSION,
        type: 'lsp.hover.req',
        id: 'hover_fail_1',
        path: 'src/calc.ts',
        position: { line: 1, character: 1 },
      };

      mockConn.emit('message', hoverReq);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockConn.sentMessages.length).toBe(1);
      const errMsg = mockConn.sentMessages[0] as { type: string; code: string };
      expect(errMsg.type).toBe('error');
      expect(errMsg.code).toBe('INTERNAL');

      proxy.dispose();
    });
  });

  describe('GuestLspClient', () => {
    it('registers providers and disposes cleanly', () => {
      const regHoverSpy = vi.spyOn(vscode.languages, 'registerHoverProvider');
      const regCompSpy = vi.spyOn(vscode.languages, 'registerCompletionItemProvider');
      const regDefSpy = vi.spyOn(vscode.languages, 'registerDefinitionProvider');
      const regRefSpy = vi.spyOn(vscode.languages, 'registerReferenceProvider');

      const client = new GuestLspClient('CoLive: Shared', mockConn as unknown as ConnectionManager);

      expect(regHoverSpy).toHaveBeenCalled();
      expect(regCompSpy).toHaveBeenCalled();
      expect(regDefSpy).toHaveBeenCalled();
      expect(regRefSpy).toHaveBeenCalled();

      client.dispose();
    });
  });
});
