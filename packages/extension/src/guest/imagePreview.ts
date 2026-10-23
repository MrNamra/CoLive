import * as vscode from 'vscode';
import path from 'node:path';
import { isImageFile } from '@colive/protocol';
import { CoLiveFileSystemProvider } from './coliveFileSystem.js';

interface ImageCustomDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

/**
 * CustomReadonlyEditorProvider for rendering image previews in guest tabs.
 */
export class CoLiveImageEditorProvider implements vscode.CustomReadonlyEditorProvider<ImageCustomDocument> {
  public static readonly viewType = 'colive.imagePreview';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fsProvider: CoLiveFileSystemProvider,
  ) {}

  public async openCustomDocument(uri: vscode.Uri): Promise<ImageCustomDocument> {
    return {
      uri,
      dispose: () => {},
    };
  }

  public async resolveCustomEditor(
    document: ImageCustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    const fileName = path.basename(document.uri.path);
    webviewPanel.title = `Preview: ${fileName}`;

    let bytes: Uint8Array;
    try {
      bytes = await this.fsProvider.readFile(document.uri);
    } catch (err) {
      webviewPanel.webview.html = this.renderErrorHtml(
        `Failed to load image: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const mime = this.getMimeType(fileName);
    const base64 = Buffer.from(bytes).toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;
    const fileSizeKb = (bytes.byteLength / 1024).toFixed(1);

    webviewPanel.webview.html = this.renderImageHtml(fileName, dataUrl, fileSizeKb, mime);
  }

  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    switch (ext) {
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.gif':
        return 'image/gif';
      case '.svg':
        return 'image/svg+xml';
      case '.webp':
        return 'image/webp';
      case '.bmp':
        return 'image/bmp';
      case '.ico':
        return 'image/x-icon';
      case '.avif':
        return 'image/avif';
      default:
        return 'image/png';
    }
  }

  private renderErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      font-family: var(--vscode-font-family, sans-serif);
      color: var(--vscode-errorForeground, #f48771);
      background-color: var(--vscode-editor-background, #1e1e1e);
    }
  </style>
</head>
<body>
  <div>${message}</div>
</body>
</html>`;
  }

  private renderImageHtml(fileName: string, dataUrl: string, fileSizeKb: string, mime: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --bar-bg: var(--vscode-editorWidget-background, #252526);
      --border: var(--vscode-editorWidget-border, #454545);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, sans-serif);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      user-select: none;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 14px;
      background: var(--bar-bg);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      gap: 12px;
      z-index: 10;
    }
    .file-info {
      display: flex;
      gap: 12px;
      font-weight: 500;
      opacity: 0.9;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 4px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }
    button:hover {
      opacity: 0.9;
    }
    .viewport {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: auto;
      background-image: linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
                        linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
                        linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
                        linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
      position: relative;
    }
    img {
      max-width: 90%;
      max-height: 90%;
      object-fit: contain;
      transition: transform 0.15s ease-out;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      background: transparent;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="file-info">
      <span><strong>${fileName}</strong></span>
      <span>${fileSizeKb} KB</span>
      <span>${mime}</span>
      <span id="dimensions">Loading...</span>
    </div>
    <div class="controls">
      <button onclick="zoomOut()">-</button>
      <span id="zoomLevel">100%</span>
      <button onclick="zoomIn()">+</button>
      <button onclick="resetZoom()">Reset</button>
    </div>
  </div>
  <div class="viewport">
    <img id="image" src="${dataUrl}" alt="${fileName}" />
  </div>

  <script>
    let scale = 1;
    const img = document.getElementById('image');
    const zoomText = document.getElementById('zoomLevel');
    const dimText = document.getElementById('dimensions');

    img.onload = () => {
      dimText.textContent = img.naturalWidth + ' x ' + img.naturalHeight + ' px';
    };

    function updateZoom() {
      img.style.transform = 'scale(' + scale + ')';
      zoomText.textContent = Math.round(scale * 100) + '%';
    }

    function zoomIn() {
      scale = Math.min(scale * 1.25, 10);
      updateZoom();
    }

    function zoomOut() {
      scale = Math.max(scale / 1.25, 0.1);
      updateZoom();
    }

    function resetZoom() {
      scale = 1;
      updateZoom();
    }

    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
      }
    }, { passive: false });
  </script>
</body>
</html>`;
  }
}
