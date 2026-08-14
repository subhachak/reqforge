import * as vscode from 'vscode';
import { registry } from '@registry';
import { registerCommands } from './vscode/commands';
import { VirtualDocs } from './vscode/fs';
import { BacklogTreeProvider } from './vscode/tree';

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('ReqForge');
  const docs = new VirtualDocs();
  const tree = new BacklogTreeProvider();

  out.appendLine(`ReqForge activated — profile: ${registry.profile}`);
  out.appendLine(`  transports: ${registry.availableTransports.join(', ')}`);
  out.appendLine(`  providers:  ${registry.availableLlmProviders.join(', ')}`);

  context.subscriptions.push(
    out,
    docs,
    vscode.workspace.registerTextDocumentContentProvider(VirtualDocs.scheme, docs),
    vscode.window.registerTreeDataProvider('reqforge.backlog', tree),
    ...registerCommands({ ctx: context, out, docs, tree })
  );

  // Keep the tree honest when someone hand-edits a backlog file.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.backlog.yaml');
  watcher.onDidChange(() => tree.refresh());
  watcher.onDidCreate(() => tree.refresh());
  watcher.onDidDelete(() => tree.refresh());
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  // Nothing to tear down: no servers, no sockets, no background tasks.
}
