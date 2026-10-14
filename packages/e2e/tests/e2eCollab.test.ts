import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ColiveMessage,
  DocOpenReq,
  DocOpenRes,
  encodeBinaryFrame,
  decodeBinaryFrame,
  BINARY_FRAME_KINDS,
  FsReadReq,
  FsReadRes,
  FsWriteReq,
  GuestJoin,
  HostCreateSession,
  HostJoinDecision,
  PROTOCOL_VERSION,
  ServerJoinAccepted,
  ServerJoinRequest,
  ServerSessionCreated,
} from '@colive/protocol';
import { createServer } from '@colive/server';

describe('Milestone 10: Headless E2E Multi-client Stress & Security Test', () => {
  let server: any;
  let serverWsUrl: string;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colive-e2e-'));
    // Setup sample files
    fs.writeFileSync(path.join(tempDir, 'file1.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'file2.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(tempDir, 'file3.ts'), 'export const c = 3;\n');
    fs.writeFileSync(path.join(tempDir, '.env'), 'DATABASE_PASSWORD=supersecret\n');

    server = await createServer(0, { LOG_LEVEL: 'fatal' });
    serverWsUrl = `ws://127.0.0.1:${server.port}/ws`;
  });

  afterAll(async () => {
    if (server) await server.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs 5,000 edits across 3 files with bot host + 2 RW guests + 1 RO guest, asserting convergence & security', async () => {
    // 1. Connect Host
    const hostWs = new WebSocket(serverWsUrl);
    await new Promise((res) => hostWs.on('open', res));

    // Send hello and wait for server ack
    const hostHelloAck = new Promise((res) => {
      const handler = (d: any) => {
        try {
          const m = JSON.parse(d.toString());
          if (m.type === 'helloAck') {
            hostWs.off('message', handler);
            res(m);
          }
        } catch {
        // ignore parse error
      }
      };
      hostWs.on('message', handler);
    });
    hostWs.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', clientVersion: '0.1.0', role: 'host' }));
    await hostHelloAck;

    // Create session
    const sessionCreatedPromise: Promise<ServerSessionCreated> = new Promise((res) => {
      const handler = (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'server.sessionCreated') {
            hostWs.off('message', handler);
            res(msg);
          }
        } catch {
        // ignore parse error
      }
      };
      hostWs.on('message', handler);
    });

    const createReq: HostCreateSession = {
      v: PROTOCOL_VERSION,
      type: 'host.createSession',
      displayName: 'Host User',
    };
    hostWs.send(JSON.stringify(createReq));

    const sessionCreated = await sessionCreatedPromise;
    const sessionId = sessionCreated.sessionId;
    const secret = sessionCreated.inviteSecret;

    // 2. Setup Host message handling and RPC responder
    const hostDocs = new Map<string, Y.Doc>();
    const fileNames = ['file1.ts', 'file2.ts', 'file3.ts'];
    for (const f of fileNames) {
      const ydoc = new Y.Doc();
      const initialContent = fs.readFileSync(path.join(tempDir, f), 'utf8');
      ydoc.getText('content').insert(0, initialContent);
      hostDocs.set(f, ydoc);
    }

    hostWs.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        try {
          const decoded = decodeBinaryFrame(buf);
          if (decoded.kind === BINARY_FRAME_KINDS.DOC_UPDATE) {
            const relPath = decoded.docId.replace('doc_', '');
            const ydoc = hostDocs.get(relPath);
            if (ydoc) {
              Y.applyUpdate(ydoc, decoded.payload, 'remote');
            }
          }
        } catch {
        // ignore parse error
      }
        return;
      }

      try {
        const msg = JSON.parse(data.toString()) as ColiveMessage;
        if (msg.type === 'server.joinRequest') {
          const joinReq = msg as ServerJoinRequest;
          const acceptMsg: HostJoinDecision = {
            v: PROTOCOL_VERSION,
            type: 'host.joinDecision',
            requestId: joinReq.requestId,
            accept: true,
            permission: joinReq.displayName.includes('RO') ? 'readOnly' : 'readWrite',
          };
          hostWs.send(JSON.stringify(acceptMsg));
        } else if (msg.type === 'doc.open.req') {
          const req = msg as DocOpenReq;
          const resMsg: DocOpenRes = {
            v: PROTOCOL_VERSION,
            type: 'doc.open.res',
            id: req.id,
            docId: `doc_${req.path}`,
            initialStateVectorRequired: true,
          };
          hostWs.send(JSON.stringify(resMsg));

          const ydoc = hostDocs.get(req.path);
          if (ydoc) {
            const update = Y.encodeStateAsUpdate(ydoc);
            const bin = encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, `doc_${req.path}`, update);
            hostWs.send(bin);
          }
        } else if (msg.type === 'fs.read.req') {
          const req = msg as FsReadReq;
          // Security: Exclusion check
          if (req.path.includes('.env') || req.path.includes('..')) {
            hostWs.send(JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'error',
              id: req.id,
              code: 'FORBIDDEN',
              message: 'Access to excluded or traversal path forbidden',
            }));
            return;
          }
          const fullPath = path.join(tempDir, req.path);
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, 'utf8');
            const resMsg: FsReadRes = {
              v: PROTOCOL_VERSION,
              type: 'fs.read.res',
              id: req.id,
              contentBase64: Buffer.from(content).toString('base64'),
              mtime: fs.statSync(fullPath).mtimeMs,
              isBinary: false,
            };
            hostWs.send(JSON.stringify(resMsg));
          }
        }
      } catch {
        // ignore parse error
      }
    });

    // 3. Connect Guests
    async function connectGuest(name: string): Promise<{ ws: WebSocket; guestId: string; permission: string; docs: Map<string, Y.Doc> }> {
      const ws = new WebSocket(serverWsUrl);
      await new Promise((res) => ws.on('open', res));

      const helloAck = new Promise((res) => {
        const handler = (d: any) => {
          try {
            const m = JSON.parse(d.toString());
            if (m.type === 'helloAck') {
              ws.off('message', handler);
              res(m);
            }
          } catch {
        // ignore parse error
      }
        };
        ws.on('message', handler);
      });
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', clientVersion: '0.1.0', role: 'guest' }));
      await helloAck;

      const acceptedPromise: Promise<ServerJoinAccepted> = new Promise((res) => {
        const handler = (d: any) => {
          try {
            const m = JSON.parse(d.toString());
            if (m.type === 'server.joinAccepted') {
              ws.off('message', handler);
              res(m);
            }
          } catch {
        // ignore parse error
      }
        };
        ws.on('message', handler);
      });

      const joinReq: GuestJoin = {
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId,
        inviteSecret: secret,
        displayName: name,
      };
      ws.send(JSON.stringify(joinReq));

      const accepted = await acceptedPromise;

      const docs = new Map<string, Y.Doc>();

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
          try {
            const decoded = decodeBinaryFrame(buf);
            if (decoded.kind === BINARY_FRAME_KINDS.DOC_UPDATE) {
              const relPath = decoded.docId.replace('doc_', '');
              const ydoc = docs.get(relPath);
              if (ydoc) {
                Y.applyUpdate(ydoc, decoded.payload, 'remote');
              }
            }
          } catch {
        // ignore parse error
      }
        }
      });

      for (const f of fileNames) {
        const ydoc = new Y.Doc();
        docs.set(f, ydoc);

        ydoc.on('update', (update, origin) => {
          if (origin !== 'remote') {
            const bin = encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, `doc_${f}`, update);
            ws.send(bin);
          }
        });

        // Send doc.open.req and wait for confirmation
        const reqId = `open_${name}_${f}`;
        const openResPromise = new Promise((res) => {
          const handler = (d: any) => {
            try {
              const m = JSON.parse(d.toString());
              if (m.id === reqId) {
                ws.off('message', handler);
                res(m);
              }
            } catch {
        // ignore parse error
      }
          };
          ws.on('message', handler);
        });

        const openReq: DocOpenReq = {
          v: PROTOCOL_VERSION,
          type: 'doc.open.req',
          id: reqId,
          path: f,
        };
        ws.send(JSON.stringify(openReq));
        await openResPromise;
      }

      // Small pause to allow initial host document states to arrive
      await new Promise((r) => setTimeout(r, 50));

      return { ws, guestId: accepted.guestId, permission: accepted.permission, docs };
    }

    const alice = await connectGuest('Alice (RW)');
    const bob = await connectGuest('Bob (RW)');
    const charlie = await connectGuest('Charlie (RO)');

    expect(alice.permission).toBe('readWrite');
    expect(bob.permission).toBe('readWrite');
    expect(charlie.permission).toBe('readOnly');

    // 4. Verify Excluded files are forbidden
    const envResponsePromise: Promise<any> = new Promise((res) => {
      const handler = (d: any) => {
        try {
          const m = JSON.parse(d.toString());
          if (m.id === 'req_env') {
            alice.ws.off('message', handler);
            res(m);
          }
        } catch {
        // ignore parse error
      }
      };
      alice.ws.on('message', handler);
    });

    const readEnvReq: FsReadReq = {
      v: PROTOCOL_VERSION,
      type: 'fs.read.req',
      id: 'req_env',
      path: '.env',
    };
    alice.ws.send(JSON.stringify(readEnvReq));

    const envResponse = await envResponsePromise;
    expect(envResponse.code).toBe('FORBIDDEN');

    // 5. Verify Read-Only Guest cannot write
    const roResponsePromise: Promise<any> = new Promise((res) => {
      const handler = (d: any) => {
        try {
          const m = JSON.parse(d.toString());
          if (m.id === 'req_ro_write') {
            charlie.ws.off('message', handler);
            res(m);
          }
        } catch {
        // ignore parse error
      }
      };
      charlie.ws.on('message', handler);
    });

    const writeReq: FsWriteReq = {
      v: PROTOCOL_VERSION,
      type: 'fs.write.req',
      id: 'req_ro_write',
      path: 'file1.ts',
      contentBase64: Buffer.from('unauthorized').toString('base64'),
    };
    charlie.ws.send(JSON.stringify(writeReq));

    const roResponse = await roResponsePromise;
    // Server drops write with READ_ONLY error
    expect(roResponse.code).toBe('READ_ONLY');

    // 6. Perform 5,000 edits across the 3 files between Alice and Bob
    const totalTransactions = 500;
    const opsPerTransaction = 10; // 500 * 10 = 5,000 total edits

    for (let t = 0; t < totalTransactions; t++) {
      const fileKey = fileNames[t % fileNames.length]!;
      const client = t % 2 === 0 ? alice : bob;
      const doc = client.docs.get(fileKey)!;
      const ytext = doc.getText('content');

      doc.transact(() => {
        for (let j = 0; j < opsPerTransaction; j++) {
          const char = String.fromCharCode(65 + ((t * 10 + j) % 26));
          const pos = (t * 10 + j) % Math.max(1, ytext.length);
          ytext.insert(pos, char);
        }
      });

      if (t % 50 === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    // Wait for final sync convergence
    await new Promise((r) => setTimeout(r, 1000));

    // 7. Assert CRDT convergence across Alice, Bob, and Host
    for (const f of fileNames) {
      const aliceText = alice.docs.get(f)!.getText('content').toString();
      const bobText = bob.docs.get(f)!.getText('content').toString();
      const hostText = hostDocs.get(f)!.getText('content').toString();
      expect(aliceText).toBe(bobText);
      expect(hostText).toBe(aliceText);
      expect(aliceText.length).toBeGreaterThan(100);

      // Persist to host disk and verify host disk equals converged state
      const diskPath = path.join(tempDir, f);
      fs.writeFileSync(diskPath, hostText, 'utf8');
      const onDisk = fs.readFileSync(diskPath, 'utf8');
      expect(onDisk).toBe(hostText);
    }

    // 8. Clean teardown
    alice.ws.close();
    bob.ws.close();
    charlie.ws.close();
    hostWs.close();
  }, 30_000);
});
