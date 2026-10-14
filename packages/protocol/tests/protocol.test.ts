import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  MAX_FILE_BYTES,
  MAX_MESSAGE_BYTES,
  PARTICIPANT_PALETTE,
  BINARY_FRAME_KINDS,
  encodeBinaryFrame,
  decodeBinaryFrame,
  normalizeWorkspacePath,
  isExcluded,
  sanitizeDisplayName,
  hashDocId,
  parseColiveMessage,
  safeParseColiveMessage,
  CoLiveError,
} from '../src/index.js';

describe('Protocol Constants & Limits', () => {
  it('exposes correct protocol constants', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(PARTICIPANT_PALETTE).toHaveLength(12);
  });
});

describe('Path Normalization & Traversal Security', () => {
  it('normalizes valid relative paths', () => {
    expect(normalizeWorkspacePath('src/index.ts')).toBe('src/index.ts');
    expect(normalizeWorkspacePath('src\\components\\App.tsx')).toBe('src/components/App.tsx');
    expect(normalizeWorkspacePath('./foo/bar.js')).toBe('foo/bar.js');
    expect(normalizeWorkspacePath('foo///bar//baz.txt')).toBe('foo/bar/baz.txt');
    expect(normalizeWorkspacePath('')).toBe('');
  });

  it('rejects absolute paths', () => {
    expect(() => normalizeWorkspacePath('/etc/passwd')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('\\Windows\\System32')).toThrowError(CoLiveError);
  });

  it('rejects drive letters', () => {
    expect(() => normalizeWorkspacePath('C:\\Windows')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('d:/projects/test')).toThrowError(CoLiveError);
  });

  it('rejects directory traversal attacks', () => {
    expect(() => normalizeWorkspacePath('../../etc/passwd')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('..\\windows')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('a/../../b')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('foo/../bar')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('../')).toThrowError(CoLiveError);
  });

  it('rejects percent-encoded traversal attacks', () => {
    expect(() => normalizeWorkspacePath('%2e%2e/etc/passwd')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('foo/%2e%2e/bar')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('%252e%252e/double-encoded')).toThrowError(CoLiveError);
  });

  it('rejects null byte injection', () => {
    expect(() => normalizeWorkspacePath('foo\0bar.txt')).toThrowError(CoLiveError);
    expect(() => normalizeWorkspacePath('src/%00/test.js')).toThrowError(CoLiveError);
  });

  it('sanitizes trailing dots and spaces on Windows', () => {
    expect(normalizeWorkspacePath('src/test.txt...')).toBe('src/test.txt');
    expect(normalizeWorkspacePath('src/test.txt   ')).toBe('src/test.txt');
  });
});

describe('Path Exclusion (isExcluded)', () => {
  const patterns = ['.git/**', 'node_modules/**', '.env*', '**/*.pem', '**/*.key', 'dist/**'];

  it('matches standard exclusion patterns', () => {
    expect(isExcluded('.git/config', patterns)).toBe(true);
    expect(isExcluded('node_modules/express/index.js', patterns)).toBe(true);
    expect(isExcluded('.env', patterns)).toBe(true);
    expect(isExcluded('.env.local', patterns)).toBe(true);
    expect(isExcluded('certs/server.pem', patterns)).toBe(true);
    expect(isExcluded('dist/bundle.js', patterns)).toBe(true);
  });

  it('does not exclude ordinary project files', () => {
    expect(isExcluded('src/index.ts', patterns)).toBe(false);
    expect(isExcluded('README.md', patterns)).toBe(false);
    expect(isExcluded('package.json', patterns)).toBe(false);
  });

  it('handles case-insensitive matching', () => {
    expect(isExcluded('.ENV.PRODUCTION', patterns)).toBe(true);
    expect(isExcluded('NODE_MODULES/foo/bar.js', patterns)).toBe(true);
  });
});

