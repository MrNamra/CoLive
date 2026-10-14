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
  let serverUrl = cfg.get<string>('serverUrl', 'ws://127.0.0.1:8787/ws');

  // trycloudflare.com URLs are ephemeral and die when the session ends.
  // Never persist or treat stale trycloudflare.com URLs as default relay.
  if (serverUrl.includes('trycloudflare.com') || serverUrl === 'ws://localhost:8787/ws') {
    serverUrl = 'ws://127.0.0.1:8787/ws';
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
