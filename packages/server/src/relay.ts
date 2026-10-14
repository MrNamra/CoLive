import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket, RawData } from 'ws';
import pino from 'pino';
import {
  BINARY_FRAME_KINDS,
  ColiveMessage,
  decodeBinaryFrame,
  MAX_BINARY_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  PARTICIPANT_PALETTE,
  ParticipantInfo,
  PROTOCOL_VERSION,
  Role,
  safeParseColiveMessage,
  sanitizeDisplayName,
} from '@colive/protocol';
import { ServerConfig } from './config.js';
import { ServerMetrics } from './metrics.js';
import { IpRateLimiter, TokenBucket } from './rateLimiter.js';
import { InMemorySessionStore, PendingJoin, SessionData, SessionStore } from './store.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

interface ClientConnection {
  id: string;
  ws: WebSocket;
  ip: string;
  authenticated: boolean;
  role?: Role;
  sessionId?: string;
  participantId?: string;
  isAlive: boolean;
  missedPongs: number;
  jsonBucket: TokenBucket;
  binaryBucket: TokenBucket;
  helloTimer: NodeJS.Timeout;
}

export class RelayServer {
  private config: ServerConfig;
  private store: SessionStore;
  private metrics: ServerMetrics;
  private clients: Map<string, ClientConnection> = new Map();
  private sessionCreationLimiter: IpRateLimiter;
  private failedJoinLimiter: IpRateLimiter;
  private pingInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private rpcPendingTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private rpcPendingParticipants: Map<string, string | undefined> = new Map();

  constructor(config: ServerConfig, store?: SessionStore) {
    this.config = config;
    this.store = store || new InMemorySessionStore();
    this.metrics = new ServerMetrics();
    this.sessionCreationLimiter = new IpRateLimiter(5, 60_000); // 5 per min
    this.failedJoinLimiter = new IpRateLimiter(10, 60_000); // 10 per min
  }

  public getMetrics(): ServerMetrics {
    return this.metrics;
  }

  public getStore(): SessionStore {
    return this.store;
  }

