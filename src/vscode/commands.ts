import * as vscode from 'vscode';
import { registry } from '@registry';
import type { AtlassianPort, LlmPort } from '../core/ports';
import { LlmUnavailableError } from '../core/ports';
import { decomposeEpics, decomposePrd } from '../core/pipeline/decompose';
import { executePush, planPush, renderPlan } from '../core/pipeline/push';
import { refineIssue } from '../core/pipeline/refine';
import { BacklogStore, backlogPath } from '../core/store';
import type { Backlog } from '../core/model';
import { adapterContext, cfg, clearApiToken, dataFolder, ensureConfigured, promptForToken } from './config';
import { VirtualDocs, WorkspaceFs } from './fs';
import { BacklogPanel } from './panel';
import type { BacklogTreeProvider } from './tree';

export interface Deps {
  ctx: vscode.ExtensionContext;
  out: vscode.OutputChannel;
  docs: VirtualDocs;
  tree: BacklogTreeProvider;
}

function store(): BacklogStore {
  return new BacklogStore(new WorkspaceFs(), dataFolder());
}

async function ports(deps: Deps): Promise<{ atlassian: AtlassianPort; llm: LlmPort }> {
  const actx = await adapterContext(deps.ctx);
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

/* ------------------------------------------------------------------ setup */

export function registerCommands(deps: Deps): vscode.Disposable[] {
  return [
    // The product owner entry point. Everything else is a power-user shortcut.
    vscode.commands.registerCommand('reqforge.open', (slug?: string) =>
      guard(deps, 'Open ReqForge', async () => {
        await BacklogPanel.show(deps.ctx, deps.out, () => deps.tree.refresh(), slug);
      })
    ),

    vscode.commands.registerCommand('reqforge.setCredentials', () =>
      guard(deps, 'Set credentials', async () => {
        if (await promptForToken(deps.ctx)) {
          vscode.window.showInformationMessage('ReqForge: API token saved to the OS keychain.');
        }
      })
    ),

    vscode.commands.registerCommand('reqforge.clearCredentials', () =>
      guard(deps, 'Clear credentials', async () => {
        await clearApiToken(deps.ctx);
        vscode.window.showInformationMessage('ReqForge: API token removed.');
      })
    ),

    vscode.commands.registerCommand('reqforge.checkModel', () => guard(deps, 'Check model', () => checkModel(deps))),
    vscode.commands.registerCommand('reqforge.decomposePrd', () => guard(deps, 'Decompose PRD', () => decomposeCmd(deps))),
    vscode.commands.registerCommand('reqforge.decomposeEpic', () => guard(deps, 'Decompose epic', () => storiesCmd(deps))),
    vscode.commands.registerCommand('reqforge.refineIssue', () => guard(deps, 'Refine issue', () => refineCmd(deps))),
    vscode.commands.registerCommand('reqforge.pushDryRun', () => guard(deps, 'Preview push', () => pushCmd(deps, true))),
    vscode.commands.registerCommand('reqforge.push', () => guard(deps, 'Push to Jira', () => pushCmd(deps, false))),
    vscode.commands.registerCommand('reqforge.refresh', async () => deps.tree.refresh()),

    vscode.commands.registerCommand('reqforge.openItem', async (arg: { type: 'url' | 'file'; url?: string; slug?: string }) => {
      if (arg?.type === 'url' && arg.url) {
        await vscode.env.openExternal(vscode.Uri.parse(arg.url));
      } else if (arg?.type === 'file' && arg.slug) {
        const uri = vscode.Uri.joinPath(
          vscode.workspace.workspaceFolders![0].uri,
          ...backlogPath(dataFolder(), arg.slug).split('/')
        );
        await vscode.window.showTextDocument(uri);
      }
    })
  ];
}

/* -------------------------------------------------------------- pre-flight */

/**
 * The command to run before a demo. Checks both backends and reports what it
 * found, rather than letting the first real command discover the problem.
 */
async function checkModel(deps: Deps): Promise<void> {
  const actx = await adapterContext(deps.ctx);
  const llm = registry.createLlm(actx);
  const llmProbe = await llm.probe();

  let atlassianDetail = 'not configured';
  if (actx.baseUrl && actx.email && actx.apiToken) {
    const probe = await registry.createAtlassian(actx).verifyConnection();
    atlassianDetail = `${probe.ok ? 'OK' : 'FAILED'} — ${probe.detail}`;
  }

  const lines = [
    `Profile:    ${registry.profile}`,
    `Transports: ${registry.availableTransports.join(', ')}`,
    `Providers:  ${registry.availableLlmProviders.join(', ')}`,
    '',
    `Model:      ${llmProbe.ok ? 'OK' : 'FAILED'} — ${llmProbe.detail}`,
    `Atlassian:  ${atlassianDetail}`
  ];
  deps.out.appendLine(`\n=== ReqForge pre-flight ${new Date().toISOString()} ===`);
  lines.forEach((l) => deps.out.appendLine(l));
  deps.out.show(true);

  vscode.window.showInformationMessage(
    llmProbe.ok ? `ReqForge model ready: ${llmProbe.detail}` : `ReqForge model unavailable: ${llmProbe.detail}`
  );
}

/* -------------------------------------------------------------- decompose */

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
    (await vscode.window.showQuickPick(
      [
        { label: 'Yes — review and revise the breakdown', description: '2 extra model calls, better output', value: true },
        { label: 'No — fastest path', description: 'single pass', value: false }
      ],
      { title: 'Run the critic pass?', ignoreFocusOut: true }
    ))?.value ?? true;

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
  deps.tree.refresh();

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
  await BacklogPanel.show(deps.ctx, deps.out, () => deps.tree.refresh(), result.slug);
}

