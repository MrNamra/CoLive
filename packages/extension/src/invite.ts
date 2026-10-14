export interface ParsedInvite {
  sessionId: string;
  secret: string;
  serverUrl?: string;
}

/**
 * Builds the deep link for joining a session.
 */
export function buildDeepLink(
  sessionId: string,
  secret: string,
  serverUrl?: string,
  publisher = 'colive-team',
): string {
  let link = `vscode://${publisher}.colive/join?session=${encodeURIComponent(sessionId)}&secret=${encodeURIComponent(secret)}`;
  if (serverUrl) {
    link += `&server=${encodeURIComponent(serverUrl)}`;
  }
  return link;
}

/**
 * Builds the compact paste-code format: "<sessionId>.<secret>" or "<sessionId>.<secret>@<serverUrl>".
 */
export function buildPasteCode(sessionId: string, secret: string, serverUrl?: string): string {
  if (serverUrl && !serverUrl.includes('localhost') && !serverUrl.includes('127.0.0.1')) {
    return `${sessionId}.${secret}@${serverUrl}`;
  }
  return `${sessionId}.${secret}`;
}

/**
 * Normalizes a tunnel / server URL into a WebSocket endpoint (wss://.../ws).
 */
export function normalizeServerWsUrl(url: string): string {
  let wsUrl = url.trim();
  if (wsUrl.startsWith('https://')) {
    wsUrl = wsUrl.replace('https://', 'wss://');
  } else if (wsUrl.startsWith('http://')) {
    wsUrl = wsUrl.replace('http://', 'ws://');
  } else if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
    wsUrl = `wss://${wsUrl}`;
  }
  if (!wsUrl.endsWith('/ws')) {
    wsUrl = wsUrl.replace(/\/+$/, '') + '/ws';
  }
  return wsUrl;
}

/**
 * Parses user input into a sessionId, secret, and optional serverUrl.
 * Accepts:
 * - "<sessionId>.<secret>"
 * - "<sessionId>.<secret>@<serverUrl>"
 * - "vscode://<publisher>.colive/join?session=<id>&secret=<secret>&server=<serverUrl>"
 * - "http(s)://<domain>/j/<sessionId>#<secret>"
 */
export function parseInviteInput(input: string): ParsedInvite | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // 1. Check if paste code with server: <sessionId>.<secret>@<serverUrl>
  if (trimmed.includes('@') && !trimmed.startsWith('vscode://') && !trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    const atIdx = trimmed.indexOf('@');
    const codePart = trimmed.slice(0, atIdx);
    const serverPart = trimmed.slice(atIdx + 1).trim();
    const parts = codePart.split('.');
    if (parts.length === 2) {
      const [sessionId, secret] = parts;
      if (sessionId && secret && /^[a-zA-Z0-9_-]+$/.test(sessionId) && /^[a-zA-Z0-9_-]+$/.test(secret)) {
        return {
          sessionId,
          secret,
          serverUrl: normalizeServerWsUrl(serverPart),
        };
      }
    }
  }

  // 2. Check if simple paste code format: <sessionId>.<secret>
  const parts = trimmed.split('.');
  if (parts.length === 2 && !trimmed.includes('/') && !trimmed.includes(':') && !trimmed.includes(' ')) {
    const [sessionId, secret] = parts;
    if (sessionId && secret && /^[a-zA-Z0-9_-]+$/.test(sessionId) && /^[a-zA-Z0-9_-]+$/.test(secret)) {
      return { sessionId, secret };
    }
  }

  // 3. Check if deep link: vscode://.../join?session=...&secret=...[&server=...]
  if (trimmed.startsWith('vscode://') || trimmed.startsWith('vscode-insiders://') || trimmed.startsWith('cursor://')) {
    try {
      const url = new URL(trimmed);
      const sessionId = url.searchParams.get('session');
      const secret = url.searchParams.get('secret') || url.hash.replace(/^#/, '');
      const rawServer = url.searchParams.get('server');
      const serverUrl = rawServer ? normalizeServerWsUrl(rawServer) : undefined;
      if (sessionId && secret) {
        return { sessionId, secret, ...(serverUrl ? { serverUrl } : {}) };
      }
    } catch {
      // Fall through
    }
  }

  // 4. Check web URL: http(s)://.../j/<sessionId>#<secret> or ?session=...
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const match = url.pathname.match(/\/j\/([a-zA-Z0-9_-]+)/);
      const sessionId = match ? match[1] : url.searchParams.get('session');
      const secret = url.hash.replace(/^#/, '') || url.searchParams.get('secret');
      const rawServer = url.searchParams.get('server');
      const serverUrl = rawServer
        ? normalizeServerWsUrl(rawServer)
        : url.hostname.includes('trycloudflare.com')
          ? normalizeServerWsUrl(`https://${url.host}/ws`)
          : undefined;

      if (sessionId && secret) {
        return { sessionId, secret, ...(serverUrl ? { serverUrl } : {}) };
      }
    } catch {
      // Fall through
    }
  }

  return null;
}
