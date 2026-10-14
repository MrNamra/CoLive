import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, ServerInstance } from '../src/index.js';

describe('Server Smoke & Health Test', () => {
  let instance: ServerInstance;

  beforeAll(async () => {
    instance = await createServer(0); // Random available port
  });

  afterAll(async () => {
    await instance.close();
  });

  it('GET /health returns 200 with status ok', async () => {
    const res = await fetch(`http://localhost:${instance.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.protocolVersion).toBe(1);
  });

  it('connects to /ws over WebSocket', async () => {
    const ws = new WebSocket(`ws://localhost:${instance.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });
});
