import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Logger } from './logger.js';
import { TunnelManager } from './tunnel/TunnelManager.js';

export interface OsDependencyInfo {
  platformName: string;
  arch: string;
  command: string;
  isSupported: boolean;
}

/**
 * Identifies the current OS and architecture, and returns the appropriate install command for cloudflared.
 */
export function getOsInstallCommand(): OsDependencyInfo {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'linux') {
    const binName = arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
    return {
      platformName: `Linux (${arch})`,
      arch,
      command: `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/${binName} -o /tmp/cloudflared && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared`,
      isSupported: true,
    };
  }

  if (platform === 'darwin') {
    return {
      platformName: `macOS (${arch})`,
      arch,
      command: 'brew install cloudflared || (curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64 -o /tmp/cloudflared && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared)',
      isSupported: true,
    };
  }

  if (platform === 'win32') {
    return {
      platformName: `Windows (${arch})`,
      arch,
      command: 'winget install --id Cloudflare.cloudflared',
      isSupported: true,
    };
  }

  return {
    platformName: `${platform} (${arch})`,
    arch,
    command: 'See: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/',
    isSupported: false,
  };
}

/**
 * Automatically prompts or installs missing dependencies (cloudflared).
 */
export async function promptOrInstallDependencies(
  tunnelManager: TunnelManager,
  interactive = true,
): Promise<boolean> {
  const isAvailable = await tunnelManager.isCloudflaredAvailable();
  if (isAvailable) {
    if (interactive) {
      vscode.window.showInformationMessage('CoLive: All required dependencies (cloudflared) are installed and ready!');
    }
    return true;
  }

  const osInfo = getOsInstallCommand();
  Logger.info(`Dependency 'cloudflared' missing on ${osInfo.platformName}.`);

  const choice = await vscode.window.showWarningMessage(
    `CoLive: The worldwide tunnel utility (cloudflared) is not installed on your system (${osInfo.platformName}).`,
    'Auto-Install Now',
    'Run in Terminal',
    'Copy Command',
    'Show Logs',
  );

  if (choice === 'Show Logs') {
    Logger.show();
    return false;
  }

  if (choice === 'Copy Command') {
    await vscode.env.clipboard.writeText(osInfo.command);
    vscode.window.showInformationMessage(`Copied install command for ${osInfo.platformName} to clipboard!`);
    return false;
  }

  if (choice === 'Run in Terminal') {
    const term = vscode.window.createTerminal('CoLive Dependency Installer');
    term.show();
    term.sendText(osInfo.command);
    return false;
  }

  if (choice === 'Auto-Install Now') {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CoLive: Installing cloudflared...',
        cancellable: false,
      },
      async (progress) => {
        try {
          const bin = await tunnelManager.ensureCloudflared((msg) => progress.report({ message: msg }));
          if (bin) {
            vscode.window.showInformationMessage('CoLive: Cloudflare Tunnel utility installed successfully!');
            return true;
          } else {
            vscode.window.showErrorMessage(
              `Auto-install failed. Please run this command in terminal:\n\n${osInfo.command}`,
              'Copy Command',
            ).then((c) => {
              if (c === 'Copy Command') vscode.env.clipboard.writeText(osInfo.command);
            });
            return false;
          }
        } catch (err) {
          Logger.error('Auto-install error', err);
          vscode.window.showErrorMessage(`Installation failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      },
    );
  }

  return false;
}

/**
 * Sanitizes and translates technical network/protocol errors into human-understandable guidance.
 */
export function formatFriendlyErrorMessage(err: unknown, contextUrl?: string): string {
  const raw = err instanceof Error ? err.message : String(err || '');

  if (raw.includes('530') || raw.includes('520') || raw.includes('502') || raw.includes('503')) {
    return `The Cloudflare session endpoint (${contextUrl || 'tunnel'}) is not reachable (Cloudflare edge status). The session may have ended or the tunnel is still initializing. Please verify the invite link or ask the host to re-share.`;
  }

  if (raw.includes('ENOTFOUND')) {
    return `Could not reach collaboration server (${contextUrl || ''}). The server hostname could not be found. Please check your internet connection or invite link.`;
  }

  if (raw.includes('ECONNREFUSED')) {
    return 'Could not connect to the local CoLive relay server on 127.0.0.1:8787. Please ensure the relay server is running or click "Share Workspace" to start it.';
  }

  if (raw.includes('ETIMEDOUT') || raw.includes('timed out')) {
    return `Connection timed out while reaching ${contextUrl || 'collaboration server'}. Please check your network connection or firewall.`;
  }

  if (raw.includes('folderName')) {
    return 'Workspace initialization note: Virtual folder mounting refreshed.';
  }

  return raw;
}
