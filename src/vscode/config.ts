import * as vscode from 'vscode';
import type { AdapterContext, LlmProvider, Transport } from '../registryTypes';

const TOKEN_KEY = 'reqforge.atlassian.apiToken';

export function cfg() {
  return vscode.workspace.getConfiguration('reqforge');
}

export async function getApiToken(ctx: vscode.ExtensionContext): Promise<string> {
  return (await ctx.secrets.get(TOKEN_KEY)) ?? '';
}

export async function setApiToken(ctx: vscode.ExtensionContext, token: string): Promise<void> {
  await ctx.secrets.store(TOKEN_KEY, token);
}

export async function clearApiToken(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(TOKEN_KEY);
}

export async function adapterContext(ctx: vscode.ExtensionContext): Promise<AdapterContext> {
  const c = cfg();
  return {
    transport: c.get<Transport>('atlassian.transport', 'rest'),
    baseUrl: c.get<string>('atlassian.baseUrl', '').trim(),
    email: c.get<string>('atlassian.email', '').trim(),
    apiToken: await getApiToken(ctx),
    llmProvider: c.get<LlmProvider>('llm.provider', 'copilot'),
    modelFamily: c.get<string>('llm.modelFamily', '').trim()
  };
}

export function workspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('ReqForge needs an open workspace folder to store backlog files.');
  }
  return folder;
}

export function dataFolder(): string {
  // If no workspace is open, use absolute storage folder with a subfolder
  if (!hasWorkspace()) {
    const storageFolder = cfg().get<string>('storageFolder', '').trim();
    if (storageFolder) {
      return '.reqforge'; // Still use relative path within the storage folder
    }
  }
  return cfg().get<string>('workspaceFolder', '.reqforge');
}

/**
 * Prompts for whatever configuration is missing rather than failing with a
 * "not configured" error. First-run friction is where demos die.
 */
export async function ensureConfigured(ctx: vscode.ExtensionContext): Promise<boolean> {
  const c = cfg();

  // Check if we need a storage folder (no workspace open and no storage folder configured)
  if (!hasWorkspace() && !c.get<string>('storageFolder', '').trim()) {
    const msg = 'ReqForge needs a folder to store backlog files. Would you like to select one?';
    const choice = await vscode.window.showInformationMessage(msg, { modal: true }, 'Select Folder', 'Open Workspace First');

    if (choice === 'Open Workspace First') {
      await vscode.commands.executeCommand('vscode.openFolder');
      return false;
    }

    if (choice === 'Select Folder') {
      const ok = await promptForStorageFolder();
      if (!ok) return false;
    } else {
      return false;
    }
  }

  if (!c.get<string>('atlassian.baseUrl', '').trim()) {
    const value = await vscode.window.showInputBox({
      title: 'ReqForge — Atlassian site',
      prompt: 'Your Atlassian Cloud base URL',
      placeHolder: 'https://acme.atlassian.net',
      ignoreFocusOut: true,
      validateInput: (v) => (/^https:\/\/[^/]+/.test(v.trim()) ? undefined : 'Must be an https URL')
    });
    if (!value) return false;
    await c.update('atlassian.baseUrl', value.trim().replace(/\/+$/, ''), vscode.ConfigurationTarget.Global);
  }

  if (!c.get<string>('atlassian.email', '').trim()) {
    const value = await vscode.window.showInputBox({
      title: 'ReqForge — Atlassian account email',
      prompt: 'The email address of the Atlassian account whose API token you will use',
      ignoreFocusOut: true,
      validateInput: (v) => (v.includes('@') ? undefined : 'Must be an email address')
    });
    if (!value) return false;
    await c.update('atlassian.email', value.trim(), vscode.ConfigurationTarget.Global);
  }

  if (!(await getApiToken(ctx))) {
    const ok = await promptForToken(ctx);
    if (!ok) return false;
  }

  if (!c.get<string>('jira.projectKey', '').trim()) {
    const value = await vscode.window.showInputBox({
      title: 'ReqForge — Jira project',
      prompt: 'Target Jira project key',
      placeHolder: 'ACME',
      ignoreFocusOut: true,
      validateInput: (v) => (/^[A-Z][A-Z0-9_]+$/.test(v.trim().toUpperCase()) ? undefined : 'Looks like an invalid key')
    });
    if (!value) return false;
    await c.update('jira.projectKey', value.trim().toUpperCase(), vscode.ConfigurationTarget.Workspace);
  }

  return true;
}

export function hasWorkspace(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

/**
 * Prompts the user to select a folder for storing backlog files when no workspace is open.
 */
export async function promptForStorageFolder(): Promise<boolean> {
  const uris = await vscode.window.showOpenDialog({
    title: 'ReqForge — Select Storage Folder',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select Folder'
  });

  if (!uris || uris.length === 0) return false;

  await cfg().update('storageFolder', uris[0].fsPath, vscode.ConfigurationTarget.Global);
  return true;
}

/**
 * Writes a setting, preferring workspace scope for anything project-specific
 * so two projects in two folders do not fight over one value. Falls back to
 * global when there is no workspace to write to.
 */
export async function updateSetting(key: string, value: unknown, scope: 'global' | 'workspace'): Promise<void> {
  const target =
    scope === 'workspace' && hasWorkspace() ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  try {
    await cfg().update(key, value, target);
  } catch {
    await cfg().update(key, value, vscode.ConfigurationTarget.Global);
  }
}

export async function promptForToken(ctx: vscode.ExtensionContext): Promise<boolean> {
  const token = await vscode.window.showInputBox({
    title: 'ReqForge — Atlassian API token',
    prompt: 'Create one at id.atlassian.com → Security → API tokens. Stored in the OS keychain, never in settings.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length > 10 ? undefined : 'That does not look like an API token')
  });
  if (!token) return false;
  await setApiToken(ctx, token.trim());
  return true;
}