  public startHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.isAlive) {
          client.missedPongs++;
          if (client.missedPongs >= 2) {
            logger.warn({ clientId: client.id }, 'Terminating unresponsive WebSocket connection');
            client.ws.terminate();
            continue;
          }
        }
        client.isAlive = false;
        try {
          client.ws.ping();
        } catch {
          client.ws.terminate();
        }
      }
    }, 20_000);

    this.cleanupInterval = setInterval(() => {
      this.sessionCreationLimiter.cleanup();
      this.failedJoinLimiter.cleanup();
    }, 60_000);
  }

  public stopHeartbeat(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    for (const timeout of this.rpcPendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.rpcPendingTimeouts.clear();
  }

  public handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const clientId = `client_${crypto.randomBytes(6).toString('hex')}`;
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';

    const client: ClientConnection = {
      id: clientId,
      ws,
      ip,
      authenticated: false,
      isAlive: true,
      missedPongs: 0,
      jsonBucket: new TokenBucket(100, 50), // 50 msg/s, burst 100
      binaryBucket: new TokenBucket(2 * 1024 * 1024, 2 * 1024 * 1024), // 2 MB/s
      helloTimer: setTimeout(() => {
        if (!client.authenticated) {
          logger.warn({ clientId }, 'Closing connection: hello timeout exceeded');
          client.ws.close(4000, 'Hello timeout');
        }
      }, 5000),
    };

    this.clients.set(clientId, client);
    this.metrics.activeParticipants = this.clients.size;

    ws.on('pong', () => {
      client.isAlive = true;
      client.missedPongs = 0;
    });

    ws.on('message', async (data: RawData, isBinary: boolean) => {
      const byteSize = Array.isArray(data)
        ? data.reduce((acc, b) => acc + b.length, 0)
        : data instanceof ArrayBuffer
          ? data.byteLength
          : (data as Buffer).length;

      this.metrics.recordMessage(byteSize);

      if (isBinary) {
        if (byteSize > MAX_BINARY_FRAME_BYTES) {
          logger.warn({ clientId, byteSize }, 'Oversized binary frame rejected');
          ws.close(1009, 'Binary frame too large');
          return;
        }
        if (!client.binaryBucket.tryConsume(byteSize)) {
          logger.warn({ clientId }, 'Binary rate limit exceeded');
          return;
        }
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        await this.handleBinaryFrame(client, buffer);
      } else {
        if (byteSize > MAX_MESSAGE_BYTES) {
          logger.warn({ clientId, byteSize }, 'Oversized JSON message rejected');
          ws.close(1009, 'Message too large');
          return;
        }
        if (!client.jsonBucket.tryConsume(1)) {
          logger.warn({ clientId }, 'JSON message rate limit exceeded');
          this.sendJson(client, {
            v: PROTOCOL_VERSION,
            type: 'error',
            code: 'INTERNAL',
            message: 'Rate limit exceeded. Please slow down.',
          });
          return;
        }
        const text = data.toString('utf-8');
        await this.handleJsonMessage(client, text);
      }
    });

    ws.on('close', async (code, reason) => {
      clearTimeout(client.helloTimer);
      this.clients.delete(clientId);
      this.metrics.activeParticipants = this.clients.size;
      logger.info({ clientId, code, reason: reason.toString() }, 'Client disconnected');
      await this.handleClientDisconnect(client);
    });

    ws.on('error', (err) => {
      logger.error({ clientId, err: err.message }, 'Client WebSocket error');
    });
  }

  private async handleJsonMessage(client: ClientConnection, rawText: string): Promise<void> {
    const parseResult = safeParseColiveMessage(rawText);
    if (!parseResult.success) {
      logger.warn({ clientId: client.id, errors: parseResult.error.format() }, 'Invalid protocol message rejected');
      this.sendJson(client, {
        v: PROTOCOL_VERSION,
        type: 'error',
        code: 'INTERNAL',
        message: 'Malformed message rejected',
      });
      return;
    }

    const msg = parseResult.data;
    logger.debug({ clientId: client.id, type: msg.type }, 'Received message');

    // 1. Handshake handling
    if (msg.type === 'hello') {
      clearTimeout(client.helloTimer);
      if (msg.v !== PROTOCOL_VERSION) {
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'error',
          code: 'VERSION_MISMATCH',
          message: `Protocol version mismatch. Server supports v${PROTOCOL_VERSION}`,
        });
        client.ws.close(4001, 'Version mismatch');
        return;
      }
      client.authenticated = true;
      client.role = msg.role;
      this.sendJson(client, {
        v: PROTOCOL_VERSION,
        type: 'helloAck',
        clientId: client.id,
        serverVersion: '0.1.0',
      });
      return;
    }

    if (!client.authenticated) {
      this.sendJson(client, {
        v: PROTOCOL_VERSION,
        type: 'error',
        code: 'FORBIDDEN',
        message: 'Must send hello handshake first',
      });
      client.ws.close(4000, 'Unauthenticated');
      return;
    }

    // 2. Ping / Pong
    if (msg.type === 'ping') {
      this.sendJson(client, {
        v: PROTOCOL_VERSION,
        type: 'pong',
        timestamp: msg.timestamp,
        serverTimestamp: Date.now(),
      });
      return;
    }

    // 3. Session Creation
    if (msg.type === 'host.createSession') {
      if (!this.sessionCreationLimiter.isAllowed(client.ip)) {
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'error',
          code: 'FORBIDDEN',
          message: 'Session creation rate limit exceeded. Try again in a minute.',
        });
        return;
      }

      const sessionId = crypto.randomBytes(6).toString('base64url').slice(0, 10);
      const hostToken = crypto.randomBytes(32).toString('base64url');
      const inviteSecret = msg.inviteSecret || crypto.randomBytes(32).toString('base64url');
      const secretHash = crypto.createHash('sha256').update(inviteSecret).digest('hex');
      const expiresAt = Date.now() + this.config.SESSION_TTL_HOURS * 3600 * 1000;
      const hostParticipantId = `p_host_${crypto.randomBytes(4).toString('hex')}`;

      const session = await this.store.createSession({
        sessionId,
        hostToken,
        inviteSecretHash: secretHash,
        expiresAt,
        createdAt: Date.now(),
        hostParticipantId,
        hostClientId: client.id,
      });

      const sanitizedName = sanitizeDisplayName(msg.displayName);
      const hostParticipant: ParticipantInfo = {
        id: hostParticipantId,
        role: 'host',
        displayName: sanitizedName,
        color: PARTICIPANT_PALETTE[0]!,
        permission: 'readWrite',
        status: 'active',
      };

      session.participants.set(hostParticipantId, hostParticipant);
      session.clientToParticipant.set(client.id, hostParticipantId);
      session.participantToClient.set(hostParticipantId, client.id);
      session.assignedColors.add(PARTICIPANT_PALETTE[0]!);

      client.sessionId = sessionId;
      client.participantId = hostParticipantId;
      client.role = 'host';

      this.metrics.activeSessions++;

      this.sendJson(client, {
        v: PROTOCOL_VERSION,
        type: 'server.sessionCreated',
        id: msg.id,
        sessionId,
        hostToken,
        inviteSecret,
        expiresAt,
      });
      return;
    }

    // 4. Guest Join Request
    if (msg.type === 'guest.join') {
      const session = await this.store.getSession(msg.sessionId);
      if (!session || Date.now() > session.expiresAt) {
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'server.joinRejected',
          reason: 'Session not found or expired',
        });
        return;
      }

      // Guest Token Reconnect (no host re-approval required)
      if (msg.guestToken && session.participants.has(msg.guestToken)) {
        const participant = session.participants.get(msg.guestToken)!;
        participant.status = 'active';

        // Reassign client mapping
        session.clientToParticipant.set(client.id, participant.id);
        session.participantToClient.set(participant.id, client.id);
        client.sessionId = session.sessionId;
        client.participantId = participant.id;
        client.role = 'guest';

        const hostInfo = session.participants.get(session.hostParticipantId)!;
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'server.joinAccepted',
          id: msg.id,
          guestId: participant.id,
          guestToken: participant.id,
          permission: participant.permission,
          hostInfo,
          participants: Array.from(session.participants.values()).filter((p) => p.id !== participant.id),
        });

        this.broadcastToSession(session, {
          v: PROTOCOL_VERSION,
          type: 'server.participantUpdated',
          participant,
        });
        return;
      }

      // Secret verification
      if (!msg.inviteSecret) {
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'server.joinRejected',
          reason: 'Invite secret required',
        });
        return;
      }

      const inputHash = crypto.createHash('sha256').update(msg.inviteSecret).digest('hex');
      const hashBufferA = Buffer.from(inputHash, 'hex');
      const hashBufferB = Buffer.from(session.inviteSecretHash, 'hex');

      if (hashBufferA.length !== hashBufferB.length || !crypto.timingSafeEqual(hashBufferA, hashBufferB)) {
        this.failedJoinLimiter.isAllowed(client.ip);
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'server.joinRejected',
          reason: 'Invalid invite secret',
        });
        return;
      }

      // Check max participants
      if (session.participants.size >= this.config.MAX_PARTICIPANTS) {
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'server.joinRejected',
          reason: 'Session is full',
        });
        return;
      }

      // Check pending joins cap
      if (session.pendingJoins.size >= 5) {
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'server.joinRejected',
          reason: 'Too many pending join requests. Try again shortly.',
        });
        return;
      }

      // Check if host is connected
      if (!session.hostClientId) {
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'server.joinRejected',
          reason: 'Host is currently disconnected',
        });
        return;
      }

      const hostClient = this.clients.get(session.hostClientId);
      if (!hostClient) {
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'server.joinRejected',
          reason: 'Host is offline',
        });
        return;
      }

      const requestId = `req_${crypto.randomBytes(6).toString('hex')}`;
      const sanitizedName = sanitizeDisplayName(msg.displayName);

      const pendingJoin: PendingJoin = {
        requestId,
        guestTempId: client.id,
        displayName: sanitizedName,
        expiresAt: Date.now() + 60_000,
        reqId: msg.id,
        timeoutId: setTimeout(() => {
          session.pendingJoins.delete(requestId);
          this.sendJson(client, {
            v: PROTOCOL_VERSION,
            type: 'server.joinRejected',
            id: msg.id,
            reason: 'Join request timed out waiting for host approval',
          });
        }, 60_000),
      };

      session.pendingJoins.set(requestId, pendingJoin);
      client.sessionId = session.sessionId;

      this.sendJson(hostClient, {
        v: PROTOCOL_VERSION,
        type: 'server.joinRequest',
        requestId,
        guestTempId: client.id,
        displayName: sanitizedName,
      });
      return;
    }

    // 5. Host Join Decision
    if (msg.type === 'host.joinDecision') {
      const session = await this.getSessionForClient(client);
      if (!session || session.hostClientId !== client.id) {
        return;
      }

      const pending = session.pendingJoins.get(msg.requestId);
      if (!pending) {
        return;
      }

      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      session.pendingJoins.delete(msg.requestId);

      const guestClient = this.clients.get(pending.guestTempId);
      if (!guestClient) {
        return;
      }

      if (!msg.accept) {
        this.sendJson(guestClient, {
          v: PROTOCOL_VERSION,
          type: 'server.joinRejected',
          id: pending.reqId,
          reason: msg.reason || 'Host declined join request',
        });
        return;
      }

      // Assign unique display name if needed
      let chosenName = pending.displayName;
      const existingNames = new Set(Array.from(session.participants.values()).map((p) => p.displayName));
      let counter = 2;
      while (existingNames.has(chosenName)) {
        chosenName = `${pending.displayName} (${counter++})`;
      }

      // Assign color from palette
      let chosenColor: string = PARTICIPANT_PALETTE[1]!;
      for (const color of PARTICIPANT_PALETTE) {
        if (!session.assignedColors.has(color)) {
          chosenColor = color;
          break;
        }
      }
      session.assignedColors.add(chosenColor);

      const guestId = `p_${crypto.randomBytes(6).toString('hex')}`;
      const guestToken = guestId; // Stable guest token

      const guestParticipant: ParticipantInfo = {
        id: guestId,
        role: 'guest',
        displayName: chosenName,
        color: chosenColor,
        permission: msg.permission,
        status: 'active',
      };

      session.participants.set(guestId, guestParticipant);
      session.clientToParticipant.set(guestClient.id, guestId);
      session.participantToClient.set(guestId, guestClient.id);

      guestClient.sessionId = session.sessionId;
      guestClient.participantId = guestId;
      guestClient.role = 'guest';

      const hostInfo = session.participants.get(session.hostParticipantId)!;

      this.sendJson(guestClient, {
        v: PROTOCOL_VERSION,
        type: 'server.joinAccepted',
        id: pending.reqId,
        guestId,
        guestToken,
        permission: msg.permission,
        hostInfo,
        participants: Array.from(session.participants.values()).filter((p) => p.id !== guestId),
      });

      this.broadcastToSession(session, {
        v: PROTOCOL_VERSION,
        type: 'server.participantJoined',
        participant: guestParticipant,
      }, guestId);

      return;
    }

    // 6. Host Session Administration
    if (msg.type === 'host.setPermission') {
      const session = await this.getSessionForClient(client);
      if (!session || session.hostClientId !== client.id) return;

      const target = session.participants.get(msg.guestId);
      if (target) {
        target.permission = msg.permission;
        this.broadcastToSession(session, {
          v: PROTOCOL_VERSION,
          type: 'server.participantUpdated',
          participant: target,
        });
      }
      return;
    }

    if (msg.type === 'host.kick') {
      const session = await this.getSessionForClient(client);
      if (!session || session.hostClientId !== client.id) return;

      const targetClientId = session.participantToClient.get(msg.guestId);
      if (targetClientId) {
        const targetClient = this.clients.get(targetClientId);
        if (targetClient) {
          this.sendJson(targetClient, {
            v: PROTOCOL_VERSION,
            type: 'server.sessionEnded',
            reason: msg.reason || 'Kicked by host',
          });
          targetClient.ws.close();
        }
      }
      return;
    }

    if (msg.type === 'host.endSession') {
      const session = await this.getSessionForClient(client);
      if (!session || session.hostClientId !== client.id) return;

      this.broadcastToSession(session, {
        v: PROTOCOL_VERSION,
        type: 'server.sessionEnded',
        reason: 'Host ended session',
      });
      await this.store.deleteSession(session.sessionId);
      this.metrics.activeSessions = Math.max(0, this.metrics.activeSessions - 1);
      return;
    }

    // 7. Permission-Gated RPC Routing
    const session = await this.getSessionForClient(client);
    if (!session) {
      return;
    }

    const participant = client.participantId ? session.participants.get(client.participantId) : undefined;
    const isReadOnly = participant?.permission === 'readOnly';

    // Gate writes from readOnly guests
    if (
      isReadOnly &&
      (msg.type === 'fs.write.req' ||
        msg.type === 'fs.create.req' ||
        msg.type === 'fs.delete.req' ||
        msg.type === 'fs.rename.req')
    ) {
      logger.warn({ clientId: client.id, type: msg.type }, 'Write operation dropped from read-only participant');
      this.sendJson(client, {
        v: PROTOCOL_VERSION,
        type: 'error',
        id: msg.id,
        code: 'READ_ONLY',
        message: 'Permission denied: Session is in read-only mode',
      });
      return;
    }

    // Workspace & Doc RPC routing: Guest -> Host, Host -> Guest
    if (
      msg.type.startsWith('fs.') ||
      msg.type.endsWith('.req') ||
      msg.type.endsWith('.res') ||
      (msg.type === 'error' && msg.id)
    ) {
      if (client.role === 'host') {
        // Response from Host -> Route to specific guest by request id
        this.routeRpcResponseToGuest(session, msg);
      } else {
        // Request from Guest -> Forward to Host
        this.forwardRpcToHost(session, client, msg);
      }
      return;
    }

    // Doc Close / Subscription management
    if (msg.type === 'doc.close') {
      if (client.participantId) {
        const subs = session.docSubscriptions.get(msg.docId);
        if (subs) {
          subs.delete(client.participantId);
          if (subs.size === 0) session.docSubscriptions.delete(msg.docId);
        }
      }
      return;
    }

    // Broadcast messages to entire session
    if (
      msg.type === 'chat.message' ||
      msg.type === 'fs.watchEvent' ||
      msg.type === 'doc.saved' ||
      msg.type === 'diagnostics.update' ||
      msg.type === 'comment.op'
    ) {
      this.broadcastToSession(session, msg);
      return;
    }
  }

  private async handleBinaryFrame(client: ClientConnection, frame: Uint8Array): Promise<void> {
    const session = await this.getSessionForClient(client);
    if (!session) return;

    let decoded;
    try {
      decoded = decodeBinaryFrame(frame);
    } catch (err) {
      logger.warn({ clientId: client.id, err }, 'Invalid binary frame dropped');
      return;
    }

    const participant = client.participantId ? session.participants.get(client.participantId) : undefined;
    const isReadOnly = participant?.permission === 'readOnly';

    // 0x01: Document update (CRDT)
    if (decoded.kind === BINARY_FRAME_KINDS.DOC_UPDATE) {
      if (isReadOnly) {
        logger.warn({ clientId: client.id }, 'CRDT update dropped from read-only participant');
        this.sendJson(client, {
          v: PROTOCOL_VERSION,
          type: 'error',
          code: 'READ_ONLY',
          message: 'Cannot send document updates in read-only mode',
        });
        return;
      }

      // Track doc subscription
      if (client.participantId) {
        let subs = session.docSubscriptions.get(decoded.docId);
        if (!subs) {
          subs = new Set();
          session.docSubscriptions.set(decoded.docId, subs);
        }
        subs.add(client.participantId);
      }

      // Fan out update to other participants with this doc open
      const subscribers = session.docSubscriptions.get(decoded.docId);
      if (subscribers) {
        for (const subId of subscribers) {
          if (subId === client.participantId) continue;
          const targetClientId = session.participantToClient.get(subId);
          if (targetClientId) {
            const targetClient = this.clients.get(targetClientId);
            if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
              targetClient.ws.send(frame);
            }
          }
        }
      }
      // Also always send to host if sender is guest
      if (client.role === 'guest' && session.hostClientId) {
        const hostClient = this.clients.get(session.hostClientId);
        if (hostClient && hostClient.id !== client.id && hostClient.ws.readyState === WebSocket.OPEN) {
          hostClient.ws.send(frame);
        }
      }
      return;
    }

    // 0x02: Awareness update (Presence) -> broadcast to everyone except sender
    if (decoded.kind === BINARY_FRAME_KINDS.AWARENESS) {
      for (const targetId of session.participantToClient.values()) {
        if (targetId === client.id) continue;
        const targetClient = this.clients.get(targetId);
        if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
          targetClient.ws.send(frame);
        }
      }
    }
  }

  private forwardRpcToHost(session: SessionData, guestClient: ClientConnection, msg: ColiveMessage): void {
    if (!session.hostClientId) {
      this.sendJson(guestClient, {
        v: PROTOCOL_VERSION,
        type: 'error',
        id: msg.id,
        code: 'INTERNAL',
        message: 'Host is currently disconnected',
      });
      return;
    }

    const hostClient = this.clients.get(session.hostClientId);
    if (!hostClient || hostClient.ws.readyState !== WebSocket.OPEN) {
      this.sendJson(guestClient, {
        v: PROTOCOL_VERSION,
        type: 'error',
        id: msg.id,
        code: 'INTERNAL',
        message: 'Host is offline',
      });
      return;
    }

    if (msg.id) {
      this.rpcPendingParticipants.set(msg.id, guestClient.participantId);
      const timeoutId = setTimeout(() => {
        this.rpcPendingTimeouts.delete(msg.id!);
        this.rpcPendingParticipants.delete(msg.id!);
        this.sendJson(guestClient, {
          v: PROTOCOL_VERSION,
          type: 'error',
          id: msg.id,
          code: 'INTERNAL',
          message: 'RPC request timed out after 15s',
        });
      }, 15_000);

      this.rpcPendingTimeouts.set(msg.id, timeoutId);
    }

    this.sendJson(hostClient, msg);
  }

  private routeRpcResponseToGuest(session: SessionData, msg: ColiveMessage): void {
    if (msg.id) {
      const timeout = this.rpcPendingTimeouts.get(msg.id);
      if (timeout) {
        clearTimeout(timeout);
        this.rpcPendingTimeouts.delete(msg.id);
      }
      const participantId = this.rpcPendingParticipants.get(msg.id);
      if (participantId) {
        this.rpcPendingParticipants.delete(msg.id);
        if (msg.type === 'doc.open.res' && 'docId' in msg && typeof msg.docId === 'string') {
          let subs = session.docSubscriptions.get(msg.docId);
          if (!subs) {
            subs = new Set();
            session.docSubscriptions.set(msg.docId, subs);
          }
          subs.add(participantId);
        }
      }
    }

    // Fan-out response or route back to session participants
    this.broadcastToSession(session, msg);
  }

  private broadcastToSession(session: SessionData, msg: ColiveMessage, excludeParticipantId?: string): void {
    for (const [pId, clientId] of session.participantToClient.entries()) {
      if (excludeParticipantId && pId === excludeParticipantId) continue;
      const targetClient = this.clients.get(clientId);
      if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
        this.sendJson(targetClient, msg);
      }
    }
  }

  private async handleClientDisconnect(client: ClientConnection): Promise<void> {
    const session = await this.getSessionForClient(client);
    if (!session) return;

    if (client.role === 'host' && session.hostClientId === client.id) {
      session.hostClientId = null;
      logger.info({ sessionId: session.sessionId }, 'Host disconnected. Starting 60s grace period.');

      this.broadcastToSession(session, {
        v: PROTOCOL_VERSION,
        type: 'server.participantUpdated',
        participant: {
          ...session.participants.get(session.hostParticipantId)!,
          status: 'reconnecting',
        },
      });

      session.hostGraceTimer = setTimeout(async () => {
        const currentSession = await this.store.getSession(session.sessionId);
        if (currentSession && !currentSession.hostClientId) {
          logger.info({ sessionId: session.sessionId }, 'Host grace period expired. Ending session.');
          this.broadcastToSession(session, {
            v: PROTOCOL_VERSION,
            type: 'server.sessionEnded',
            reason: 'Host disconnected and did not return',
          });
          await this.store.deleteSession(session.sessionId);
          this.metrics.activeSessions = Math.max(0, this.metrics.activeSessions - 1);
        }
      }, 60_000);
      return;
    }

    // Guest disconnected
    if (client.participantId) {
      const p = session.participants.get(client.participantId);
      if (p) {
        p.status = 'idle';
        this.broadcastToSession(session, {
          v: PROTOCOL_VERSION,
          type: 'server.participantLeft',
          participantId: p.id,
          reason: 'Disconnected',
        });
      }
    }
  }

  private async getSessionForClient(client: ClientConnection): Promise<SessionData | undefined> {
    if (!client.sessionId) return undefined;
    return this.store.getSession(client.sessionId);
  }

  public sendJson(client: ClientConnection, msg: ColiveMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  public async shutdown(): Promise<void> {
    this.stopHeartbeat();
    const sessions = await this.store.getAllSessions();
    for (const session of sessions) {
      this.broadcastToSession(session, {
        v: PROTOCOL_VERSION,
        type: 'server.sessionEnded',
        reason: 'SERVER_RESTART',
      });
      await this.store.deleteSession(session.sessionId);
    }
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutdown');
    }
    this.clients.clear();
  }
}
