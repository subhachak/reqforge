import * as vscode from 'vscode';
import { registry } from '@registry';
import type { Backlog, EpicItem } from '../core/model';
import { slugify } from '../core/model';
import { decomposeEpics } from '../core/pipeline/decompose';
import { executePush, planPush, type PushPlan } from '../core/pipeline/push';
import { applyRefinement, refineBacklogItem, type LocalRefineResult } from '../core/pipeline/refineLocal';
import { LlmUnavailableError, type AtlassianPort, type LlmPort } from '../core/ports';
import { BacklogStore, backlogPath } from '../core/store';
import type { HostMessage, PanelState, WebviewMessage } from '../shared/protocol';
import { adapterContext, cfg, dataFolder } from './config';
import { WorkspaceFs } from './fs';

/**
 * The product owner's window onto a backlog.
 *
 * The host owns the state. The webview posts intents and re-renders whatever
 * comes back, which keeps the file on disk and the pixels on screen from ever
 * disagreeing. The YAML remains the persistence format — it is simply no
 * longer the interface.
 */
export class BacklogPanel {
  private static current: BacklogPanel | undefined;

  static async show(ctx: vscode.ExtensionContext, out: vscode.OutputChannel, onChanged: () => void, slug?: string) {
    const column = vscode.ViewColumn.One;
    if (BacklogPanel.current) {
      BacklogPanel.current.panel.reveal(column);
      if (slug) await BacklogPanel.current.load(slug);
      return BacklogPanel.current;
    }

    const panel = vscode.window.createWebviewPanel('reqforge.backlog', 'ReqForge', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')]
    });

