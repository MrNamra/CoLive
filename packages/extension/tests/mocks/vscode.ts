export class Disposable {
  constructor(private callOnDispose: () => void = () => {}) {}
  public dispose(): void {
    this.callOnDispose();
  }
}

export class EventEmitter<T = any> {
  private listeners: Array<(e: T) => any> = [];

  public event = (listener: (e: T) => any): Disposable => {
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

export const window = {
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
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  setStatusBarMessage: () => new Disposable(),
  withProgress: async (_opts: any, task: (progress: any, token: any) => Promise<any>) => {
    return task(
      { report: () => {} },
      { onCancellationRequested: () => new Disposable() },
    );
  },
  registerUriHandler: () => new Disposable(),
};

export const workspace = {
  workspaceFolders: [] as any[],
  getConfiguration: () => ({
    get: (key: string, defaultVal: any) => defaultVal,
  }),
  registerFileSystemProvider: () => new Disposable(),
  updateWorkspaceFolders: () => true,
  createFileSystemWatcher: () => ({
    onDidCreate: () => new Disposable(),
    onDidChange: () => new Disposable(),
    onDidDelete: () => new Disposable(),
    dispose: () => {},
  }),
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
};
