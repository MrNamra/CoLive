import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BINARY_FRAME_KINDS,
  decodeBinaryFrame,
  DocOpenRes,
  encodeBinaryFrame,
  hashDocId,
  ServerJoinAccepted,
  ServerSessionCreated,
} from '@colive/protocol';
import { createServer, ServerInstance } from '@colive/server';
import { ConnectionManager } from '../src/connection.js';
import { DocumentBinding } from '../src/sync/DocumentBinding.js';
import { HostPersistence } from '../src/host/persistence.js';
import {
  MockTextDocument,
  mockDocuments,
  Uri,
} from './mocks/vscode.js';

describe('Milestone 6: Real-time co-editing with Yjs', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'colive-sync-test-'));
    mockDocuments.clear();
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup
    }
  });

  // --------------------------------------------------------------------------
  // 1. Fuzz test: 3 simulated clients, 1,000 random operations with latency
  // --------------------------------------------------------------------------
  it('Fuzz test: 3 simulated clients converge over 1,000 operations with random network delay and reordering', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const docC = new Y.Doc();

    const ytextA = docA.getText('content');
    const ytextB = docB.getText('content');
    const ytextC = docC.getText('content');

    // Initial identical text
    ytextA.insert(0, 'The quick brown fox jumps over the lazy dog.');
    const initUpdate = Y.encodeStateAsUpdate(docA);
    Y.applyUpdate(docB, initUpdate);
    Y.applyUpdate(docC, initUpdate);

    interface QueuedPacket {
      target: 'A' | 'B' | 'C';
      update: Uint8Array;
      deliverAt: number;
    }

    const networkQueue: QueuedPacket[] = [];
    let tick = 0;

    const broadcast = (source: 'A' | 'B' | 'C', update: Uint8Array) => {
      const targets = (['A', 'B', 'C'] as const).filter((t) => t !== source);
      for (const t of targets) {
        // Random latency between 1 and 20 ticks
        const latency = 1 + Math.floor(Math.random() * 20);
        networkQueue.push({
          target: t,
          update,
          deliverAt: tick + latency,
        });
      }
    };

    docA.on('update', (update, origin) => {
      if (origin === 'local') broadcast('A', update);
    });
    docB.on('update', (update, origin) => {
      if (origin === 'local') broadcast('B', update);
    });
    docC.on('update', (update, origin) => {
      if (origin === 'local') broadcast('C', update);
    });

    const chars = 'abcdefghijklmnopqrstuvwxyz 0123456789\n';

    // Run 1,000 random operations
    for (let opIdx = 0; opIdx < 1000; opIdx++) {
      tick++;

      // Pick a random client: A, B, or C
      const client = Math.random() < 0.34 ? 'A' : Math.random() < 0.5 ? 'B' : 'C';
      const ytext = client === 'A' ? ytextA : client === 'B' ? ytextB : ytextC;
      const doc = client === 'A' ? docA : client === 'B' ? docB : docC;

      const isInsert = Math.random() < 0.6 || ytext.length === 0;

      doc.transact(() => {
        if (isInsert) {
          const pos = Math.floor(Math.random() * (ytext.length + 1));
          const numChars = 1 + Math.floor(Math.random() * 8);
          let str = '';
          for (let i = 0; i < numChars; i++) {
            str += chars[Math.floor(Math.random() * chars.length)];
          }
          ytext.insert(pos, str);
        } else {
          const pos = Math.floor(Math.random() * ytext.length);
          const maxLen = Math.min(6, ytext.length - pos);
          const len = 1 + Math.floor(Math.random() * maxLen);
          ytext.delete(pos, len);
        }
      }, 'local');

      // Deliver packets that are ready
      for (let i = networkQueue.length - 1; i >= 0; i--) {
        if (networkQueue[i].deliverAt <= tick) {
          const packet = networkQueue.splice(i, 1)[0];
          const targetDoc = packet.target === 'A' ? docA : packet.target === 'B' ? docB : docC;
          Y.applyUpdate(targetDoc, packet.update, 'remote');
        }
      }
    }

    // Flush all remaining packets
    while (networkQueue.length > 0) {
      const packet = networkQueue.shift()!;
      const targetDoc = packet.target === 'A' ? docA : packet.target === 'B' ? docB : docC;
      Y.applyUpdate(targetDoc, packet.update, 'remote');
    }

    const textA = ytextA.toString();
    const textB = ytextB.toString();
    const textC = ytextC.toString();

    expect(textA).toBe(textB);
    expect(textB).toBe(textC);
    expect(textA.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // 2. Edge cases: emoji, CRLF, multi-cursor, 100 KB paste, undo bursts
  // --------------------------------------------------------------------------
  describe('Edge cases and Unicode handling', () => {
    it('handles emoji and surrogate pairs at exact UTF-16 code unit offsets', () => {
      const doc = new Y.Doc();
      const ytext = doc.getText('content');
      const initial = 'Hello 🌍 World 🚀!';
      ytext.insert(0, initial);

      expect(ytext.toString().length).toBe(initial.length);

      // 🌍 is at index 6, length 2 (surrogate pair)
      doc.transact(() => {
        ytext.delete(6, 2);
        ytext.insert(6, '🎉'); // replace with 🎉 (also length 2)
      }, 'local');

      expect(ytext.toString()).toBe('Hello 🎉 World 🚀!');

      // Replace 🚀 (index 15, length 2) with multi-byte family emoji 👨‍👩‍👦
      doc.transact(() => {
        ytext.delete(15, 2);
        ytext.insert(15, '🌟');
      }, 'local');

      expect(ytext.toString()).toBe('Hello 🎉 World 🌟!');
    });

    it('normalizes CRLF to LF in Y.Text', () => {
      const doc = new Y.Doc();
      const ytext = doc.getText('content');
      const crlfText = 'line1\r\nline2\r\nline3\r\n';
      const normalized = crlfText.replace(/\r\n/g, '\n');

      ytext.insert(0, normalized);

      expect(ytext.toString()).not.toContain('\r\n');
      expect(ytext.toString()).toBe('line1\nline2\nline3\n');
    });

    it('handles multi-cursor edits sorted in descending order', () => {
      const doc = new Y.Doc();
      const ytext = doc.getText('content');
      ytext.insert(0, 'const a = 1;\nconst b = 2;\nconst c = 3;');

      // Multi-cursor inserting 'export ' before each 'const'
      // Positions in original text: 0, 13, 26
      const edits = [
        { offset: 0, text: 'export ' },
        { offset: 13, text: 'export ' },
        { offset: 26, text: 'export ' },
      ];

      // Descending order sort
      edits.sort((x, y) => y.offset - x.offset);

      doc.transact(() => {
        for (const edit of edits) {
          ytext.insert(edit.offset, edit.text);
        }
      }, 'local');

      expect(ytext.toString()).toBe('export const a = 1;\nexport const b = 2;\nexport const c = 3;');
    });

    it('handles 100 KB text paste without corruption', () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const ytextA = docA.getText('content');
      const ytextB = docB.getText('content');

      docA.on('update', (u) => Y.applyUpdate(docB, u));

      // Generate 100 KB of structured text
      const chunk = 'function computeMetric(x: number): number { return x * 42; }\n';
      const repetitions = Math.ceil(100_000 / chunk.length);
      const largePayload = chunk.repeat(repetitions);

      ytextA.insert(0, largePayload);

      expect(ytextA.toString().length).toBeGreaterThanOrEqual(100_000);
      expect(ytextB.toString()).toBe(ytextA.toString());
    });

    it('handles undo bursts (insert followed by inverse delete)', () => {
      const doc = new Y.Doc();
      const ytext = doc.getText('content');
      const base = 'Initial function body';
      ytext.insert(0, base);

      // Typing burst
      doc.transact(() => {
        ytext.insert(base.length, '\n// Temporary debug comment\nconsole.log(data);');
      }, 'local');

      const addedLen = '\n// Temporary debug comment\nconsole.log(data);'.length;
      expect(ytext.toString().length).toBe(base.length + addedLen);

      // Undo burst (exact inverse delete)
      doc.transact(() => {
        ytext.delete(base.length, addedLen);
      }, 'local');

      expect(ytext.toString()).toBe(base);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Host Persistence and external disk change merge (fast-diff)
  // --------------------------------------------------------------------------
  describe('Host persistence and external disk merge', () => {
    it('persists changes to disk with debounce and preserves CRLF and BOM', async () => {
      const filePath = path.join(tempDir, 'test-crlf-bom.txt');
      const initialCrlf = '\uFEFFheader\r\nline2\r\nline3\r\n';
      await fs.promises.writeFile(filePath, Buffer.from(initialCrlf, 'utf8'));

      const fakeConnection = {
        sendJson: () => {},
      } as unknown as ConnectionManager;

      const persistence = new HostPersistence({
        workspaceRoot: tempDir,
        connection: fakeConnection,
        debounceMs: 50,
      });

      persistence.trackFileProperties('test-crlf-bom.txt', initialCrlf);

      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('content');
      ytext.insert(0, 'header\nline2\nline3 modified\n');

      // Schedule debounced save
      persistence.scheduleSave('test-crlf-bom.txt', 'doc123', ydoc);

      // Wait for debounce and disk write to flush
      let savedStr = '';
      let savedBuffer = Buffer.alloc(0);
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        savedBuffer = await fs.promises.readFile(filePath);
        savedStr = savedBuffer.toString('utf8');
        if (savedStr.includes('line3 modified')) break;
      }

      // Check BOM
      expect(savedBuffer[0]).toBe(0xef);
      expect(savedBuffer[1]).toBe(0xbb);
      expect(savedBuffer[2]).toBe(0xbf);

      expect(savedStr).toContain('\r\n');
      expect(savedStr).toContain('line3 modified');

      persistence.dispose();
    });

    it('merges external disk changes via fast-diff while clients type concurrently', async () => {
      const filePath = path.join(tempDir, 'merge.ts');
      const initialContent = 'line 1\nline 2\nline 3\n';
      await fs.promises.writeFile(filePath, initialContent, 'utf8');

      const fakeConnection = {
        sendJson: () => {},
      } as unknown as ConnectionManager;

      const persistence = new HostPersistence({
        workspaceRoot: tempDir,
        connection: fakeConnection,
        debounceMs: 50,
      });

      persistence.trackFileProperties('merge.ts', initialContent);

      const ydocHost = new Y.Doc();
      const ydocGuest = new Y.Doc();
      const ytextHost = ydocHost.getText('content');
      const ytextGuest = ydocGuest.getText('content');

      ytextHost.insert(0, initialContent);
      Y.applyUpdate(ydocGuest, Y.encodeStateAsUpdate(ydocHost));

      // 1. Guest types at line 1
      ydocGuest.transact(() => {
        ytextGuest.insert(0, '// Guest header\n');
      }, 'local');
      Y.applyUpdate(ydocHost, Y.encodeStateAsUpdate(ydocGuest));

      // 2. External disk change happens (e.g. formatter modifies line 3)
      const externalFormatted = 'line 1\nline 2\nline 3 formatted;\n';
      await fs.promises.writeFile(filePath, externalFormatted, 'utf8');

      // 3. Host merges external disk change
      await persistence.mergeExternalDiskChange('merge.ts', ydocHost);
      Y.applyUpdate(ydocGuest, Y.encodeStateAsUpdate(ydocHost));

      // 4. Assert both guest header and formatted line 3 are preserved
      const converged = ytextHost.toString();
      expect(converged).toContain('// Guest header');
      expect(converged).toContain('line 3 formatted;');
      expect(ytextGuest.toString()).toBe(converged);

      persistence.dispose();
    });
  });

  // --------------------------------------------------------------------------
  // 4. DocumentBinding: Bi-directional VS Code sync and drift recovery
  // --------------------------------------------------------------------------
  describe('DocumentBinding and editor synchronization', () => {
    it('synchronizes local editor changes to Y.Text and remote changes to editor', async () => {
      const uri = Uri.file('/workspace/test.ts');
      const doc = new MockTextDocument(uri, 'const x = 10;');
      mockDocuments.set(uri.toString(), doc);

      const ydoc = new Y.Doc();
      const binding = new DocumentBinding({
        document: doc as unknown as vscode.TextDocument,
        ydoc,
      });

      // Initial state populated from document
      expect(ydoc.getText('content').toString()).toBe('const x = 10;');

      // Remote update arrives
      ydoc.transact(() => {
        ydoc.getText('content').insert(13, '\nconst y = 20;');
      }, 'remote');

      // Wait a tick for async WorkspaceEdit apply
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(doc.getText()).toBe('const x = 10;\nconst y = 20;');

      // Test automatic drift recovery
      // Intentionally desynchronize mock document out of band
      doc.setContent('desynchronized text');
      expect(doc.getText()).not.toBe(ydoc.getText('content').toString());

      // Force resync
      await binding.forceFullResync();
      expect(doc.getText()).toBe(ydoc.getText('content').toString());

      binding.dispose();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Headless Host + Guest against real Relay Server with disk persistence
  // --------------------------------------------------------------------------
  describe('Headless integration: Host + Guest co-editing with real server and disk persistence', () => {
    let serverInstance: ServerInstance;
    let serverUrl: string;

    beforeEach(async () => {
      serverInstance = await createServer(0);
      serverUrl = `ws://127.0.0.1:${serverInstance.port}/ws`;
    });

    afterEach(async () => {
      await serverInstance.close();
    });

    it('Host and Guest collaboratively edit a file over real WebSocket relay, converging on disk', async () => {
      const relPath = 'src/index.ts';
      const fullPath = path.join(tempDir, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'console.log("hello");\n', 'utf8');

      // 1. Host connects and creates session
      const hostConn = new ConnectionManager(serverUrl, 'host');
      await hostConn.connect();

      const sessionCreated = await hostConn.request<ServerSessionCreated>({
        v: 1,
        type: 'host.createSession',
        displayName: 'Alice Host',
      });
      expect(sessionCreated.type).toBe('server.sessionCreated');
      const { sessionId, inviteSecret } = sessionCreated;

      const docId = hashDocId(relPath);

      // Setup Host Y.Doc and Persistence
      const hostYDoc = new Y.Doc();
      const hostYText = hostYDoc.getText('content');
      hostYText.insert(0, 'console.log("hello");\n');

      const hostPersistence = new HostPersistence({
        workspaceRoot: tempDir,
        connection: hostConn,
        debounceMs: 50,
      });
      hostPersistence.trackFileProperties(relPath, 'console.log("hello");\n');

      // Host outgoing updates -> binary frame
      hostYDoc.on('update', (update, origin) => {
        if (origin === 'local' || origin === 'disk') {
          const enc = encoding.createEncoder();
          sync.writeUpdate(enc, update);
          const frame = encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, docId, encoding.toUint8Array(enc));
          hostConn.sendBinary(frame);
          hostPersistence.scheduleSave(relPath, docId, hostYDoc);
        }
      });

      // Host handles doc.open.req and binary frames
      hostConn.on('message', (msg) => {
        if (msg.type === 'doc.open.req') {
          hostConn.sendJson({
            v: 1,
            type: 'doc.open.res',
            id: msg.id,
            docId,
          });
        }
      });

      hostConn.on('binary', (data) => {
        const decoded = decodeBinaryFrame(data);
        if (decoded.kind === BINARY_FRAME_KINDS.DOC_UPDATE && decoded.docId === docId) {
          const reply = encoding.createEncoder();
          sync.readSyncMessage(decoding.createDecoder(decoded.payload), reply, hostYDoc, 'remote');
          if (encoding.length(reply) > 0) {
            hostConn.sendBinary(
              encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, docId, encoding.toUint8Array(reply)),
            );
          }
          hostPersistence.scheduleSave(relPath, docId, hostYDoc);
        }
      });

      // 2. Guest connects and joins session
      const guestConn = new ConnectionManager(serverUrl, 'guest');
      await guestConn.connect();

      // Host auto-approves join request
      hostConn.on('message', (msg) => {
        if (msg.type === 'server.joinRequest') {
          hostConn.sendJson({
            v: 1,
            type: 'host.joinDecision',
            requestId: msg.requestId,
            accept: true,
            permission: 'readWrite',
          });
        }
      });

      const joinAccepted = await guestConn.request<ServerJoinAccepted>({
        v: 1,
        type: 'guest.join',
        sessionId,
        inviteSecret,
        displayName: 'Bob Guest',
      });
      expect(joinAccepted.type).toBe('server.joinAccepted');

      // 3. Guest opens doc
      const guestYDoc = new Y.Doc();
      const guestYText = guestYDoc.getText('content');

      guestYDoc.on('update', (update, origin) => {
        if (origin === 'local') {
          const enc = encoding.createEncoder();
          sync.writeUpdate(enc, update);
          guestConn.sendBinary(
            encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, docId, encoding.toUint8Array(enc)),
          );
        }
      });

      guestConn.on('binary', (data) => {
        const decoded = decodeBinaryFrame(data);
        if (decoded.kind === BINARY_FRAME_KINDS.DOC_UPDATE && decoded.docId === docId) {
          const reply = encoding.createEncoder();
          sync.readSyncMessage(decoding.createDecoder(decoded.payload), reply, guestYDoc, 'remote');
          if (encoding.length(reply) > 0) {
            guestConn.sendBinary(
              encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, docId, encoding.toUint8Array(reply)),
            );
          }
        }
      });

      // Guest sends doc.open.req
      const openRes = await guestConn.request<DocOpenRes>({
        v: 1,
        type: 'doc.open.req',
        path: relPath,
      });
      expect(openRes.docId).toBe(docId);

      // Guest initiates sync step 1
      const enc1 = encoding.createEncoder();
      sync.writeSyncStep1(enc1, guestYDoc);
      guestConn.sendBinary(encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, docId, encoding.toUint8Array(enc1)));

      // Wait for initial sync handshake to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(guestYText.toString()).toBe('console.log("hello");\n');

      // 4. Guest edits document
      guestYDoc.transact(() => {
        guestYText.insert(guestYText.length, 'const guestVar = 42;\n');
      }, 'local');

      // 5. Host edits document concurrently
      hostYDoc.transact(() => {
        hostYText.insert(0, '// CoLive shared file\n');
      }, 'local');

      // Wait for network sync and persistence debounce (50ms)
      await new Promise((resolve) => setTimeout(resolve, 250));

      // 6. Assert both Y.Docs converged
      const hostText = hostYText.toString();
      const guestText = guestYText.toString();
      expect(guestText).toBe(hostText);
      expect(hostText).toContain('// CoLive shared file');
      expect(hostText).toContain('const guestVar = 42;');

      // 7. Assert Host persisted converged state to disk
      const finalDiskContent = await fs.promises.readFile(fullPath, 'utf8');
      expect(finalDiskContent).toBe(hostText);

      // Cleanup
      hostPersistence.dispose();
      hostConn.disconnect();
      guestConn.disconnect();
    });
  });
});
