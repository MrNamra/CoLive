import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isImageFile,
  PROTOCOL_VERSION,
  FsReadChunkReq,
} from '@colive/protocol';
import { HostFileService } from '../src/host/fileService.js';
import { CoLiveFileSystemProvider } from '../src/guest/coliveFileSystem.js';
import { CoLiveImageEditorProvider } from '../src/guest/imagePreview.js';
import { ConnectionManager } from '../src/connection.js';

describe('Phase 2: Binary Asset & Image Previews', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colive-image-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('isImageFile utility', () => {
    it('accurately identifies common image extensions and rejects non-images', () => {
      expect(isImageFile('logo.png')).toBe(true);
      expect(isImageFile('photo.jpg')).toBe(true);
      expect(isImageFile('icon.SVG')).toBe(true);
      expect(isImageFile('banner.webp')).toBe(true);
      expect(isImageFile('favicon.ico')).toBe(true);

      expect(isImageFile('code.ts')).toBe(false);
      expect(isImageFile('data.json')).toBe(false);
      expect(isImageFile('binary.exe')).toBe(false);
      expect(isImageFile('')).toBe(false);
    });
  });

  describe('HostFileService Chunked & Image Reading', () => {
    it('reads binary image assets in chunks via handleReadChunk', async () => {
      const imgPath = path.join(tempDir, 'sample.png');
      const fakePngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(500).fill(1)]);
      fs.writeFileSync(imgPath, fakePngBytes);

      const service = new HostFileService(tempDir);

      const chunkReq: FsReadChunkReq = {
        v: PROTOCOL_VERSION,
        type: 'fs.readChunk.req',
        id: 'chunk_test_1',
        path: 'sample.png',
        offset: 0,
        length: 200,
      };

      const res1 = await service.handleReadChunk(chunkReq);
      expect(res1.type).toBe('fs.readChunk.res');
      expect(res1.bytesRead).toBe(200);
      expect(res1.offset).toBe(0);
      expect(res1.totalSize).toBe(fakePngBytes.length);
      expect(res1.eof).toBe(false);

      // Read remainder
      const chunkReq2: FsReadChunkReq = {
        v: PROTOCOL_VERSION,
        type: 'fs.readChunk.req',
        id: 'chunk_test_2',
        path: 'sample.png',
        offset: 200,
        length: 500,
      };

      const res2 = await service.handleReadChunk(chunkReq2);
      expect(res2.bytesRead).toBe(fakePngBytes.length - 200);
      expect(res2.offset).toBe(200);
      expect(res2.eof).toBe(true);

      service.dispose();
    });

    it('permits images larger than 5 MB up to MAX_ASSET_BYTES (10 MB)', async () => {
      const largeImgPath = path.join(tempDir, 'large.png');
      // Create a 6 MB file
      const size6MB = 6 * 1024 * 1024;
      const fd = fs.openSync(largeImgPath, 'w');
      fs.writeSync(fd, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
      fs.ftruncateSync(fd, size6MB);
      fs.closeSync(fd);

      // Service with 5 MB default text limit
      const service = new HostFileService(tempDir, [], 5);

      const readRes = await service.handleRead({
        v: PROTOCOL_VERSION,
        type: 'fs.read.req',
        id: 'read_large_1',
        path: 'large.png',
      });

      expect(readRes.type).toBe('fs.read.res');
      expect(readRes.isBinary).toBe(true);

      service.dispose();
    });
  });

  describe('Guest Virtual File System & Image Preview Provider', () => {
    it('returns actual image binary buffer instead of placeholder for image files', async () => {
      const mockConn = {
        on: () => ({ dispose: () => {} }),
        request: async () => ({
          v: PROTOCOL_VERSION,
          type: 'fs.read.res',
          id: 'read_1',
          contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          mtime: Date.now(),
          isBinary: true,
        }),
      } as unknown as ConnectionManager;

      const fsProvider = new CoLiveFileSystemProvider(mockConn);
      const uri = vscode.Uri.parse('colive:/workspace/icon.png');
      const bytes = await fsProvider.readFile(uri);

      // Verify it did not return Strings.binaryFilePlaceholder
      expect(bytes.length).toBe(4);
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50);
    });

    it('renders custom editor image preview with zoom controls and safe CSP', async () => {
      const mockConn = {
        on: () => ({ dispose: () => {} }),
        request: async () => ({
          v: PROTOCOL_VERSION,
          type: 'fs.read.res',
          id: 'read_1',
          contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          mtime: Date.now(),
          isBinary: true,
        }),
      } as unknown as ConnectionManager;

      const fsProvider = new CoLiveFileSystemProvider(mockConn);
      const mockContext = { extensionUri: vscode.Uri.file('/ext') } as any;
      const editorProvider = new CoLiveImageEditorProvider(mockContext, fsProvider);

      const testUri = vscode.Uri.parse('colive:/workspace/photo.png');
      const doc = await editorProvider.openCustomDocument(testUri);

      let renderedHtml = '';
      const mockWebviewPanel = {
        title: '',
        webview: {
          options: {},
          set html(val: string) {
            renderedHtml = val;
          },
          get html() {
            return renderedHtml;
          },
        },
      } as any;

      await editorProvider.resolveCustomEditor(doc, mockWebviewPanel);

      expect(mockWebviewPanel.title).toContain('photo.png');
      expect(renderedHtml).toContain('Content-Security-Policy');
      expect(renderedHtml).toContain('image/png');
      expect(renderedHtml).toContain('zoomIn()');
      expect(renderedHtml).toContain('zoomOut()');
      expect(renderedHtml).toContain('resetZoom()');
    });
  });
});
