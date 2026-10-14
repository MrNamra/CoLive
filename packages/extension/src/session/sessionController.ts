import * as vscode from 'vscode';
import { ParticipantInfo, Permission } from '@colive/protocol';
import { ConnectionManager } from '../connection.js';
import { SessionLifecycleState, SessionStateChangeEvent } from './sessionState.js';

export abstract class SessionController implements vscode.Disposable {
  protected state: SessionLifecycleState = 'idle';
  protected connection: ConnectionManager | null = null;
  protected participantsMap: Map<string, ParticipantInfo> = new Map();

  protected readonly _onDidChangeState = new vscode.EventEmitter<SessionStateChangeEvent>();
  public readonly onDidChangeState = this._onDidChangeState.event;

  protected readonly _onDidChangeParticipants = new vscode.EventEmitter<ParticipantInfo[]>();
  public readonly onDidChangeParticipants = this._onDidChangeParticipants.event;

  public getState(): SessionLifecycleState {
    return this.state;
  }

  public getParticipants(): ParticipantInfo[] {
    return Array.from(this.participantsMap.values());
  }

  public getConnection(): ConnectionManager | null {
    return this.connection;
  }

  protected setState(nextState: SessionLifecycleState, reason?: string): void {
    if (this.state !== nextState) {
      const prev = this.state;
      this.state = nextState;
      this._onDidChangeState.fire({ previous: prev, current: nextState, reason });
    }
  }

  public abstract endSession(): Promise<void>;
  public abstract copyInvite(): Promise<void>;

  public dispose(): void {
    this._onDidChangeState.dispose();
    this._onDidChangeParticipants.dispose();
    if (this.connection) {
      this.connection.disconnect();
      this.connection = null;
    }
  }
}
