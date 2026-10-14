export class Disposable {
  constructor(private callOnDispose: () => void = () => {}) {}
  public dispose(): void {
    this.callOnDispose();
  }
}

export class EventEmitter<T = unknown> {
  private listeners: Array<(e: T) => void> = [];

  public event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    });
  };

  public fire(data: T): void {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  public dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  public scheme: string;
  public authority: string;
  public path: string;
  public query: string;
  public fragment: string;
  public fsPath: string;

  private constructor(scheme: string, authority: string, path: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
    this.fsPath = path;
  }

  public static parse(value: string): Uri {
    try {
      const url = new URL(value);
      return new Uri(url.protocol.replace(':', ''), url.host, url.pathname, url.search.replace(/^\?/, ''), url.hash.replace(/^#/, ''));
    } catch {
      return new Uri('colive', '', value);
    }
  }

  public static file(fsPath: string): Uri {
    return new Uri('file', '', fsPath);
  }

  public static from(components: { scheme: string; path: string; query?: string; fragment?: string }): Uri {
    return new Uri(components.scheme, '', components.path, components.query || '', components.fragment || '');
  }

  public toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FilePermission {
  Readonly = 1,
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}

export class FileSystemError extends Error {
  public code: string;
  constructor(message?: string, code = 'FileSystemError') {
    super(message);
    this.name = 'FileSystemError';
    this.code = code;
  }

  public static FileNotFound(uri?: Uri): FileSystemError {
    return new FileSystemError(`File not found: ${uri?.toString()}`, 'FileNotFound');
  }

  public static NoPermissions(message?: string): FileSystemError {
    return new FileSystemError(`No permissions: ${message}`, 'NoPermissions');
  }

  public static Unavailable(message?: string): FileSystemError {
    return new FileSystemError(`Unavailable: ${message}`, 'Unavailable');
  }
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export interface TextEditorDecorationType extends Disposable {
  key: string;
}

export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  public label?: string;
  public collapsibleState?: TreeItemCollapsibleState;
  public iconPath?: ThemeIcon | Uri | string;
  public description?: string;
  public tooltip?: string;
  public contextValue?: string;

  constructor(label: string, collapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}

  public isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  public isAfter(other: Position): boolean {
    return this.line > other.line || (this.line === other.line && this.character > other.character);
  }

  public isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(arg1: Position | number, arg2: Position | number, arg3?: number, arg4?: number) {
    if (typeof arg1 === 'number') {
      this.start = new Position(arg1, arg2 as number);
      this.end = new Position(arg3 as number, arg4 as number);
    } else {
      this.start = arg1;
      this.end = arg2 as Position;
    }
  }

  public get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
}

export class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;

  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

export class TextEdit {
  constructor(public range: Range, public newText: string) {}

  public static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  public static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }

  public static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }
}

export class WorkspaceEdit {
  private _edits: Map<string, TextEdit[]> = new Map();

  public set(uri: Uri, edits: TextEdit[]): void {
    this._edits.set(uri.toString(), edits);
  }

  public get(uri: Uri): TextEdit[] | undefined {
    return this._edits.get(uri.toString());
  }

  public entries(): [Uri, TextEdit[]][] {
    const list: [Uri, TextEdit[]][] = [];
    for (const [uriStr, edits] of this._edits.entries()) {
      list.push([Uri.parse(uriStr), edits]);
    }
    return list;
  }
}

export interface TextLine {
  lineNumber: number;
  text: string;
  range: Range;
  rangeIncludingLineBreak: Range;
  firstNonWhitespaceCharacterIndex: number;
  isEmptyOrWhitespace: boolean;
}

export class MockTextDocument {
  public uri: Uri;
  public version = 1;
  public lineCount = 1;
  private _content: string;

  constructor(uri: Uri, content: string) {
    this.uri = uri;
    this._content = content;
    this.recalcLines();
  }

  public getText(range?: Range): string {
    if (!range) return this._content;
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    return this._content.substring(start, end);
  }

  public positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this._content.length));
    const prefix = this._content.substring(0, clamped);
    const lines = prefix.split('\n');
    const line = lines.length - 1;
    const character = lines[line].length;
    return new Position(line, character);
  }

  public offsetAt(position: Position): number {
    const lines = this._content.split('\n');
    let offset = 0;
    for (let i = 0; i < Math.min(position.line, lines.length); i++) {
      offset += lines[i].length + 1; // +1 for '\n'
    }
    if (position.line < lines.length) {
      offset += Math.min(position.character, lines[position.line].length);
    }
    return Math.min(offset, this._content.length);
  }

  public lineAt(line: number): TextLine {
    const lines = this._content.split('\n');
    const text = lines[line] || '';
    const start = new Position(line, 0);
    const end = new Position(line, text.length);
    return {
      lineNumber: line,
      text,
      range: new Range(start, end),
      rangeIncludingLineBreak: new Range(start, new Position(line, text.length + 1)),
      firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
      isEmptyOrWhitespace: text.trim().length === 0,
    };
  }

  public applyEdits(edits: TextEdit[]): void {
    // Sort descending by start offset
    const sorted = [...edits].sort((a, b) => this.offsetAt(b.range.start) - this.offsetAt(a.range.start));
    let text = this._content;
    for (const edit of sorted) {
      const start = this.offsetAt(edit.range.start);
      const end = this.offsetAt(edit.range.end);
      text = text.slice(0, start) + edit.newText + text.slice(end);
    }
    this._content = text;
    this.version++;
    this.recalcLines();
  }

  public setContent(newContent: string): void {
    this._content = newContent;
    this.recalcLines();
  }

  public async save(): Promise<boolean> {
    return true;
  }

  private recalcLines(): void {
    this.lineCount = this._content.split('\n').length;
  }
}

