import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import pino from 'pino';
import { PROTOCOL_VERSION } from '@colive/protocol';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

export interface ServerInstance {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  close: () => Promise<void>;
}

/**
 * Creates and starts the HTTP and WebSocket server.
 */
export function createServer(port: number = Number(process.env.PORT) || 8787): Promise<ServerInstance> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '0.1.0', protocolVersion: PROTOCOL_VERSION }));
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
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on('connection', (_ws: WebSocket) => {
      logger.info('New WebSocket connection established');
    });

    server.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      logger.info({ port: actualPort }, `CoLive server listening on port ${actualPort}`);

      resolve({
        server,
        wss,
        port: actualPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            wss.close((wsErr) => {
              if (wsErr) {
                closeReject(wsErr);
                return;
              }
              server.close((httpErr) => {
                if (httpErr) closeReject(httpErr);
                else closeResolve();
              });
            });
          }),
      });
    });
  });
}

// Start if executed directly
if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  createServer();
}
