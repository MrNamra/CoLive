import * as vscode from 'vscode';
import { Logger } from './logger.js';
import { Strings } from './strings.js';

export function activate(context: vscode.ExtensionContext): void {
  Logger.initialize();
  Logger.info('CoLive extension activating...');

  const helloCommand = vscode.commands.registerCommand('colive.hello', () => {
    vscode.window.showInformationMessage(Strings.helloMessage);
  });
  context.subscriptions.push(helloCommand);

  // Register participants tree view placeholder
  const participantsProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
    getTreeItem: (element: vscode.TreeItem) => element,
    getChildren: () => Promise.resolve([]),
  };
  const treeView = vscode.window.createTreeView('colive.participants', {
    treeDataProvider: participantsProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  Logger.info('CoLive extension activated successfully.');
}

export function deactivate(): void {
  Logger.info('CoLive extension deactivating...');
  Logger.dispose();
}
