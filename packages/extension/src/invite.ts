export interface ParsedInvite {
  sessionId: string;
  secret: string;
}

/**
 * Builds the deep link for joining a session.
 */
export function buildDeepLink(sessionId: string, secret: string, publisher = 'colive-team'): string {
  return `vscode://${publisher}.colive/join?session=${encodeURIComponent(sessionId)}&secret=${encodeURIComponent(secret)}`;
}

/**
 * Builds the compact paste-code format: "<sessionId>.<secret>".
 */
export function buildPasteCode(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

/**
 * Parses user input into a sessionId and secret.
 * Accepts:
 * - "<sessionId>.<secret>"
 * - "vscode://<publisher>.colive/join?session=<id>&secret=<secret>"
 * - "http(s)://.../j/<sessionId>#<secret>"
 */
export function parseInviteInput(input: string): ParsedInvite | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // 1. Check if paste code format: <sessionId>.<secret>
  const parts = trimmed.split('.');
  if (parts.length === 2 && !trimmed.includes('/') && !trimmed.includes(':') && !trimmed.includes(' ')) {
    const [sessionId, secret] = parts;
    if (sessionId && secret && /^[a-zA-Z0-9_-]+$/.test(sessionId) && /^[a-zA-Z0-9_-]+$/.test(secret)) {
      return { sessionId, secret };
    }
  }

  // 2. Check if deep link: vscode://.../join?session=...&secret=...
  if (trimmed.startsWith('vscode://') || trimmed.startsWith('vscode-insiders://') || trimmed.startsWith('cursor://')) {
    try {
      const url = new URL(trimmed);
      const sessionId = url.searchParams.get('session');
      const secret = url.searchParams.get('secret') || url.hash.replace(/^#/, '');
      if (sessionId && secret) {
        return { sessionId, secret };
      }
    } catch {
      // Fall through
    }
  }

  // 3. Check web URL: http(s)://.../j/<sessionId>#<secret>
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const match = url.pathname.match(/\/j\/([a-zA-Z0-9_-]+)/);
      const sessionId = match ? match[1] : url.searchParams.get('session');
      const secret = url.hash.replace(/^#/, '') || url.searchParams.get('secret');
      if (sessionId && secret) {
        return { sessionId, secret };
      }
    } catch {
      // Fall through
    }
  }

  return null;
}
