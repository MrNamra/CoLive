import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import {
  BINARY_FRAME_KINDS,
  decodeBinaryFrame,
  encodeBinaryFrame,
  PROTOCOL_VERSION,
} from '@colive/protocol';
import { createServer, ServerInstance } from '../src/index.js';

describe('Relay Server Integration Test Suite', () => {
  let instance: ServerInstance;
  let wsUrl: string;

  beforeAll(async () => {
    instance = await createServer(0, { LOG_LEVEL: 'fatal' });
    wsUrl = `ws://localhost:${instance.port}/ws`;
  });

  afterAll(async () => {
    await instance.close();
  });

  // Helper to create and authenticate a WebSocket client
  async function connectClient(role: 'host' | 'guest'): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'hello',
        clientVersion: '0.1.0',
        role,
      }),
    );

    const ack = await waitForJson(ws, 'helloAck');
    expect(ack.type).toBe('helloAck');
    return ws;
  }

  function waitForJson<T = Record<string, unknown>>(ws: WebSocket, expectedType: string, timeoutMs = 4000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for JSON message type: ${expectedType}`));
      }, timeoutMs);

      function onMessage(data: unknown, isBinary: boolean) {
        if (!isBinary && data) {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === expectedType) {
              cleanup();
              resolve(parsed as T);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      function onError(err: unknown) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }

      function cleanup() {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('error', onError);
      }

      ws.on('message', onMessage);
      ws.on('error', onError);
    });
  }

  function waitForBinary(ws: WebSocket, timeoutMs = 4000): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for binary frame'));
      }, timeoutMs);

      function onMessage(data: unknown, isBinary: boolean) {
        if (isBinary && data) {
          cleanup();
          resolve(new Uint8Array(data as ArrayBuffer));
        }
      }

      function onError(err: unknown) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }

      function cleanup() {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('error', onError);
      }

      ws.on('message', onMessage);
      ws.on('error', onError);
    });
  }

  it('GET /health returns 200 with status ok', async () => {
    const res = await fetch(`http://localhost:${instance.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('GET /metrics returns Prometheus text', async () => {
    const res = await fetch(`http://localhost:${instance.port}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('colive_active_sessions');
    expect(text).toContain('colive_messages_total');
  });

  it('GET /j/:sessionId serves landing HTML page with secret in fragment', async () => {
    const res = await fetch(`http://localhost:${instance.port}/j/test_session_123`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('test_session_123');
    expect(html).toContain('Open in Your Editor');
    expect(html).toContain('window.location.hash');
  });

  it('Happy Path: host creates session, guest joins, host accepts, RPC and Yjs doc sync work', async () => {
    const hostWs = await connectClient('host');
    const guestWs = await connectClient('guest');

    // 1. Host creates session
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.createSession',
        displayName: 'Alice Host',
      }),
    );
    const createdMsg = await waitForJson(hostWs, 'server.sessionCreated');
    expect(createdMsg.sessionId).toBeDefined();
    expect(createdMsg.inviteSecret).toBeDefined();

    // 2. Guest requests join
    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId: createdMsg.sessionId,
        inviteSecret: createdMsg.inviteSecret,
        displayName: 'Bob Guest',
      }),
    );

    // 3. Host receives joinRequest
    const joinReq = await waitForJson(hostWs, 'server.joinRequest');
    expect(joinReq.displayName).toBe('Bob Guest');

    // 4. Host accepts guest as readWrite
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.joinDecision',
        requestId: joinReq.requestId,
        accept: true,
        permission: 'readWrite',
      }),
    );

    // 5. Guest receives joinAccepted
    const joinAcc = await waitForJson(guestWs, 'server.joinAccepted');
    expect(joinAcc.permission).toBe('readWrite');
    expect(joinAcc.hostInfo.displayName).toBe('Alice Host');

    // 6. Host listens for fs.read.req and replies with fs.read.res
    const rpcPromise = waitForJson(hostWs, 'fs.read.req').then((req) => {
      hostWs.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'fs.read.res',
          id: req.id,
          contentBase64: Buffer.from('hello colive').toString('base64'),
          mtime: Date.now(),
          isBinary: false,
        }),
      );
    });

    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'fs.read.req',
        id: 'req_read_1',
        path: 'src/main.ts',
      }),
    );

    await rpcPromise;
    const readRes = await waitForJson(guestWs, 'fs.read.res');
    expect(readRes.id).toBe('req_read_1');
    expect(Buffer.from(readRes.contentBase64, 'base64').toString('utf-8')).toBe('hello colive');

    // 7. Binary Yjs doc update from host to guest
    const docId = 'doc_test123';
    // Open doc on both sides so fan-out tracks subscriptions
    guestWs.send(
      encodeBinaryFrame(
        BINARY_FRAME_KINDS.DOC_UPDATE,
        docId,
        new Uint8Array([1, 2, 3]),
      ),
    );

    // Wait a tick then host sends doc update
    const updatePayload = new Uint8Array([42, 43, 44, 45]);
    hostWs.send(
      encodeBinaryFrame(
        BINARY_FRAME_KINDS.DOC_UPDATE,
        docId,
        updatePayload,
      ),
    );

    const receivedFrame = await waitForBinary(guestWs);
    const decoded = decodeBinaryFrame(receivedFrame);
    expect(decoded.kind).toBe(BINARY_FRAME_KINDS.DOC_UPDATE);
    expect(decoded.docId).toBe(docId);
    expect(Array.from(decoded.payload)).toEqual([42, 43, 44, 45]);

    hostWs.close();
    guestWs.close();
  });

  it('Rejects join with incorrect secret', async () => {
    const hostWs = await connectClient('host');
    const guestWs = await connectClient('guest');

    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.createSession',
        displayName: 'Alice Host',
      }),
    );
    const created = await waitForJson(hostWs, 'server.sessionCreated');

    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId: created.sessionId,
        inviteSecret: 'WRONG_SECRET_VALUE',
        displayName: 'Eve Intruder',
      }),
    );

    const rejected = await waitForJson(guestWs, 'server.joinRejected');
    expect(rejected.reason).toContain('Invalid invite secret');

    hostWs.close();
    guestWs.close();
  });

  it('Blocks write operations for read-only guests', async () => {
    const hostWs = await connectClient('host');
    const guestWs = await connectClient('guest');

    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.createSession',
        displayName: 'Alice Host',
      }),
    );
    const created = await waitForJson(hostWs, 'server.sessionCreated');

    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId: created.sessionId,
        inviteSecret: created.inviteSecret,
        displayName: 'ReadOnly Observer',
      }),
    );

    const joinReq = await waitForJson(hostWs, 'server.joinRequest');
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.joinDecision',
        requestId: joinReq.requestId,
        accept: true,
        permission: 'readOnly',
      }),
    );

    await waitForJson(guestWs, 'server.joinAccepted');

    // Attempt fs.write as readOnly guest
    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'fs.write.req',
        id: 'write_attempt_1',
        path: 'src/hack.ts',
        contentBase64: 'ZGF0YQ==',
      }),
    );

    const err = await waitForJson(guestWs, 'error');
    expect(err.code).toBe('READ_ONLY');

    hostWs.close();
    guestWs.close();
  });

  it('Closes connection with code 1009 when an oversized binary frame is sent', async () => {
    const ws = await connectClient('host');

    // Send a frame exceeding 8MB
    const bigPayload = Buffer.alloc(8 * 1024 * 1024 + 1024);
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    ws.send(bigPayload);
    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(1009);
  });

  it('Guest auto-reconnects with guestToken during connection fluctuation without re-approval', async () => {
    const hostWs = await connectClient('host');
    let guestWs = await connectClient('guest');

    // 1. Host creates session
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.createSession',
        displayName: 'Alice Host',
      }),
    );
    const created = await waitForJson(hostWs, 'server.sessionCreated');

    // 2. Guest joins
    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId: created.sessionId,
        inviteSecret: created.inviteSecret,
        displayName: 'Bob Guest',
      }),
    );
    const joinReq = await waitForJson(hostWs, 'server.joinRequest');

    // 3. Host accepts
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.joinDecision',
        requestId: joinReq.requestId,
        accept: true,
        permission: 'readWrite',
      }),
    );
    const joinAccepted = await waitForJson(guestWs, 'server.joinAccepted');
    expect(joinAccepted.guestToken).toBeDefined();

    // 4. Simulate connection fluctuation: guest socket closes abruptly
    const reconnectingPromise = waitForJson(hostWs, 'server.participantUpdated');
    guestWs.close();
    const reconnectingMsg = await reconnectingPromise;
    expect(reconnectingMsg.participant.status).toBe('reconnecting');

    // 5. Guest auto-reconnects with new socket using guestToken
    guestWs = await connectClient('guest');
    const hostActivePromise = waitForJson(hostWs, 'server.participantUpdated');
    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId: created.sessionId,
        guestToken: joinAccepted.guestToken,
        displayName: 'Bob Guest',
      }),
    );

    const reconnected = await waitForJson(guestWs, 'server.joinAccepted');
    expect(reconnected.guestId).toBe(joinAccepted.guestId);
    expect(reconnected.permission).toBe('readWrite');

    const activeMsg = await hostActivePromise;
    expect(activeMsg.participant.status).toBe('active');

    hostWs.close();
    guestWs.close();
  });

  it('Host auto-reconnects with hostToken after network fluctuation and reclaims session', async () => {
    let hostWs = await connectClient('host');

    // 1. Host creates session
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.createSession',
        displayName: 'Alice Host',
      }),
    );
    const created = await waitForJson(hostWs, 'server.sessionCreated');

    // 2. Simulate connection fluctuation: host socket drops
    hostWs.close();

    // 3. Host auto-reconnects with new socket and reclaims session
    hostWs = await connectClient('host');
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.reconnect',
        sessionId: created.sessionId,
        hostToken: created.hostToken,
      }),
    );

    const reconnected = await waitForJson(hostWs, 'server.hostReconnected');
    expect(reconnected.sessionId).toBe(created.sessionId);
    expect(reconnected.success).toBe(true);

    hostWs.close();
  });

  it('Relay server preserves chat messages with unique ids, answers chat.sync.req for reconnected guests, and handles chat.clear', async () => {
    const hostWs = await connectClient('host');

    // 1. Host creates session
    const createdPromise = waitForJson<any>(hostWs, 'server.sessionCreated');
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.createSession',
        displayName: 'Host Alice',
      }),
    );
    const created = await createdPromise;

    // 2. Guest joins
    let guestWs = await connectClient('guest');
    const joinReqPromise = waitForJson<any>(hostWs, 'server.joinRequest');
    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId: created.sessionId,
        inviteSecret: created.inviteSecret,
        displayName: 'Guest Bob',
      }),
    );
    const joinReq = await joinReqPromise;

    const joinAcceptedPromise = waitForJson<any>(guestWs, 'server.joinAccepted');
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'host.joinDecision',
        requestId: joinReq.requestId,
        accept: true,
        permission: 'readWrite',
      }),
    );
    const joinAccepted = await joinAcceptedPromise;

    // 3. Guest drops connection for 1 second (simulating network flap)
    guestWs.close();

    // 4. During this 1-second retry window, Host sends a chat message
    const msgTs = Date.now();
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'chat.message',
        id: 'msg_flap_test_1',
        fromId: 'host',
        fromName: 'Host Alice',
        text: 'Hello while you were disconnected!',
        ts: msgTs,
      }),
    );

    // Wait a brief moment to let server buffer message
    await new Promise((r) => setTimeout(r, 100));

    // 5. Guest reconnects with guestToken
    guestWs = await connectClient('guest');
    const guestRejoinPromise = waitForJson(guestWs, 'server.joinAccepted');
    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId: created.sessionId,
        inviteSecret: created.inviteSecret,
        guestToken: joinAccepted.guestToken,
        displayName: 'Guest Bob',
      }),
    );
    await guestRejoinPromise;

    // 6. Guest requests missed chat messages during retry period
    const syncResPromise = waitForJson<any>(guestWs, 'chat.sync.res');
    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'chat.sync.req',
        id: 'req_sync_1',
        since: msgTs - 1000,
      }),
    );

    const syncRes = await syncResPromise;
    expect(syncRes.messages).toBeDefined();
    expect(syncRes.messages.length).toBe(1);
    expect(syncRes.messages[0].id).toBe('msg_flap_test_1');
    expect(syncRes.messages[0].text).toBe('Hello while you were disconnected!');

    // 7. Clear chat: wipes server chat history so old messages are not recovered
    const clearPromise = waitForJson<any>(guestWs, 'chat.clear');
    hostWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'chat.clear',
      }),
    );
    await clearPromise;

    // Sync again: should return empty
    const syncResAfterClearPromise = waitForJson<any>(guestWs, 'chat.sync.res');
    guestWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'chat.sync.req',
        id: 'req_sync_2',
        since: 0,
      }),
    );
    const syncResAfterClear = await syncResAfterClearPromise;
    expect(syncResAfterClear.messages.length).toBe(0);

    hostWs.close();
    guestWs.close();
  });
});
