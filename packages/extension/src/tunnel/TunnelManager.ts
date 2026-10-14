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
  private storagePath?: string;

  constructor(storagePath?: string) {
    this.storagePath = storagePath;
  }

  public async canRunBinary(binPath: string): Promise<boolean> {
    try {
      const proc = spawn(binPath, ['--version']);
      const exitCode = await new Promise<number>((resolve) => {
        proc.on('error', () => resolve(1));
        proc.on('close', (code) => resolve(code ?? 0));
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  public async getCloudflaredBinaryPath(): Promise<string | null> {
    const isWin = os.platform() === 'win32';
    const binaryName = isWin ? 'cloudflared.exe' : 'cloudflared';

    // 1. Check system PATH and common directories
    const candidates = isWin
      ? ['cloudflared.exe', 'cloudflared', 'C:\\Program Files\\cloudflared\\cloudflared.exe']
      : [
          'cloudflared',
          '/usr/local/bin/cloudflared',
          '/usr/bin/cloudflared',
          '/opt/homebrew/bin/cloudflared',
          path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
        ];

    for (const bin of candidates) {
      if (await this.canRunBinary(bin)) {
        return bin;
      }
    }

    // 2. Check extension storage bin directory
    if (this.storagePath) {
      const extBin = path.join(this.storagePath, 'bin', binaryName);
      if (fs.existsSync(extBin) && (await this.canRunBinary(extBin))) {
        return extBin;
      }
    }

    return null;
  }

  public async isCloudflaredAvailable(): Promise<boolean> {
    const bin = await this.getCloudflaredBinaryPath();
    return bin !== null;
  }

  private getCloudflaredDownloadUrl(): string | null {
    const platform = os.platform();
    const arch = os.arch();

    const baseUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

    if (platform === 'linux') {
      if (arch === 'x64') return `${baseUrl}/cloudflared-linux-amd64`;
      if (arch === 'arm64') return `${baseUrl}/cloudflared-linux-arm64`;
      if (arch === 'arm') return `${baseUrl}/cloudflared-linux-arm`;
      return `${baseUrl}/cloudflared-linux-amd64`;
    }

    if (platform === 'win32') {
      if (arch === 'x64') return `${baseUrl}/cloudflared-windows-amd64.exe`;
      return `${baseUrl}/cloudflared-windows-386.exe`;
    }

    if (platform === 'darwin') {
      // macOS standalone binaries
      return `${baseUrl}/cloudflared-darwin-amd64`;
    }

    return null;
  }

  private async downloadFile(
    urlStr: string,
    destPath: string,
    progress?: (msg: string) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const fetchUrl = (currentUrl: string, redirects = 0) => {
        if (redirects > 6) {
          reject(new Error('Too many redirects while downloading cloudflared helper.'));
          return;
        }

        const parsed = new URL(currentUrl);
        const client = parsed.protocol === 'https:' ? https : http;

        const req = client.get(currentUrl, { timeout: 45000 }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, currentUrl).toString();
            fetchUrl(redirectUrl, redirects + 1);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Download failed with HTTP ${res.statusCode}`));
            return;
          }

          const file = fs.createWriteStream(destPath);
          let received = 0;
          const total = parseInt(res.headers['content-length'] || '0', 10);

          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (total > 0 && progress) {
              const pct = Math.round((received / total) * 100);
              progress(`Downloading Cloudflare Tunnel helper... ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
            }
          });

          res.pipe(file);

          file.on('finish', () => {
            file.close(() => resolve());
          });

          file.on('error', (err) => {
            try {
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            } catch {
              // ignore
            }
            reject(err);
          });
        });

        req.on('error', (err) => {
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          } catch {
            // ignore
          }
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          } catch {
            // ignore
          }
          reject(new Error('Download timed out'));
        });
      };

      fetchUrl(urlStr);
    });
  }

  public async ensureCloudflared(progress?: (msg: string) => void): Promise<string | null> {
    const existing = await this.getCloudflaredBinaryPath();
    if (existing) {
      return existing;
    }

    if (!this.storagePath) {
      Logger.warn('No storage path provided to TunnelManager for downloading cloudflared');
      return null;
    }

    const downloadUrl = this.getCloudflaredDownloadUrl();
    if (!downloadUrl) {
      Logger.warn(`No official cloudflared binary available for ${os.platform()}-${os.arch()}`);
      return null;
    }

    const isWin = os.platform() === 'win32';
    const binaryName = isWin ? 'cloudflared.exe' : 'cloudflared';
    const binDir = path.join(this.storagePath, 'bin');
    const targetFile = path.join(binDir, binaryName);

    try {
      if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
      }

      Logger.info(`Auto-downloading cloudflared from ${downloadUrl} to ${targetFile}...`);
      progress?.('Downloading Cloudflare Tunnel helper...');
      await this.downloadFile(downloadUrl, targetFile, progress);

      if (!isWin) {
        fs.chmodSync(targetFile, 0o755);
      }

      if (await this.canRunBinary(targetFile)) {
        Logger.info(`cloudflared binary ready and verified at ${targetFile}`);
        return targetFile;
      } else {
        Logger.warn(`cloudflared downloaded to ${targetFile} but execution failed.`);
        return null;
      }
    } catch (err) {
      Logger.warn('Failed to auto-download cloudflared', {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
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
            timeout: 2500,
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
    Logger.info(`Embedded CoLive relay server listening on 127.0.0.1:${port}`);
  }

  public async startTunnel(port = 8787, binaryOverride?: string): Promise<string> {
    // If already running and valid, return cached WS URL
    if (this.activeWsUrl && this.tunnelProcess && !this.tunnelProcess.killed) {
      return this.activeWsUrl;
    }

    // 1. Ensure local relay is up
    await this.ensureLocalServer(port);

    // 2. Determine binary to execute
    const bin = binaryOverride || (await this.getCloudflaredBinaryPath()) || 'cloudflared';
    Logger.info(`Spawning cloudflared tunnel using '${bin}' to http://127.0.0.1:${port}...`);
    const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`]);
    this.tunnelProcess = proc;

    return new Promise<string>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stopTunnel();
          reject(new Error('Cloudflare Tunnel timed out after 35 seconds waiting for public URL.'));
        }
      }, 35000);

      const checkOutput = (data: Buffer | string) => {
        const text = data.toString();
        // Log tunnel messages to CoLive logger so user can inspect progress
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            Logger.info(`[tunnel] ${trimmed}`);
          }
        }

        if (resolved) return;
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
