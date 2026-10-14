import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@colive/protocol';
import { loadConfig, ServerConfig } from './config.js';
import { RelayServer, logger } from './relay.js';

export { RelayServer, logger };

export interface ServerInstance {
  server: http.Server;
  wss: WebSocketServer;
  relay: RelayServer;
  port: number;
  close: () => Promise<void>;
}

export function createServer(
  port = 8787,
  customConfig?: Partial<ServerConfig>,
): Promise<ServerInstance> {
  const config = loadConfig({
    ...process.env,
    PORT: port,
    ...customConfig,
  });

  const relay = new RelayServer(config);
  relay.startHeartbeat();

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // 1. Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '0.1.0', protocolVersion: PROTOCOL_VERSION }));
        return;
      }

      // 2. Prometheus metrics
      if (req.method === 'GET' && url.pathname === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(relay.getMetrics().toPrometheusText());
        return;
      }

      // 3. Web join landing page: /j/:sessionId
      const joinMatch = url.pathname.match(/^\/j\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && joinMatch) {
        const sessionId = joinMatch[1];
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join CoLive Session</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 480px; text-align: center; border: 1px solid #334155; }
    h1 { margin-top: 0; color: #38bdf8; }
    p { color: #94a3b8; line-height: 1.5; }
    .btn { display: inline-block; background: #0284c7; color: white; padding: 0.75rem 1.5rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600; margin: 1rem 0; cursor: pointer; border: none; }
    .btn:hover { background: #0369a1; }
    .code-box { background: #0f172a; padding: 0.75rem; border-radius: 0.375rem; font-family: monospace; font-size: 0.875rem; margin-top: 1rem; word-break: break-all; border: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="card">
    <h1>CoLive Session</h1>
    <p>You have been invited to join an active real-time collaboration session.</p>
    <a id="joinBtn" class="btn" href="#">Open in Your Editor</a>
    <p style="font-size: 0.8rem;">Or paste this invite code in CoLive:</p>
    <div id="codeBox" class="code-box">Loading...</div>
  </div>
  <script>
    const secret = window.location.hash.replace(/^#/, '');
    const sessionId = "${sessionId}";
    const fullCode = secret ? sessionId + '.' + secret : sessionId;
    document.getElementById('codeBox').textContent = fullCode;
    const deepLink = 'vscode://colive-team.colive/join?session=' + sessionId + (secret ? '&secret=' + secret : '');
    document.getElementById('joinBtn').href = deepLink;
  </script>
</body>
</html>`);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          relay.handleConnection(ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    server.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      logger.info({ port: actualPort }, `CoLive relay server listening on port ${actualPort}`);

      resolve({
        server,
        wss,
        relay,
        port: actualPort,
        close: async () => {
          await relay.shutdown();
          await new Promise<void>((closeResolve) => {
            wss.close(() => {
              server.close(() => closeResolve());
            });
          });
        },
      });
    });
  });
}

// Graceful shutdown helper
const isDirectRun =
  process.env.NODE_ENV !== 'test' &&
  ((Boolean(import.meta?.url) && import.meta.url === `file://${process.argv[1]}`) ||
    process.argv.some((arg) => arg.includes('index.ts') || arg.includes('index.js')));

if (isDirectRun) {
  createServer().then((inst) => {
    const handleSignal = async (sig: string) => {
      logger.info({ signal: sig }, 'Received termination signal. Shutting down gracefully...');
      await inst.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));
  });
}