describe('Binary Frame Encoding and Decoding', () => {
  it('encodes and decodes doc update frames', () => {
    const docId = 'doc_a1b2c3d4';
    const payload = new Uint8Array([10, 20, 30, 40, 50]);

    const frame = encodeBinaryFrame(BINARY_FRAME_KINDS.DOC_UPDATE, docId, payload);
    expect(frame[0]).toBe(BINARY_FRAME_KINDS.DOC_UPDATE);

    const decoded = decodeBinaryFrame(frame);
    expect(decoded.kind).toBe(BINARY_FRAME_KINDS.DOC_UPDATE);
    expect(decoded.docId).toBe(docId);
    expect(Array.from(decoded.payload)).toEqual([10, 20, 30, 40, 50]);
  });

  it('encodes and decodes awareness frames with empty docId', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeBinaryFrame(BINARY_FRAME_KINDS.AWARENESS, '', payload);

    const decoded = decodeBinaryFrame(frame);
    expect(decoded.kind).toBe(BINARY_FRAME_KINDS.AWARENESS);
    expect(decoded.docId).toBe('');
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
  });

  it('rejects malformed or too short binary frames', () => {
    expect(() => decodeBinaryFrame(new Uint8Array([1, 0]))).toThrowError(CoLiveError);
    expect(() => decodeBinaryFrame(new Uint8Array([99, 0, 0]))).toThrowError(CoLiveError);
  });
});

describe('Display Name Sanitizer & DocId Hasher', () => {
  it('sanitizes control and RTL override characters', () => {
    const dirty = 'Alex\u202E\u200EReverse\x00\x1F';
    expect(sanitizeDisplayName(dirty)).toBe('AlexReverse');
  });

  it('truncates overly long names', () => {
    const longName = 'A'.repeat(50);
    expect(sanitizeDisplayName(longName)).toHaveLength(32);
  });

  it('fallbacks to Guest for empty or whitespace-only names', () => {
    expect(sanitizeDisplayName('   ')).toBe('Guest');
    expect(sanitizeDisplayName('\x00\u202A')).toBe('Guest');
  });

  it('generates stable deterministic doc IDs', () => {
    const id1 = hashDocId('src/app.ts');
    const id2 = hashDocId('src/app.ts');
    const id3 = hashDocId('src/other.ts');
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1.startsWith('doc_')).toBe(true);
  });
});

describe('Message Parsing & Zod Validation', () => {
  it('parses valid hello message', () => {
    const raw = JSON.stringify({
      v: 1,
      type: 'hello',
      clientVersion: '0.1.0',
      role: 'host',
    });
    const parsed = parseColiveMessage(raw);
    expect(parsed.type).toBe('hello');
  });

  it('parses workspace RPC requests and responses', () => {
    const listReq = JSON.stringify({
      v: 1,
      type: 'fs.list.req',
      id: 'req_123',
      path: 'src',
    });
    const parsedReq = parseColiveMessage(listReq);
    expect(parsedReq.type).toBe('fs.list.req');

    const listRes = JSON.stringify({
      v: 1,
      type: 'fs.list.res',
      id: 'req_123',
      entries: [{ name: 'index.ts', type: 'file', size: 1024, mtime: Date.now() }],
    });
    const parsedRes = parseColiveMessage(listRes);
    expect(parsedRes.type).toBe('fs.list.res');
  });

  it('parses comment operations', () => {
    const commentOp = JSON.stringify({
      v: 1,
      type: 'comment.op',
      op: 'create',
      threadId: 'thread_1',
      path: 'src/main.ts',
      range: { startLine: 1, startChar: 0, endLine: 2, endChar: 10 },
      body: 'Review this logic please.',
    });
    const parsed = parseColiveMessage(commentOp);
    expect(parsed.type).toBe('comment.op');
  });

  it('parses chat messages', () => {
    const chat = JSON.stringify({
      v: 1,
      type: 'chat.message',
      fromId: 'user_1',
      fromName: 'Sam',
      text: 'Good morning!',
      ts: Date.now(),
    });
    const parsed = parseColiveMessage(chat);
    expect(parsed.type).toBe('chat.message');
  });

  it('parses diagnostics updates', () => {
    const diag = JSON.stringify({
      v: 1,
      type: 'diagnostics.update',
      path: 'src/main.ts',
      items: [
        {
          range: { startLine: 10, startChar: 4, endLine: 10, endChar: 12 },
          severity: 0,
          message: 'Cannot find name "foo".',
          source: 'typescript',
          code: 2304,
        },
      ],
    });
    const parsed = parseColiveMessage(diag);
    expect(parsed.type).toBe('diagnostics.update');
  });

  it('safely rejects malformed messages without throwing', () => {
    const malformed = JSON.stringify({ v: 2, type: 'hello' }); // Wrong version
    const result = safeParseColiveMessage(malformed);
    expect(result.success).toBe(false);

    const invalidJson = '{ not valid json';
    const result2 = safeParseColiveMessage(invalidJson);
    expect(result2.success).toBe(false);
  });
});