async function pickBacklog(): Promise<{ slug: string; backlog: Backlog } | undefined> {
  const s = store();
  const slugs = await s.listSlugs();
  if (slugs.length === 0) {
    vscode.window.showWarningMessage('No backlogs yet. Run "ReqForge: Decompose Confluence PRD" first.');
    return undefined;
  }
  const slug =
    slugs.length === 1
      ? slugs[0]
      : await vscode.window.showQuickPick(slugs, { title: 'Which backlog?', ignoreFocusOut: true });
  if (!slug) return undefined;
  const backlog = await s.load(slug);
  return backlog ? { slug, backlog } : undefined;
}

async function storiesCmd(deps: Deps): Promise<void> {
  const picked = await pickBacklog();
  if (!picked) return;

  const choices = await vscode.window.showQuickPick(
    picked.backlog.epics.map((e) => ({
      label: e.title,
      description: `${e.stories.length} stories · ${e.sizing}`,
      value: e.ref,
      picked: e.stories.length === 0
    })),
    { title: 'Which epics?', canPickMany: true, ignoreFocusOut: true }
  );
  if (!choices?.length) return;

  const { llm } = await ports(deps);
  const updated = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ReqForge', cancellable: true },
    async (progress, token) =>
      decomposeEpics(llm, picked.backlog, choices.map((c) => c.value), {
        progress: { report: (message) => progress.report({ message }) },
        token
      })
  );

  await store().save(picked.slug, updated);
  deps.tree.refresh();

  const total = updated.epics.reduce((n, e) => n + e.stories.length, 0);
  vscode.window.showInformationMessage(`ReqForge: backlog now has ${total} stories.`);
}

/* -------------------------------------------------------------------- push */