// Active document registry for tests
export const mockDocuments: Map<string, MockTextDocument> = new Map();

export const onDidChangeTextDocumentEmitter = new EventEmitter<unknown>();
export const onDidOpenTextDocumentEmitter = new EventEmitter<unknown>();
export const onDidCloseTextDocumentEmitter = new EventEmitter<unknown>();
export const onDidChangeActiveTextEditorEmitter = new EventEmitter<unknown>();
export const onDidChangeTextEditorSelectionEmitter = new EventEmitter<unknown>();
export const onDidChangeTextEditorVisibleRangesEmitter = new EventEmitter<unknown>();
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export const window = {
  activeTextEditor: undefined as unknown as { document: MockTextDocument } | undefined,
  visibleTextEditors: [] as Array<unknown>,
  createTextEditorDecorationType: (_options: unknown): TextEditorDecorationType => ({
    key: `decoration_${Math.random().toString(36).slice(2)}`,
    dispose: () => {},
  }),
  createOutputChannel: (name: string) => ({
    name,
    appendLine: (_val: string) => {},
    show: () => {},
    dispose: () => {},
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  createTreeView: () => ({
    dispose: () => {},
  }),
  createTerminal: (options: any) => ({
    name: typeof options === 'string' ? options : options.name,
    pty: typeof options === 'object' ? options.pty : undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
    sendText: (_text: string) => {},
  }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  setStatusBarMessage: () => new Disposable(),
  withProgress: async <R>(
    _opts: unknown,
    task: (progress: { report: (val: unknown) => void }, token: { onCancellationRequested: () => Disposable }) => Promise<R>,
  ): Promise<R> => {
    return task(
      { report: () => {} },
      { onCancellationRequested: () => new Disposable() },
    );
  },
  registerUriHandler: () => new Disposable(),
  onDidChangeActiveTextEditor: onDidChangeActiveTextEditorEmitter.event,
  onDidChangeTextEditorSelection: onDidChangeTextEditorSelectionEmitter.event,
  onDidChangeTextEditorVisibleRanges: onDidChangeTextEditorVisibleRangesEmitter.event,
  showTextDocument: async (docOrUri: unknown, _opts?: unknown): Promise<unknown> => {
    return {
      document: docOrUri,
      revealRange: () => {},
      setDecorations: () => {},
    };
  },
};

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string }>,
  getConfiguration: () => ({
    get: <T>(key: string, defaultVal: T): T => defaultVal,
  }),
  registerFileSystemProvider: () => new Disposable(),
  updateWorkspaceFolders: () => true,
  createFileSystemWatcher: () => ({
    onDidCreate: () => new Disposable(),
    onDidChange: () => new Disposable(),
    onDidDelete: () => new Disposable(),
    dispose: () => {},
  }),
  onDidChangeTextDocument: onDidChangeTextDocumentEmitter.event,
  onDidOpenTextDocument: onDidOpenTextDocumentEmitter.event,
  onDidCloseTextDocument: onDidCloseTextDocumentEmitter.event,
  applyEdit: async (edit: WorkspaceEdit): Promise<boolean> => {
    for (const [uri, textEdits] of edit.entries()) {
      const doc = mockDocuments.get(uri.toString());
      if (doc) {
        doc.applyEdits(textEdits);
      }
    }
    return true;
  },
  openTextDocument: async (uri: Uri): Promise<MockTextDocument> => {
    let doc = mockDocuments.get(uri.toString());
    if (!doc) {
      doc = new MockTextDocument(uri, '');
      mockDocuments.set(uri.toString(), doc);
    }
    return doc;
  },
};

export class MarkdownString {
  public value: string;
  public isTrusted: boolean;

  constructor(value = '', isTrusted = false) {
    this.value = value;
    this.isTrusted = isTrusted;
  }

  public appendMarkdown(val: string): MarkdownString {
    this.value += val;
    return this;
  }
}

export enum CommentMode {
  Preview = 0,
  Editing = 1,
}

export enum CommentThreadCollapsibleState {
  Collapsed = 0,
  Expanded = 1,
}

export interface MockComment {
  author: { name: string; iconPath?: Uri };
  body: MarkdownString | string;
  mode?: CommentMode;
  contextValue?: string;
}

export class MockCommentThread {
  public uri: Uri;
  public range: Range;
  public comments: MockComment[];
  public collapsibleState: CommentThreadCollapsibleState = CommentThreadCollapsibleState.Expanded;
  public canReply = true;
  public label?: string;
  public contextValue?: string;
  public isDisposed = false;

  constructor(uri: Uri, range: Range, comments: MockComment[] = []) {
    this.uri = uri;
    this.range = range;
    this.comments = comments;
  }

  public dispose(): void {
    this.isDisposed = true;
  }
}

export class MockCommentController {
  public id: string;
  public label: string;
  public commentingRangeProvider?: unknown;
  public threads: MockCommentThread[] = [];

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  public createCommentThread(uri: Uri, range: Range, comments: MockComment[] = []): MockCommentThread {
    const thread = new MockCommentThread(uri, range, comments);
    this.threads.push(thread);
    return thread;
  }

  public dispose(): void {
    for (const t of this.threads) {
      t.dispose();
    }
    this.threads = [];
  }
}

export const comments = {
  createCommentController: (id: string, label: string): MockCommentController => {
    return new MockCommentController(id, label);
  },
};

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  public range: Range;
  public message: string;
  public severity: DiagnosticSeverity;
  public source?: string;
  public code?: string | number;

  constructor(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

export class MockDiagnosticCollection {
  public name: string;
  private entriesMap: Map<string, Diagnostic[]> = new Map();

  constructor(name: string) {
    this.name = name;
  }

  public set(uri: Uri, diagnostics: Diagnostic[] | undefined): void {
    if (!diagnostics || diagnostics.length === 0) {
      this.entriesMap.delete(uri.toString());
    } else {
      this.entriesMap.set(uri.toString(), diagnostics);
    }
  }

  public get(uri: Uri): Diagnostic[] | undefined {
    return this.entriesMap.get(uri.toString());
  }

  public clear(): void {
    this.entriesMap.clear();
  }

  public dispose(): void {
    this.entriesMap.clear();
  }
}

export const onDidChangeDiagnosticsEmitter = new EventEmitter<unknown>();

export const languages = {
  createDiagnosticCollection: (name: string): MockDiagnosticCollection => {
    return new MockDiagnosticCollection(name);
  },
  getDiagnostics: (_uri?: Uri): Diagnostic[] => [],
  onDidChangeDiagnostics: onDidChangeDiagnosticsEmitter.event,
};

export const commands = {
  registerCommand: () => new Disposable(),
  executeCommand: async () => undefined,
};

export const env = {
  clipboard: {
    writeText: async () => {},
    readText: async () => '',
  },
  openExternal: async () => true,
};