    BacklogPanel.current = new BacklogPanel(ctx, panel, out, onChanged);
    if (slug) await BacklogPanel.current.load(slug);
    return BacklogPanel.current;
  }

  private backlog: Backlog | undefined;
  private slug: string | undefined;
  private plan: PushPlan | undefined;
  private pendingRefine: LocalRefineResult | undefined;
  private notice: PanelState['notice'];
  private busy = false;
  private busyLabel = '';

  /**
   * Undo history, held by the host so it survives a webview reload and covers
   * generated content and deletions, not just typing.
   *
   * Deliberately cleared after a push: undoing past a push would roll back the
   * Jira keys we just recorded, and the next push would then create duplicates
   * of issues that already exist. Local edits are reversible; sending is not.
   */
  private history: { backlog: Backlog; label: string; at: number; key?: string }[] = [];
  private future: { backlog: Backlog; label: string }[] = [];
  private static readonly MAX_HISTORY = 50;
  /** Consecutive edits inside this window collapse into one undo step. */
  private static readonly COALESCE_MS = 2000;

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly out: vscode.OutputChannel,
    private readonly onChanged: () => void
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => (BacklogPanel.current = undefined));
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handle(msg));
  }

  /* ------------------------------------------------------------- plumbing */

  private store(): BacklogStore {
    return new BacklogStore(new WorkspaceFs(), dataFolder());
  }

  private async ports(): Promise<{ atlassian: AtlassianPort; llm: LlmPort }> {
    const actx = await adapterContext(this.ctx);
    return { atlassian: registry.createAtlassian(actx), llm: registry.createLlm(actx) };
  }

  private post(msg: HostMessage) {
    void this.panel.webview.postMessage(msg);
  }

  private async send() {
    const slugs = await this.store().listSlugs();
    const available: { slug: string; title: string }[] = [];
    for (const s of slugs) {
      if (s === this.slug && this.backlog) {
        available.push({ slug: s, title: this.backlog.source.title });
      } else {
        const b = await this.store().load(s).catch(() => undefined);
        available.push({ slug: s, title: b?.source.title ?? s });
      }
    }

    const state: PanelState = {
      backlog: this.backlog,
      available,
      slug: this.slug,
      busy: this.busy,
      busyLabel: this.busyLabel,
      plan: this.plan,
      notice: this.notice,
      pendingRefine: this.pendingRefine
        ? {
            level: this.pendingRefine.level,
            ref: this.pendingRefine.ref,
            title: (this.pendingRefine.revised as EpicItem).title,
            beforeMarkdown: this.pendingRefine.beforeMarkdown,
            afterMarkdown: this.pendingRefine.afterMarkdown,
            changed: this.pendingRefine.changed
          }
        : undefined,
      jiraBrowseBase: cfg().get<string>('atlassian.baseUrl', '').replace(/\/+$/, ''),
      canPush: Boolean(this.backlog?.target.projectKey),
      undoLabel: this.history[this.history.length - 1]?.label,
      redoLabel: this.future[this.future.length - 1]?.label
    };
    this.post({ type: 'state', state });
  }

  /* ---------------------------------------------------------------- undo */

  /**
   * Records the state *before* a mutation. `coalesceKey` groups a burst of the
   * same kind of change — typing — into a single undo step, so Undo reverses a
   * sentence rather than a keystroke.
   */
  private snapshot(label: string, coalesceKey?: string) {
    if (!this.backlog) return;
    const last = this.history[this.history.length - 1];
    if (coalesceKey && last?.key === coalesceKey && Date.now() - last.at < BacklogPanel.COALESCE_MS) {
      last.at = Date.now(); // extend the window; keep the older pre-edit state
      return;
    }
    this.history.push({ backlog: structuredClone(this.backlog), label, at: Date.now(), key: coalesceKey });
    if (this.history.length > BacklogPanel.MAX_HISTORY) this.history.shift();
    this.future = [];
  }

  private async undo() {
    const entry = this.history.pop();
    if (!entry || !this.backlog) return;
    this.future.push({ backlog: structuredClone(this.backlog), label: entry.label });
    this.backlog = entry.backlog;
    await this.save();
    await this.send();
  }

  private async redo() {
    const entry = this.future.pop();
    if (!entry || !this.backlog) return;
    this.history.push({ backlog: structuredClone(this.backlog), label: entry.label, at: Date.now() });
    this.backlog = entry.backlog;
    await this.save();
    await this.send();
  }

  private clearHistory() {
    this.history = [];
    this.future = [];
  }

  private async save() {
    if (this.backlog && this.slug) {
      await this.store().save(this.slug, this.backlog);
      this.onChanged();
    }
  }

  async load(slug: string) {
    this.backlog = await this.store().load(slug);
    this.slug = slug;
    this.plan = undefined;
    this.pendingRefine = undefined;
    this.clearHistory();
    await this.send();
  }

  /** Wraps an operation with the busy overlay and uniform error reporting. */
  private async run(label: string, fn: () => Promise<void>) {
    this.busy = true;
    this.busyLabel = label;
    this.notice = undefined;
    await this.send();
    try {
      await fn();
    } catch (err) {
      const e = err as Error;
      this.out.appendLine(`\n[${new Date().toISOString()}] ${label} failed`);
      this.out.appendLine(e.stack ?? e.message);
      this.notice =
        e instanceof LlmUnavailableError
          ? { kind: 'error', message: e.message, hint: e.hint }
          : { kind: 'error', message: e.message, hint: 'See the ReqForge output channel for details.' };
    } finally {
      this.busy = false;
      this.busyLabel = '';
      await this.send();
    }
  }

  /* -------------------------------------------------------------- intents */

  private async handle(msg: WebviewMessage) {
    switch (msg.type) {
      case 'ready':
        if (!this.backlog) {
          const slugs = await this.store().listSlugs();
          if (slugs.length > 0) await this.load(slugs[0]);
        }
        await this.send();
        return;

      case 'selectBacklog':
        await this.load(msg.slug);
        return;

      case 'decompose':
        await vscode.commands.executeCommand('reqforge.decomposePrd');
        return;

      case 'edit':
        if (!this.backlog) return;
        this.snapshot('edit', 'edit');
        this.backlog.epics = msg.epics;
        await this.save();
        await this.send();
        return;

      case 'undo':
        await this.undo();
        return;

      case 'redo':
        await this.redo();
        return;

      case 'dismissNotice':
        this.notice = undefined;
        await this.send();
        return;

      case 'dismissPlan':
        this.plan = undefined;
        await this.send();
        return;

      case 'openExternal':
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;

      case 'revealFile':
        if (this.slug) {
          const uri = vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders![0].uri,
            ...backlogPath(dataFolder(), this.slug).split('/')
          );
          await vscode.window.showTextDocument(uri);
        }
        return;

      case 'addEpic': {
        if (!this.backlog) return;
        this.snapshot('add epic');
        const ref = this.uniqueRef('new-epic');
        this.backlog.epics.push({
          ref,
          title: 'New epic',
          outcome: '',
          description: '',
          inScope: [],
          outOfScope: [],
          acceptanceCriteria: [],
          dependsOn: [],
          sizing: 'M',
          openQuestions: [],
          sourceEvidence: [],
          sync: {},
          stories: []
        });
        await this.save();
        await this.send();
        return;
      }

      case 'addStory': {
        const epic = this.backlog?.epics.find((e) => e.ref === msg.epicRef);
        if (!epic) return;
        this.snapshot('add story');
        epic.stories.push({
          ref: this.uniqueRef(`${epic.ref}-story`),
          epicRef: epic.ref,
          title: 'New story',
          narrative: { asA: '', iWant: '', soThat: '' },
          description: '',
          acceptanceCriteria: [{ given: '', when: '', then: '' }],
          points: 3,
          openQuestions: [],
          sync: {}
        });
        await this.save();
        await this.send();
        return;
      }

      case 'deleteItem':
        await this.deleteItem(msg.level, msg.ref);
        return;

      case 'generateStories':
        await this.generateStories(msg.epicRefs);
        return;

      case 'refine':
        await this.refine(msg.level, msg.ref, msg.instruction);
        return;

      case 'acceptRefine':
        if (this.backlog && this.pendingRefine) {
          this.snapshot('rewrite');
          applyRefinement(this.backlog, this.pendingRefine);
          this.pendingRefine = undefined;
          await this.save();
        }
        await this.send();
        return;

      case 'discardRefine':
        this.pendingRefine = undefined;
        await this.send();
        return;

      case 'previewPush':
        await this.previewPush(msg.only);
        return;

      case 'push':
        await this.push(msg.only);
        return;
    }
  }

  /* ------------------------------------------------------------ operations */

  private async deleteItem(level: 'epic' | 'story', ref: string) {
    if (!this.backlog) return;
    const item =
      level === 'epic'
        ? this.backlog.epics.find((e) => e.ref === ref)
        : this.backlog.epics.flatMap((e) => e.stories).find((s) => s.ref === ref);
    if (!item) return;

    // Deleting locally does not delete from Jira, and pretending otherwise
    // would be the kind of surprise that loses trust in the tool.
    const warning = item.sync.jiraKey
      ? `Remove "${item.title}" from this backlog?`
      : `Delete "${item.title}"?`;
    const detail = item.sync.jiraKey
      ? `${item.sync.jiraKey} will stay in Jira — this only removes it from ReqForge. Delete it in Jira separately if you want it gone.`
      : 'This has not been sent to Jira, so it will be gone for good.';

    const ok = await vscode.window.showWarningMessage(warning, { modal: true, detail }, 'Remove');
    if (ok !== 'Remove') return;

    this.snapshot(level === 'epic' ? 'delete epic' : 'delete story');
    if (level === 'epic') {
      this.backlog.epics = this.backlog.epics.filter((e) => e.ref !== ref);
    } else {
      for (const e of this.backlog.epics) e.stories = e.stories.filter((s) => s.ref !== ref);
    }
    await this.save();
    await this.send();
  }

  private async generateStories(epicRefs: string[]) {
    if (!this.backlog) return;
    this.snapshot('generate stories');
    await this.run('Generating stories…', async () => {
      const { llm } = await this.ports();
      await decomposeEpics(llm, this.backlog!, epicRefs, {
        progress: {
          report: (message) => {
            this.busyLabel = message;
            void this.send();
          }
        }
      });
      await this.save();
    });
  }

  private async refine(level: 'epic' | 'story', ref: string, instruction: string) {
    if (!this.backlog) return;
    await this.run('Rewriting…', async () => {
      const { llm } = await this.ports();
      const result = await refineBacklogItem(llm, this.backlog!, { level, ref }, instruction);
      this.pendingRefine = result;
      if (!result.changed) {
        this.notice = { kind: 'info', message: 'The model did not change anything meaningful.' };
      }
    });
  }

  private async previewPush(only: string[]) {
    if (!this.backlog) return;
    await this.run('Checking Jira…', async () => {
      const { atlassian } = await this.ports();
      this.plan = await planPush(atlassian, this.backlog!, { onlyEpicRefs: only });
    });
  }

  private async push(only: string[]) {
    if (!this.backlog || !this.plan) return;
    const plan = this.plan;

    const counts = plan.actions.reduce(
      (acc, a) => ({ ...acc, [a.verb]: (acc as Record<string, number>)[a.verb] + 1 }),
      { create: 0, update: 0, skip: 0 } as Record<string, number>
    );
    const confirm = await vscode.window.showWarningMessage(
      `Send to Jira project ${plan.projectKey}?`,
      {
        modal: true,
        detail: `${counts.create} issues will be created and ${counts.update} updated. This cannot be undone from ReqForge.`
      },
      'Send'
    );
    if (confirm !== 'Send') return;

    this.plan = undefined;
    await this.run('Sending to Jira…', async () => {
      const { atlassian } = await this.ports();
      const result = await executePush(atlassian, this.backlog!, plan, {
        progress: {
          report: (message) => {
            this.busyLabel = message;
            void this.send();
          }
        }
      });
      // Save regardless of failures: the keys we did obtain must not be lost,
      // or the next run creates duplicates. For the same reason the undo
      // history is dropped — rolling back past a push would discard those keys.
      await this.save();
      this.clearHistory();

      this.out.appendLine(
        `\nPush: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.failures.length} failed`
      );
      result.failures.forEach((f) => this.out.appendLine(`  FAILED ${f.ref}: ${f.error}`));

      this.notice =
        result.failures.length > 0
          ? {
              kind: 'warn',
              message: `${result.created + result.updated} sent, ${result.failures.length} failed.`,
              hint: result.failures.map((f) => f.error).join(' · ').slice(0, 300)
            }
          : {
              kind: 'info',
              message: `Done — ${result.created} created, ${result.updated} updated in ${plan.projectKey}.`
            };
    });
  }

  private uniqueRef(base: string): string {
    const taken = new Set([
      ...(this.backlog?.epics.map((e) => e.ref) ?? []),
      ...(this.backlog?.epics.flatMap((e) => e.stories.map((s) => s.ref)) ?? [])
    ]);
    const root = slugify(base);
    if (!taken.has(root)) return root;
    let n = 2;
    while (taken.has(`${root}-${n}`)) n++;
    return `${root}-${n}`;
  }

  /* ------------------------------------------------------------------ html */

  private html(): string {
    const w = this.panel.webview;
    const script = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const style = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.css'));
    const nonce = nonceOf();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; font-src ${w.cspSource};" />
<link href="${style}" rel="stylesheet" />
<title>ReqForge</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function nonceOf(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
