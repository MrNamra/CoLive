import { WebSocket, RawData } from 'ws';
import * as vscode from 'vscode';
import {
  ColiveMessage,
  parseColiveMessage,
  PROTOCOL_VERSION,
  Role,
} from '@colive/protocol';
import { Logger } from './logger.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionEvents {
  message: (msg: ColiveMessage) => void;
  binary: (data: Uint8Array) => void;
  stateChange: (state: ConnectionState) => void;
  reconnecting: (attempt: number) => void;
  reconnected: () => void;
  close: (code: number, reason: string) => void;
}

export class ConnectionManager {
  private url: string;
  private role: Role;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private outgoingQueue: Array<string | Uint8Array> = [];
  private pendingRpcs: Map<string, { resolve: (val: ColiveMessage) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = new Map();
  private listeners: { [K in keyof ConnectionEvents]?: Set<ConnectionEvents[K]> } = {};
  private intentionallyClosed = false;

  constructor(url: string, role: Role) {
    this.url = url;
    this.role = role;
    this.checkInsecureUrl(url);
  }

  private checkInsecureUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'ws:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        vscode.window.showWarningMessage(
          `CoLive: The configured server URL (${url}) uses an unencrypted WebSocket connection. In production, wss:// is strongly recommended.`,
        );
      }
    } catch {
      // Ignore URL parse error
    }
  }

  public on<K extends keyof ConnectionEvents>(event: K, listener: ConnectionEvents[K]): void {
    const set = (this.listeners[event] ??= new Set() as unknown as Set<ConnectionEvents[K]>);
    set.add(listener);
  }

  public off<K extends keyof ConnectionEvents>(event: K, listener: ConnectionEvents[K]): void {
    this.listeners[event]?.delete(listener);
  }

  public onMessage(listener: (msg: ColiveMessage) => void): vscode.Disposable {
    this.on('message', listener);
    return {
      dispose: () => {
        this.off('message', listener);
      },
    };
  }

  private emit<K extends keyof ConnectionEvents>(event: K, ...args: Parameters<ConnectionEvents[K]>): void {
    const set = this.listeners[event];
    if (set) {
      for (const fn of set) {
        // @ts-expect-error TypeScript spread arguments
        fn(...args);
      }
    }
  }

  public getState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      Logger.info(`Connection state changed to: ${state}`);
      this.emit('stateChange', state);
    }
  }

  public async connect(maxRetries = 6, retryDelayMs = 2000): Promise<void> {
    this.intentionallyClosed = false;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (this.intentionallyClosed) return;
      try {
        await this.attemptConnect();
        return;
      } catch (err) {
        lastErr = err;
        if (this.intentionallyClosed) return;
        const msg = err instanceof Error ? err.message : String(err);
        const isCloudflareEdgePropagating =
          msg.includes('530') ||
          msg.includes('502') ||
          msg.includes('503') ||
          msg.includes('ENOTFOUND') ||
          msg.includes('closed before opening');

        if (isCloudflareEdgePropagating && attempt < maxRetries) {
          Logger.info(
            `Relay server edge warming up (${msg}). Retrying connection (${attempt}/${maxRetries}) in ${retryDelayMs}ms...`,
          );
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }

        if (msg.includes('530')) {
          throw new Error(
            `Cloudflare Tunnel is not yet ready or the session has ended (HTTP 530). If the host just started the session, please try again in a few moments.`,
          );
        }

        throw err;
      }
    }

    if (lastErr) throw lastErr;
  }

  private attemptConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
      Logger.info(`Connecting to relay server at: ${this.url}`);

      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        this.setState('disconnected');
        reject(err);
        return;
      }

      let opened = false;

      this.ws.on('open', () => {
        opened = true;
        Logger.info('WebSocket connection opened, sending hello handshake');
        // Send hello handshake
        const helloMsg: ColiveMessage = {
          v: PROTOCOL_VERSION,
          type: 'hello',
          clientVersion: '0.1.0',
          role: this.role,
        };
        this.ws!.send(JSON.stringify(helloMsg));
      });

      this.ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          const buffer = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
          this.emit('binary', new Uint8Array(buffer));
          return;
        }

        try {
          const text = data.toString('utf-8');
          const msg = parseColiveMessage(text);

          if (msg.type === 'helloAck') {
            Logger.info('Handshake acknowledged by server');
            const wasReconnecting = this.state === 'reconnecting';
            this.setState('connected');
            this.reconnectAttempt = 0;
            this.flushQueue();

            if (wasReconnecting) {
              this.emit('reconnected');
            }
            resolve();
            return;
          }

          if (msg.type === 'error' && msg.code === 'VERSION_MISMATCH') {
            Logger.error('Version mismatch error received from server', msg.message);
            vscode.window.showErrorMessage(`CoLive connection failed: ${msg.message}`);
            this.disconnect();
            reject(new Error(msg.message));
            return;
          }

          // Check for pending RPC response
          if (msg.id && this.pendingRpcs.has(msg.id)) {
            const rpc = this.pendingRpcs.get(msg.id)!;
            clearTimeout(rpc.timer);
            this.pendingRpcs.delete(msg.id);

            if (msg.type === 'error') {
              rpc.reject(new Error(msg.message));
            } else {
              rpc.resolve(msg);
            }
          }

          this.emit('message', msg);
        } catch (err) {
          Logger.warn('Failed to parse incoming message', { err });
        }
      });

      this.ws.on('close', (code, reason) => {
        Logger.info(`WebSocket closed with code ${code}: ${reason.toString()}`);
        this.emit('close', code, reason.toString());

        if (!opened && !this.intentionallyClosed) {
          reject(new Error(`WebSocket connection closed before opening (code: ${code})`));
        }

        if (!this.intentionallyClosed) {
          this.scheduleReconnect();
        } else {
          this.setState('disconnected');
        }
      });

      this.ws.on('error', (err) => {
        Logger.error('WebSocket error occurred', err);
        if (!opened && !this.intentionallyClosed) {
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    this.reconnectAttempt++;
    this.emit('reconnecting', this.reconnectAttempt);

    // Exponential backoff: min 1s, max 30s + jitter
    const baseDelay = Math.min(30000, 1000 * Math.pow(1.5, this.reconnectAttempt));
    const jitter = Math.random() * 1000;
    const delay = Math.round(baseDelay + jitter);

    Logger.info(`Scheduling reconnect attempt #${this.reconnectAttempt} in ${delay}ms`);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionallyClosed) {
        this.connect().catch((err) => {
          Logger.warn('Reconnect attempt failed', { err: err.message });
        });
      }
    }, delay);
  }

  public send(msg: ColiveMessage | Uint8Array): void {
    if (this.state === 'connected' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (msg instanceof Uint8Array) {
        this.ws.send(msg);
      } else {
        this.ws.send(JSON.stringify(msg));
      }
    } else {
      // Queue outgoing message while reconnecting
      this.outgoingQueue.push(msg instanceof Uint8Array ? msg : JSON.stringify(msg));
      if (this.outgoingQueue.length > 500) {
        this.outgoingQueue.shift(); // Drop oldest to avoid memory leak
      }
    }
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.outgoingQueue.length > 0) {
      const item = this.outgoingQueue.shift()!;
      this.ws.send(item);
    }
  }

  public sendJson(msg: ColiveMessage): void {
    this.send(msg);
  }

  public sendBinary(data: Uint8Array): void {
    this.send(data);
  }

  public request<T = ColiveMessage>(msg: ColiveMessage, timeoutMs = 15000): Promise<T> {
    if (!msg.id) {
      msg.id = `req_${Math.random().toString(36).slice(2, 10)}`;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(msg.id!);
        reject(new Error(`RPC request '${msg.type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRpcs.set(msg.id!, { resolve: resolve as (val: ColiveMessage) => void, reject, timer });
      this.send(msg);
    });
  }

  public disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const rpc of this.pendingRpcs.values()) {
      clearTimeout(rpc.timer);
      rpc.reject(new Error('Connection closed'));
    }
    this.pendingRpcs.clear();
    this.outgoingQueue = [];

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.setState('disconnected');
  }
}
