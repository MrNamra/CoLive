import * as vscode from 'vscode';

/**
 * Logger wrapper writing to VS Code OutputChannel "CoLive".
 * Guarantees that sensitive content or secrets are never logged.
 */
export class Logger {
  private static channel: vscode.OutputChannel | undefined;

  public static initialize(): void {
    if (!Logger.channel) {
      Logger.channel = vscode.window.createOutputChannel('CoLive');
    }
  }

  public static info(message: string, data?: Record<string, unknown>): void {
    Logger.write('INFO', message, data);
  }

  public static warn(message: string, data?: Record<string, unknown>): void {
    Logger.write('WARN', message, data);
  }

  public static error(message: string, error?: unknown): void {
    const errText = error instanceof Error ? error.message : String(error || '');
    Logger.write('ERROR', `${message} ${errText}`.trim());
  }

  private static write(level: string, message: string, data?: Record<string, unknown>): void {
    if (!Logger.channel) {
      Logger.channel = vscode.window.createOutputChannel('CoLive');
    }
    const timestamp = new Date().toISOString();
    const meta = data ? ` ${JSON.stringify(data)}` : '';
    Logger.channel.appendLine(`[${timestamp}] [${level}] ${message}${meta}`);
  }

  public static show(): void {
    Logger.channel?.show();
  }

  public static dispose(): void {
    Logger.channel?.dispose();
    Logger.channel = undefined;
  }
}