async function pushCmd(deps: Deps, forceDryRun: boolean): Promise<void> {
  if (!(await ensureConfigured(deps.ctx))) return;
  const picked = await pickBacklog();
  if (!picked) return;

  const { atlassian } = await ports(deps);

  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ReqForge: planning push…' },
    () => planPush(atlassian, picked.backlog)
  );

  // The preview is always shown, even for a real push. Seeing the plan is the
  // whole safety story, and it costs one keystroke.
  const previewUri = deps.docs.set(`push-preview-${picked.slug}.md`, renderPlan(plan, picked.backlog));
  await vscode.window.showTextDocument(previewUri, { preview: true });
  await vscode.commands.executeCommand('markdown.showPreview').then(undefined, () => undefined);

  const dryRunDefault = cfg().get<boolean>('push.dryRunDefault', true);
  if (forceDryRun) {
    vscode.window.showInformationMessage('ReqForge: dry run only — nothing was written to Jira.');
    return;
  }

  if (plan.blockingFields.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `${plan.blockingFields.length} required Jira field(s) are not populated by ReqForge. Creates will likely fail.`,
      { modal: true, detail: plan.blockingFields.join('\n') },
      'Push Anyway'
    );
    if (proceed !== 'Push Anyway') return;
  }

  const counts = plan.actions.reduce(
    (acc, a) => ({ ...acc, [a.verb]: (acc as Record<string, number>)[a.verb] + 1 }),
    { create: 0, update: 0, skip: 0 } as Record<string, number>
  );

  const confirm = await vscode.window.showWarningMessage(
    `Write to Jira project ${plan.projectKey}?`,
    {
      modal: true,
      detail: `${counts.create} issues will be created, ${counts.update} updated, ${counts.skip} left unchanged.${
        dryRunDefault ? '\n\nThis is the only confirmation.' : ''
      }`
    },
    'Push'
  );
  if (confirm !== 'Push') return;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ReqForge: pushing to Jira' },
    (progress) => executePush(atlassian, picked.backlog, plan, { progress: { report: (m) => progress.report({ message: m }) } })
  );

  // Save even on partial failure — the keys we did get must not be lost, or the
  // next run creates duplicates.
  await store().save(picked.slug, picked.backlog);
  deps.tree.refresh();

  deps.out.appendLine(
    `\nPush complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.failures.length} failed`
  );
  result.failures.forEach((f) => deps.out.appendLine(`  FAILED ${f.ref}: ${f.error}`));

  if (result.failures.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `ReqForge: ${result.created + result.updated} succeeded, ${result.failures.length} failed.`,
      'Show Details'
    );
    if (choice === 'Show Details') deps.out.show(true);
  } else {
    vscode.window.showInformationMessage(
      `ReqForge: ${result.created} created, ${result.updated} updated in ${plan.projectKey}.`
    );
  }
}

/* ------------------------------------------------------------------ refine */

async function refineCmd(deps: Deps): Promise<void> {
  if (!(await ensureConfigured(deps.ctx))) return;

  const key = await vscode.window.showInputBox({
    title: 'ReqForge — Refine issue',
    prompt: 'Jira issue key',
    placeHolder: 'ACME-123',
    ignoreFocusOut: true,
    validateInput: (v) => (/^[A-Z][A-Z0-9_]+-\d+$/.test(v.trim().toUpperCase()) ? undefined : 'Expected a key like ACME-123')
  });
  if (!key) return;

  const instruction = await vscode.window.showInputBox({
    title: `ReqForge — Refine ${key.toUpperCase()}`,
    prompt: 'What should change?',
    placeHolder: 'Split out the migration work, and add acceptance criteria for the error states',
    ignoreFocusOut: true
  });
  if (!instruction) return;

  const { atlassian, llm } = await ports(deps);

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ReqForge: refining ${key.toUpperCase()}…`, cancellable: true },
    (_p, token) => refineIssue(atlassian, llm, { key: key.trim().toUpperCase(), instruction, token })
  );

  if (!result.changed) {
    vscode.window.showInformationMessage(`ReqForge: the model returned no material change to ${result.key}.`);
    return;
  }

  // Native diff editor beats any custom review UI we could build in a weekend.
  const before = deps.docs.set(`${result.key}-current.md`, `# ${result.before.summary}\n\n${result.before.description}`);
  const after = deps.docs.set(`${result.key}-refined.md`, `# ${result.after.summary}\n\n${result.after.description}`);
  await vscode.commands.executeCommand('vscode.diff', before, after, `${result.key}: current ↔ refined`);

  const apply = await vscode.window.showInformationMessage(
    `Apply the refined version to ${result.key}?`,
    { modal: true, detail: 'This updates the summary and description in Jira.' },
    'Apply'
  );
  if (apply !== 'Apply') return;

  await atlassian.updateIssue(result.key, {
    summary: result.after.summary,
    descriptionMarkdown: result.after.description
  });
  vscode.window.showInformationMessage(`ReqForge: ${result.key} updated.`);
}
