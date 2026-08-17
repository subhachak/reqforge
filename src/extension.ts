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

  // Both builds contribute the same command and view ids, so VS Code will load
  // them side by side but the second to activate loses the registration race
  // and fails with a message that explains nothing. Say what is actually wrong.
  const sibling = registry.profile === 'full' ? 'reqforge.reqforge' : 'reqforge.reqforge-studio';
  if (vscode.extensions.getExtension(sibling)) {
    void vscode.window
      .showWarningMessage(
        'Two ReqForge builds are installed. They share command ids, so only one can work at a time — disable either ReqForge or ReqForge Studio and reload.',
        'Show Extensions'
      )
      .then((choice) => {
        if (choice) void vscode.commands.executeCommand('workbench.view.extensions');
      });
  }

  // Drives `when` clauses in package.json. The restricted build must not even
  // offer to store a third-party API key: the command would do nothing, but a
  // client auditing the palette would reasonably read it as capability.
  void vscode.commands.executeCommand('setContext', 'reqforge.profile', registry.profile);

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
