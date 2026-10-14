#!/usr/bin/env ts-node
/**
 * CoLive Load Testing Harness
 * Simulates multiple concurrent sessions and participants to benchmark relay latency and throughput.
 * Measures p50, p90, p95, and p99 round-trip latency.
 */

import WebSocket from 'ws';
import crypto from 'node:crypto';
import {
  ColiveMessage,
  GuestJoin,
  HostCreateSession,
  HostJoinDecision,
  PROTOCOL_VERSION,
  ServerJoinAccepted,
  ServerJoinRequest,
  ServerSessionCreated,
} from '../packages/protocol/src/index.js';

interface LatencyStats {
  count: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

function calculatePercentiles(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return { count: 0, min: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const getP = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p50: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99),
  };
}

async function runLoadTest(
  targetUrl = process.env.COLIVE_TARGET_URL || 'ws://127.0.0.1:8787/ws',
  sessionCount = 10,
  guestsPerSession = 4,
  opsPerGuest = 50,
) {
  console.log(`\n========================================`);
  console.log(`CoLive Relay Load Test`);
  console.log(`Target: ${targetUrl}`);
  console.log(`Sessions: ${sessionCount}`);
  console.log(`Participants per session: ${guestsPerSession + 1} (1 host + ${guestsPerSession} guests)`);
  console.log(`Total concurrent clients: ${sessionCount * (guestsPerSession + 1)}`);
  console.log(`Ops per guest: ${opsPerGuest} (${sessionCount * guestsPerSession * opsPerGuest} total ops)`);
  console.log(`========================================\n`);

  const latencies: number[] = [];
  const pendingEchoes = new Map<string, number>();

  async function createClient(role: 'host' | 'guest'): Promise<WebSocket> {
    const ws = new WebSocket(targetUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const helloAckPromise = new Promise((res) => {
      const handler = (data: any) => {
        try {
          const m = JSON.parse(data.toString());
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

    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', clientVersion: '0.1.0', role }));
    await helloAckPromise;
    return ws;
  }

  const startTime = Date.now();

  for (let s = 0; s < sessionCount; s++) {
    const hostWs = await createClient('host');

    const sessionCreatedPromise: Promise<ServerSessionCreated> = new Promise((res) => {
      const handler = (d: any) => {
        try {
          const m = JSON.parse(d.toString());
          if (m.type === 'server.sessionCreated') {
            hostWs.off('message', handler);
            res(m);
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
      displayName: `Host-${s + 1}`,
    };
    hostWs.send(JSON.stringify(createReq));
    const session = await sessionCreatedPromise;

    hostWs.on('message', (d) => {
      try {
        const msg = JSON.parse(d.toString()) as ColiveMessage;
        if (msg.type === 'server.joinRequest') {
          const joinReq = msg as ServerJoinRequest;
          const decision: HostJoinDecision = {
            v: PROTOCOL_VERSION,
            type: 'host.joinDecision',
            requestId: joinReq.requestId,
            accept: true,
            permission: 'readWrite',
          };
          hostWs.send(JSON.stringify(decision));
        }
      } catch {
        // ignore parse error
      }
    });

    // Spawn guests
    const guests: WebSocket[] = [];
    for (let g = 0; g < guestsPerSession; g++) {
      const guestWs = await createClient('guest');

      const acceptedPromise: Promise<ServerJoinAccepted> = new Promise((res) => {
        const handler = (d: any) => {
          try {
            const m = JSON.parse(d.toString());
            if (m.type === 'server.joinAccepted') {
              guestWs.off('message', handler);
              res(m);
            }
          } catch {
        // ignore parse error
      }
        };
        guestWs.on('message', handler);
      });

      const joinMsg: GuestJoin = {
        v: PROTOCOL_VERSION,
        type: 'guest.join',
        sessionId: session.sessionId,
        inviteSecret: session.inviteSecret,
        displayName: `Guest-${s + 1}-${g + 1}`,
      };
      guestWs.send(JSON.stringify(joinMsg));
      await acceptedPromise;

      // Track incoming awareness or chat echo for latency measurement
      guestWs.on('message', (d) => {
        try {
          const m = JSON.parse(d.toString());
          if (m.type === 'chat.message' && m.id && pendingEchoes.has(m.id)) {
            const sentAt = pendingEchoes.get(m.id)!;
            latencies.push(Date.now() - sentAt);
            pendingEchoes.delete(m.id);
          }
        } catch {
        // ignore parse error
      }
      });

      guests.push(guestWs);
    }

    // Send broadcast messages from guests to measure latency
    for (const guest of guests) {
      for (let op = 0; op < opsPerGuest; op++) {
        const msgId = `ping_${crypto.randomBytes(8).toString('hex')}`;
        pendingEchoes.set(msgId, Date.now());
        guest.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'chat.message',
            id: msgId,
            text: `load test ping ${op}`,
            timestamp: Date.now(),
          }),
        );
      }
    }
  }

  // Allow in-flight messages to settle
  await new Promise((r) => setTimeout(r, 2000));

  const totalDurationMs = Date.now() - startTime;
  const stats = calculatePercentiles(latencies);

  console.log(`\n================ Benchmark Results ================`);
  console.log(`Total duration: ${(totalDurationMs / 1000).toFixed(2)}s`);
  console.log(`Messages recorded: ${stats.count}`);
  console.log(`Throughput: ${(stats.count / (totalDurationMs / 1000)).toFixed(1)} msg/sec`);
  console.log(`Min latency: ${stats.min.toFixed(2)} ms`);
  console.log(`p50 (median): ${stats.p50.toFixed(2)} ms`);
  console.log(`p90 latency: ${stats.p90.toFixed(2)} ms`);
  console.log(`p95 latency: ${stats.p95.toFixed(2)} ms`);
  console.log(`p99 latency: ${stats.p99.toFixed(2)} ms`);
  console.log(`Max latency: ${stats.max.toFixed(2)} ms`);
  console.log(`====================================================\n`);

  process.exit(0);
}

if (process.argv[1]?.endsWith('loadtest.ts')) {
  runLoadTest().catch((err) => {
    console.error('Load test error:', err);
    process.exit(1);
  });
}
