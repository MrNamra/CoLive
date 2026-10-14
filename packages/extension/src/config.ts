import * as vscode from 'vscode';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Permission } from '@colive/protocol';

export interface ExtensionConfig {
  serverUrl: string;
  displayName: string;
  excludePatterns: string[];
  maxFileSizeMB: number;
  defaultGuestPermission: Permission;
  requireJoinApproval: boolean;
  allowReadOnlyComments: boolean;
  userColor?: string;
  e2ee: boolean;
}

export function getExtensionConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('colive');
  let serverUrl = cfg.get<string>('serverUrl', 'ws://localhost:8787/ws');

  // Auto-discover local Cloudflare .tunnel-url if configured to default localhost
  if (serverUrl === 'ws://localhost:8787/ws') {
    const candidatePaths: string[] = [];
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        candidatePaths.push(path.join(folder.uri.fsPath, '.tunnel-url'));
      }
    }
    candidatePaths.push('/tmp/colive-tunnel-url');
    try {
      candidatePaths.push(path.join(os.homedir(), '.colive-tunnel-url'));
    } catch {
      // ignore
    }

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf8').trim();
          if (content.startsWith('ws://') || content.startsWith('wss://')) {
            serverUrl = content;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    serverUrl,
    displayName: cfg.get<string>('displayName', ''),
    excludePatterns: cfg.get<string[]>('excludePatterns', [
      '.git/**',
      'node_modules/**',
      '.env*',
      '**/*.pem',
      '**/*.key',
      '**/id_rsa*',
      'dist/**',
      'out/**',
      '.vscode/**',
    ]),
    maxFileSizeMB: cfg.get<number>('maxFileSizeMB', 5),
    defaultGuestPermission: cfg.get<Permission>('defaultGuestPermission', 'readWrite'),
    requireJoinApproval: cfg.get<boolean>('requireJoinApproval', true),
    allowReadOnlyComments: cfg.get<boolean>('allowReadOnlyComments', true),
    userColor: cfg.get<string>('userColor', ''),
    e2ee: cfg.get<boolean>('e2ee', true),
  };
}

export async function resolveDisplayName(): Promise<string> {
  const config = getExtensionConfig();
  if (config.displayName.trim()) {
    return config.displayName.trim();
  }

  // Fallback to OS username
  const osUser = os.userInfo().username || 'Developer';
  return osUser;
}
