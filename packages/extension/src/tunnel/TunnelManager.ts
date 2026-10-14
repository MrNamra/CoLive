import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, ServerInstance } from '@colive/server';
import { Logger } from '../logger.js';
import { normalizeServerWsUrl } from '../invite.js';

export class TunnelManager implements vscode.Disposable {
  private serverInstance: ServerInstance | null = null;
  private tunnelProcess: ChildProcess | null = null;
  private activeTunnelUrl: string | null = null;
  private activeWsUrl: string | null = null;

  public async isCloudflaredAvailable(): Promise<boolean> {
    const candidates = ['cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
    for (const bin of candidates) {
      try {
        const proc = spawn(bin, ['--version']);
        const exitCode = await new Promise<number>((resolve) => {
          proc.on('error', () => resolve(1));
          proc.on('close', (code) => resolve(code ?? 0));
        });
        if (exitCode === 0) {
          return true;
        }
      } catch {
        // continue
      }
    }
    return false;
  }

  public async isPortOpen(port = 8787): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/health',
          method: 'GET',
          timeout: 1000,
        },
        (res) => {
          resolve(res.statusCode === 200);
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  public async pingEndpoint(urlStr: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const parsed = new URL(urlStr);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request(
          parsed,
          {
            method: 'GET',
            timeout: 2000,
          },
          (res) => {
            resolve(res.statusCode === 200);
          },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      } catch {
        resolve(false);
      }
    });
  }

  public async ensureLocalServer(port = 8787): Promise<void> {
    const isOpen = await this.isPortOpen(port);
    if (isOpen) {
      Logger.info(`Local relay server already active on port ${port}`);
      return;
    }

    Logger.info(`Starting embedded CoLive relay server on port ${port}...`);
    this.serverInstance = await createServer(port);
    Logger.info(`Embedded CoLive relay server listening on port ${port}`);
  }

  public async startTunnel(port = 8787): Promise<string> {
    // If already running and valid, return cached WS URL
    if (this.activeWsUrl && this.tunnelProcess && !this.tunnelProcess.killed) {
      return this.activeWsUrl;
    }

    // 1. Ensure local relay is up
    await this.ensureLocalServer(port);

    // 2. Spawn cloudflared tunnel
    Logger.info(`Spawning cloudflared tunnel to http://127.0.0.1:${port}...`);
    const bin = 'cloudflared';
    const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`]);
    this.tunnelProcess = proc;

    return new Promise<string>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stopTunnel();
          reject(new Error('Cloudflare Tunnel timed out after 30 seconds waiting for public URL.'));
        }
      }, 30000);

      const checkOutput = (data: Buffer | string) => {
        if (resolved) return;
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
          resolved = true;
          clearTimeout(timeout);
          const webUrl = match[0];
          const wsUrl = normalizeServerWsUrl(webUrl);
          this.activeTunnelUrl = webUrl;
          this.activeWsUrl = wsUrl;

          this.saveTunnelUrls(wsUrl);
          Logger.info(`Cloudflare Tunnel discovered: ${webUrl} -> ${wsUrl}`);

          // Warm up edge to ensure DNS and edge proxying have propagated before returning
          (async () => {
            for (let i = 0; i < 8; i++) {
              const ok = await this.pingEndpoint(`${webUrl}/health`);
              if (ok) {
                Logger.info('Cloudflare edge confirmed ready (HTTP 200).');
                break;
              }
              await new Promise((r) => setTimeout(r, 400));
            }
            resolve(wsUrl);
          })();
        }
      };

      proc.stdout?.on('data', checkOutput);
      proc.stderr?.on('data', checkOutput);

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start cloudflared: ${err.message}`));
        }
      });

      proc.on('close', (code) => {
        Logger.info(`cloudflared exited with code ${code}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited unexpectedly with code ${code}`));
        }
      });
    });
  }

  private saveTunnelUrls(wsUrl: string): void {
    const candidatePaths: string[] = ['/tmp/colive-tunnel-url'];
    try {
      candidatePaths.push(path.join(os.homedir(), '.colive-tunnel-url'));
    } catch {
      // ignore
    }
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        candidatePaths.push(path.join(folder.uri.fsPath, '.tunnel-url'));
      }
    }

    for (const p of candidatePaths) {
      try {
        fs.writeFileSync(p, wsUrl, 'utf8');
      } catch {
        // ignore
      }
    }
  }

  private cleanTunnelUrls(): void {
    const candidatePaths: string[] = ['/tmp/colive-tunnel-url'];
    try {
      candidatePaths.push(path.join(os.homedir(), '.colive-tunnel-url'));
    } catch {
      // ignore
    }
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        candidatePaths.push(path.join(folder.uri.fsPath, '.tunnel-url'));
      }
    }

    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }

  public stopTunnel(): void {
    if (this.tunnelProcess) {
      try {
        this.tunnelProcess.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.tunnelProcess = null;
    }
    if (this.serverInstance) {
      try {
        this.serverInstance.close();
      } catch {
        // ignore
      }
      this.serverInstance = null;
    }
    this.activeTunnelUrl = null;
    this.activeWsUrl = null;
    this.cleanTunnelUrls();
  }

  public getActiveTunnelUrl(): string | null {
    return this.activeTunnelUrl;
  }

  public getActiveWsUrl(): string | null {
    return this.activeWsUrl;
  }

  public dispose(): void {
    this.stopTunnel();
  }
}
