import * as vscode from 'vscode';
import { registry } from '@registry';
import { registerCommands } from './vscode/commands';
import { BacklogPanel } from './vscode/panel';

/**
 * The activity-bar view exists only so there is somewhere to click. It never
 * has children, which is what makes VS Code show its welcome content, and
 * opening it opens the panel — the panel is the product, and a tree beside it
 * would be a second place showing the same thing with its own copy of the
 * status logic to keep correct.
 */
class StartView implements vscode.TreeDataProvider<never> {
  getChildren(): never[] {
    return [];
  }
  getTreeItem(): vscode.TreeItem {
    throw new Error('unreachable: this view has no items');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('ReqForge');

  out.appendLine(`ReqForge activated — profile: ${registry.profile}`);
  out.appendLine(`  transports: ${registry.availableTransports.join(', ')}`);
  out.appendLine(`  providers:  ${registry.availableLlmProviders.join(', ')}`);

  const view = vscode.window.createTreeView('reqforge.start', { treeDataProvider: new StartView() });

  // Clicking the activity-bar icon opens the panel rather than showing an
  // empty view the user then has to act on again.
  view.onDidChangeVisibility(async (e) => {
    if (e.visible) {
      await BacklogPanel.show(context, out, { home: true });
    }
  });

  context.subscriptions.push(out, view, ...registerCommands({ ctx: context, out }));
}

export function deactivate(): void {
  // Nothing to tear down: no servers, no sockets, no background tasks.
}
