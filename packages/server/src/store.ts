import { ParticipantInfo, ChatMessage } from '@colive/protocol';

export interface PendingJoin {
  requestId: string;
  guestTempId: string;
  displayName: string;
  expiresAt: number;
  reqId?: string;
  timeoutId?: NodeJS.Timeout;
}

export interface SessionData {
  sessionId: string;
  hostToken: string;
  inviteSecretHash: string; // SHA-256 hex
  expiresAt: number;
  createdAt: number;
  hostParticipantId: string;
  hostClientId: string | null;
  hostGraceTimer?: NodeJS.Timeout;
  guestGraceTimers?: Map<string, NodeJS.Timeout>;
  participants: Map<string, ParticipantInfo>; // participantId -> ParticipantInfo
  clientToParticipant: Map<string, string>; // clientId -> participantId
  participantToClient: Map<string, string>; // participantId -> clientId
  pendingJoins: Map<string, PendingJoin>; // requestId -> PendingJoin
  docSubscriptions: Map<string, Set<string>>; // docId -> Set<participantId>
  assignedColors: Set<string>;
  chatHistory?: ChatMessage[];
}

export interface SessionStore {
  createSession(data: Omit<SessionData, 'participants' | 'clientToParticipant' | 'participantToClient' | 'pendingJoins' | 'docSubscriptions' | 'assignedColors'>): Promise<SessionData>;
  getSession(sessionId: string): Promise<SessionData | undefined>;
  deleteSession(sessionId: string): Promise<boolean>;
  getAllSessions(): Promise<SessionData[]>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions: Map<string, SessionData> = new Map();

  public async createSession(
    data: Omit<SessionData, 'participants' | 'clientToParticipant' | 'participantToClient' | 'pendingJoins' | 'docSubscriptions' | 'assignedColors'>,
  ): Promise<SessionData> {
    const session: SessionData = {
      ...data,
      guestGraceTimers: new Map(),
      participants: new Map(),
      clientToParticipant: new Map(),
      participantToClient: new Map(),
      pendingJoins: new Map(),
      docSubscriptions: new Map(),
      assignedColors: new Set(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  public async getSession(sessionId: string): Promise<SessionData | undefined> {
    return this.sessions.get(sessionId);
  }

  public async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.hostGraceTimer) {
        clearTimeout(session.hostGraceTimer);
      }
      if (session.guestGraceTimers) {
        for (const timer of session.guestGraceTimers.values()) {
          clearTimeout(timer);
        }
        session.guestGraceTimers.clear();
      }
      for (const pj of session.pendingJoins.values()) {
        if (pj.timeoutId) clearTimeout(pj.timeoutId);
      }
    }
    return this.sessions.delete(sessionId);
  }

  public async getAllSessions(): Promise<SessionData[]> {
    return Array.from(this.sessions.values());
  }
}
