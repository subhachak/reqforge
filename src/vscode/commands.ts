import * as vscode from 'vscode';
import { registry } from '@registry';
import type { AtlassianPort, LlmPort } from '../core/ports';
import { LlmUnavailableError } from '../core/ports';
import { decomposePrd } from '../core/pipeline/decompose';
import { BacklogStore } from '../core/store';
import { adapterContext, cfg, dataFolder, ensureConfigured } from './config';
import { WorkspaceFs } from './fs';
import { BacklogPanel } from './panel';

/**
 * Two commands.
 *
 * Everything else the extension used to expose here — credentials, model
 * checks, story generation, refine, push, dry run — is in the panel, where a
 * product owner can see it. A palette entry that duplicates a button is a
 * second code path to keep working and a second thing to explain.
 *
 * `decomposePrd` stays registered because the panel starts it by id, but it is
 * hidden from the palette in package.json.
 */

export interface Deps {
  ctx: vscode.ExtensionContext;
  out: vscode.OutputChannel;
}

function store(): BacklogStore {
  return new BacklogStore(new WorkspaceFs(), dataFolder());
}

async function ports(deps: Deps): Promise<{ atlassian: AtlassianPort; llm: LlmPort }> {
  const actx = await adapterContext(deps.ctx);
  actx.onLlmRetry = (attempt, delayMs, reason) =>
    deps.out.appendLine(`Copilot request failed (${reason.slice(0, 160)}) — retrying in ${delayMs / 1000}s (attempt ${attempt})`);
  return { atlassian: registry.createAtlassian(actx), llm: registry.createLlm(actx) };
}

/** Every command funnels through here so failures are reported once, usefully. */
async function guard(deps: Deps, title: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const e = err as Error;
    deps.out.appendLine(`\n[${new Date().toISOString()}] ${title} failed`);
    deps.out.appendLine(e.stack ?? e.message);

    if (e instanceof LlmUnavailableError) {
      const choice = await vscode.window.showErrorMessage(e.message, { detail: e.hint, modal: false }, 'Show Details');
      if (choice === 'Show Details') deps.out.show(true);
      return;
    }
    const choice = await vscode.window.showErrorMessage(`${title}: ${e.message}`, 'Show Details');
    if (choice === 'Show Details') deps.out.show(true);
  }
}

export function registerCommands(deps: Deps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('reqforge.open', (slug?: string) =>
      guard(deps, 'Open ReqForge', async () => {
        await BacklogPanel.show(deps.ctx, deps.out, slug ? { slug } : { home: true });
      })
    ),

    vscode.commands.registerCommand('reqforge.decomposePrd', () =>
      guard(deps, 'Decompose PRD', () => decomposeCmd(deps))
    )
  ];
}

async function decomposeCmd(deps: Deps): Promise<void> {
  if (!(await ensureConfigured(deps.ctx))) return;

  const pageIdOrUrl = await vscode.window.showInputBox({
    title: 'ReqForge — Decompose PRD',
    prompt: 'Confluence page URL or numeric page id',
    placeHolder: 'https://acme.atlassian.net/wiki/spaces/PROD/pages/123456/My+PRD',
    ignoreFocusOut: true
  });
  if (!pageIdOrUrl) return;

  const critique =
    (
      await vscode.window.showQuickPick(
        [
          { label: 'Yes — review and revise the breakdown', description: '2 extra model calls, better output', value: true },
          { label: 'No — fastest path', description: 'single pass', value: false }
        ],
        { title: 'Run the critic pass?', ignoreFocusOut: true }
      )
    )?.value ?? true;

  const { atlassian, llm } = await ports(deps);
  const c = cfg();

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ReqForge', cancellable: true },
    async (progress, token) =>
      decomposePrd(atlassian, llm, {
        pageIdOrUrl,
        projectKey: c.get<string>('jira.projectKey', ''),
        epicIssueType: c.get<string>('jira.epicIssueType', 'Epic'),
        storyIssueType: c.get<string>('jira.storyIssueType', 'Story'),
        critique,
        progress: { report: (message) => progress.report({ message }) },
        token
      })
  );

  await store().save(result.slug, result.backlog);

  deps.out.appendLine(`\nDecomposed "${result.backlog.source.title}" → ${result.backlog.epics.length} epics`);
  if (result.critique?.findings.length) {
    deps.out.appendLine('Review findings applied:');
    result.critique.findings.forEach((f) => deps.out.appendLine(`  [${f.severity}] ${f.ref}: ${f.issue}`));
  }
  if (result.backlog.prd.openQuestions.length) {
    deps.out.appendLine('\nOpen questions found in the PRD:');
    result.backlog.prd.openQuestions.forEach((q) => deps.out.appendLine(`  - ${q}`));
  }

  // Land the user in the review panel, not in a YAML file.
  await BacklogPanel.show(deps.ctx, deps.out, { slug: result.slug });
}
