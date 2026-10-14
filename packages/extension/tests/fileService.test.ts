import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoLiveError, PROTOCOL_VERSION } from '@colive/protocol';
import { HostFileService } from '../src/host/fileService.js';

describe('HostFileService Sandboxing & Traversal Defense', () => {
  let tempRoot: string;
  let outsideDir: string;
  let service: HostFileService;

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colive-test-root-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colive-test-outside-'));

    // Create sample workspace files
    fs.writeFileSync(path.join(tempRoot, 'README.md'), '# Hello CoLive');
    fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'src/index.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tempRoot, '.env'), 'SECRET=12345');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'SUPER_SECRET_EXTERNAL_DATA');

    // Create a symlink pointing outside the workspace root
    try {
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(tempRoot, 'evil-symlink.txt'));
    } catch {
      // Symlink creation might require privileges on Windows, test if created
    }

    service = new HostFileService(tempRoot, ['.env*', '.git/**'], 5);
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('allows safe workspace file access', async () => {
    const listRes = await service.handleList({
      v: PROTOCOL_VERSION,
      type: 'fs.list.req',
      id: 'list_1',
      path: '',
    });

    const names = listRes.entries.map((e) => e.name);
    expect(names).toContain('README.md');
    expect(names).toContain('src');
    // Excluded files should NOT appear in listing
    expect(names).not.toContain('.env');
  });

  it('rejects direct read of excluded files with FORBIDDEN', async () => {
    await expect(
      service.handleRead({
        v: PROTOCOL_VERSION,
        type: 'fs.read.req',
        id: 'read_env',
        path: '.env',
      }),
    ).rejects.toThrowError(/excluded/);
  });

  it('rejects path traversal attempts with FORBIDDEN', async () => {
    await expect(
      service.handleRead({
        v: PROTOCOL_VERSION,
        type: 'fs.read.req',
        id: 'read_traversal',
        path: '../../etc/passwd',
      }),
    ).rejects.toThrowError(CoLiveError);
  });

  it('detects symlink escapes and rejects with FORBIDDEN', async () => {
    if (fs.existsSync(path.join(tempRoot, 'evil-symlink.txt'))) {
      await expect(
        service.handleRead({
          v: PROTOCOL_VERSION,
          type: 'fs.read.req',
          id: 'read_symlink',
          path: 'evil-symlink.txt',
        }),
      ).rejects.toThrowError(/Symlink escapes workspace root/);
    }
  });

  it('correctly detects binary vs text files', async () => {
    // Write binary file with null byte
    const binPath = path.join(tempRoot, 'test.bin');
    fs.writeFileSync(binPath, Buffer.from([0, 1, 2, 3, 4]));

    const readRes = await service.handleRead({
      v: PROTOCOL_VERSION,
      type: 'fs.read.req',
      id: 'read_bin',
      path: 'test.bin',
    });

    expect(readRes.isBinary).toBe(true);

    // Text file
    const textRes = await service.handleRead({
      v: PROTOCOL_VERSION,
      type: 'fs.read.req',
      id: 'read_text',
      path: 'README.md',
    });

    expect(textRes.isBinary).toBe(false);
    expect(Buffer.from(textRes.contentBase64, 'base64').toString('utf-8')).toBe('# Hello CoLive');
  });

  it('enforces maximum file size limit', async () => {
    // Service with 1 MB limit for this test
    const strictService = new HostFileService(tempRoot, [], 0.001); // ~1 KB limit
    await expect(
      strictService.handleRead({
        v: PROTOCOL_VERSION,
        type: 'fs.read.req',
        id: 'read_big',
        path: 'README.md',
      }),
    ).resolves.toBeDefined(); // ~14 bytes is fine

    const bigFile = path.join(tempRoot, 'big.txt');
    fs.writeFileSync(bigFile, Buffer.alloc(2000)); // 2 KB exceeds 1 KB limit
    await expect(
      strictService.handleRead({
        v: PROTOCOL_VERSION,
        type: 'fs.read.req',
        id: 'read_oversize',
        path: 'big.txt',
      }),
    ).rejects.toThrowError(/exceeds limit/);
  });
});
