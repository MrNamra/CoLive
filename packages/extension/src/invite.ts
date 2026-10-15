export interface ParsedInvite {
  sessionId: string;
  secret: string;
  serverUrl?: string;
}

/**
 * Encodes sessionId, secret, and optional serverUrl into a compact, opaque base64url token.
 * This keeps the URL short and prevents exposing session IDs, secrets, or raw server URLs in plaintext.
 */
export function encodeInviteToken(sessionId: string, secret: string, serverUrl?: string): string {
  let serverPart = '';
  if (serverUrl) {
    let clean = serverUrl.trim().replace(/^wss?:\/\//, '').replace(/\/ws$/, '');
    if (!clean.includes('localhost') && !clean.includes('127.0.0.1')) {
      if (clean.endsWith('.trycloudflare.com')) {
        serverPart = '@' + clean.replace('.trycloudflare.com', '');
      } else {
        serverPart = '@' + clean;
      }
    }
  }
  const raw = `${sessionId}.${secret}${serverPart}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Decodes a compact, opaque base64url token back into ParsedInvite.
 */
export function decodeInviteToken(token: string): ParsedInvite | null {
  if (!token || typeof token !== 'string') return null;
  const trimmed = token.trim();
  // Base64url tokens only contain alphanumeric characters, '-', and '_'
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;

  try {
    const raw = Buffer.from(trimmed, 'base64url').toString('utf8');
    const atIdx = raw.indexOf('@');
    let codePart = raw;
    let serverHost: string | undefined;

    if (atIdx >= 0) {
      codePart = raw.slice(0, atIdx);
      const rawHost = raw.slice(atIdx + 1).trim();
      if (rawHost) {
        serverHost = rawHost.includes('.') ? rawHost : `${rawHost}.trycloudflare.com`;
      }
    }

    const dotIdx = codePart.indexOf('.');
    if (dotIdx > 0) {
      const sessionId = codePart.slice(0, dotIdx);
      const secret = codePart.slice(dotIdx + 1);
      if (sessionId && secret && /^[a-zA-Z0-9_-]+$/.test(sessionId) && /^[a-zA-Z0-9_-]+$/.test(secret)) {
        return {
          sessionId,
          secret,
          ...(serverHost ? { serverUrl: normalizeServerWsUrl(serverHost) } : {}),
        };
      }
    }
  } catch {
    // Ignore decode error
  }
  return null;
}

/**
 * Builds the compact deep link for joining a session.
 * Generates: vscode://<publisher>.colive/join?c=<compactToken>
 */
export function buildDeepLink(
  sessionId: string,
  secret: string,
  serverUrl?: string,
  publisher = 'colive-team',
): string {
  const token = encodeInviteToken(sessionId, secret, serverUrl);
  return `vscode://${publisher}.colive/join?c=${token}`;
}

/**
 * Builds a browser-friendly HTTPS invite URL if a public tunnel/server is available.
 */
export function buildWebInviteUrl(sessionId: string, secret: string, serverUrl?: string): string | null {
  if (!serverUrl) return null;
  const match = serverUrl.match(/(https?|wss?):\/\/([a-zA-Z0-9_.-]+)/);
  if (!match) return null;
  const host = match[2];
  if (host.includes('localhost') || host.includes('127.0.0.1')) return null;
  const token = encodeInviteToken(sessionId, secret, serverUrl);
  return `https://${host}/j/${token}`;
}

/**
 * Builds the compact paste-code format (the opaque token).
 */
export function buildPasteCode(sessionId: string, secret: string, serverUrl?: string): string {
  return encodeInviteToken(sessionId, secret, serverUrl);
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
    const isLocal = wsUrl.includes('localhost') || wsUrl.includes('127.0.0.1');
    wsUrl = `${isLocal ? 'ws' : 'wss'}://${wsUrl}`;
  }
  if (!wsUrl.endsWith('/ws')) {
    wsUrl = wsUrl.replace(/\/+$/, '') + '/ws';
  }
  return wsUrl;
}

/**
 * Parses user input into a sessionId, secret, and optional serverUrl.
 * Accepts:
 * - Opaque token: "<token>"
 * - Compact deep link: "vscode://<publisher>.colive/join?c=<token>" or "?<token>"
 * - Web landing URL: "http(s)://<domain>/j/<token>" or "/j/<sessionId>#<secret>"
 * - Legacy deep link: "vscode://<publisher>.colive/join?session=<id>&secret=<secret>&server=<serverUrl>"
 * - Legacy paste codes: "<sessionId>.<secret>" or "<sessionId>.<secret>@<serverUrl>"
 */
export function parseInviteInput(input: string): ParsedInvite | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // 1. Check if direct compact base64url token
  const fromToken = decodeInviteToken(trimmed);
  if (fromToken) {
    return fromToken;
  }

  // 2. Check if paste code with server: <sessionId>.<secret>@<serverUrl>
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

  // 3. Check if simple paste code format: <sessionId>.<secret>
  const parts = trimmed.split('.');
  if (parts.length === 2 && !trimmed.includes('/') && !trimmed.includes(':') && !trimmed.includes(' ')) {
    const [sessionId, secret] = parts;
    if (sessionId && secret && /^[a-zA-Z0-9_-]+$/.test(sessionId) && /^[a-zA-Z0-9_-]+$/.test(secret)) {
      return { sessionId, secret };
    }
  }

  // 4. Check if deep link: vscode://.../join?c=... or ?session=...
  if (trimmed.startsWith('vscode://') || trimmed.startsWith('vscode-insiders://') || trimmed.startsWith('cursor://')) {
    try {
      const url = new URL(trimmed);
      // Compact token format: ?c=<token> or query without value e.g. ?<token>
      const cToken = url.searchParams.get('c') || (url.search && !url.search.includes('=') ? url.search.replace(/^\?/, '') : null);
      if (cToken) {
        const decoded = decodeInviteToken(cToken);
        if (decoded) return decoded;
      }

      // Legacy query params: ?session=...&secret=...
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

  // 5. Check web URL: http(s)://.../j/<token> or /j/<sessionId>#<secret>
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const match = url.pathname.match(/\/j\/([a-zA-Z0-9_-]+)/);
      if (match) {
        const pathParam = match[1];
        // Try decoding as compact token first
        const decoded = decodeInviteToken(pathParam);
        if (decoded) {
          // If token did not embed a serverUrl, supply web origin's ws endpoint
          if (!decoded.serverUrl) {
            decoded.serverUrl = normalizeServerWsUrl(`https://${url.host}/ws`);
          }
          return decoded;
        }
        // Legacy web link format with #secret in fragment or ?secret=...
        const sessionId = pathParam;
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
      }

      // Query param format: ?session=...&secret=...
      const sessionId = url.searchParams.get('session');
      const secret = url.hash.replace(/^#/, '') || url.searchParams.get('secret');
      if (sessionId && secret) {
        const rawServer = url.searchParams.get('server');
        const serverUrl = rawServer ? normalizeServerWsUrl(rawServer) : normalizeServerWsUrl(`https://${url.host}/ws`);
        return { sessionId, secret, serverUrl };
      }
    } catch {
      // Fall through
    }
  }

  return null;
}
