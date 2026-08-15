import * as vscode from 'vscode';
import { registry } from '@registry';
import type { Backlog, EpicItem } from '../core/model';
import { slugify } from '../core/model';
import { decomposeEpics } from '../core/pipeline/decompose';
import { executePush, planPush, type PushPlan } from '../core/pipeline/push';
import { applyRefinement, refineBacklogItem, type LocalRefineResult } from '../core/pipeline/refineLocal';
import { LlmUnavailableError, type AtlassianPort, type LlmPort } from '../core/ports';
import { BacklogStore } from '../core/store';
import { backlogFromJiraIssue, markAsSynced } from '../core/pipeline/fromJira';
import {
  ALL_CRITERIA,
  DEFAULT_RUBRIC,
  RULE_IDS,
  assessBacklog,
  cacheKey,
  evaluateBacklog,
  fixInstruction,
  deleteQuality,
  loadQuality,
  loadRubric,
  pruneAssessments,
  sampleRubricYaml,
  saveQuality,
  overrideKey,
  type BacklogQuality,
  type CriterionResult,
  type Override,
  type RubricConfig
} from '../core/rubric/index';
import { epicFingerprint, storyFingerprint } from '../core/model';
import type {
  HostMessage,
  PanelState,
  RecentBacklog,
  SettingsPatch,
  SetupState,
  View,
  WebviewMessage
} from '../shared/protocol';
import { adapterContext, cfg, clearApiToken, dataFolder, promptForToken, updateSetting } from './config';
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

  /**
   * `slug` opens that backlog; `home` forces the start screen. Neither means
   * reveal whatever was already there, so switching to the panel does not
   * throw away where somebody was.
   */
  static async show(
    ctx: vscode.ExtensionContext,
    out: vscode.OutputChannel,
    opts: { slug?: string; home?: boolean } = {}
  ) {
    const column = vscode.ViewColumn.One;
    const existing = BacklogPanel.current;

    if (existing) {
      existing.panel.reveal(column, true);
      if (opts.slug) {
        await existing.load(opts.slug);
        existing.view = 'backlog';
        await existing.send();
      } else if (opts.home) {
        existing.view = 'home';
        await existing.send();
      }
      return existing;
    }

    const panel = vscode.window.createWebviewPanel('reqforge.backlog', 'ReqForge', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')]
    });

    BacklogPanel.current = new BacklogPanel(ctx, panel, out);
    if (opts.slug) {
      await BacklogPanel.current.load(opts.slug);
      BacklogPanel.current.view = 'backlog';
      await BacklogPanel.current.send();
    }
    return BacklogPanel.current;
  }

  private view: View = 'home';
  private backlog: Backlog | undefined;
  private slug: string | undefined;
  private plan: PushPlan | undefined;
  private pendingRefine: LocalRefineResult | undefined;
  private notice: PanelState['notice'];
  private busy = false;
  private busyLabel = '';
  private rubric: RubricConfig = DEFAULT_RUBRIC;
  private rubricSource: 'default' | 'file' = 'default';
  private rubricProblem: string | undefined;
  /** Model assessments, keyed by level:ref:fingerprint so edits invalidate them. */
  private assessments = new Map<string, CriterionResult[]>();
  /** Reviewer decisions, keyed by level:ref so they survive editing. */
  private overrides = new Map<string, Override>();

  /** Connection test results, only refreshed on an explicit test. */
  private probes = {
    atlassian: { state: 'unknown', detail: '' } as SetupState['atlassian'],
    model: { state: 'unknown', detail: '' } as SetupState['model']
  };

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
    private readonly out: vscode.OutputChannel
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
    // A transient network failure pauses the run; say so, or the overlay just
    // sits there and the user assumes it has hung.
    actx.onLlmRetry = (attempt, delayMs, reason) => {
      this.out.appendLine(`Copilot request failed (${reason.slice(0, 160)}) — retrying in ${delayMs / 1000}s`);
      this.busyLabel = `Copilot did not respond. Retrying in ${delayMs / 1000}s (attempt ${attempt} of 3)…`;
      void this.send();
    };
    actx.onLlmCall = ({ n, tool, inputTokens }) =>
      this.out.appendLine(`Copilot request ${n} — ${tool}, ${inputTokens.toLocaleString()} input tokens`);
    return { atlassian: registry.createAtlassian(actx), llm: registry.createLlm(actx) };
  }

  private post(msg: HostMessage) {
    void this.panel.webview.postMessage(msg);
  }

  private async setupState(): Promise<SetupState> {
    const c = cfg();
    const baseUrl = c.get<string>('atlassian.baseUrl', '').trim();
    const email = c.get<string>('atlassian.email', '').trim();
    const projectKey = c.get<string>('jira.projectKey', '').trim();
    const hasToken = Boolean(await this.ctx.secrets.get('reqforge.atlassian.apiToken'));
    return {
      baseUrl,
      email,
      projectKey,
      epicIssueType: c.get<string>('jira.epicIssueType', 'Epic'),
      storyIssueType: c.get<string>('jira.storyIssueType', 'Story'),
      modelFamily: c.get<string>('llm.modelFamily', ''),
      hasToken,
      complete: Boolean(baseUrl && email && projectKey && hasToken),
      atlassian: this.probes.atlassian,
      model: this.probes.model
    };
  }

  /** Local summaries only — nothing here talks to Jira. */
  private async recent(): Promise<RecentBacklog[]> {
    const out: RecentBacklog[] = [];
    for (const slug of await this.store().listSlugs()) {
      const b = slug === this.slug && this.backlog ? this.backlog : await this.store().load(slug).catch(() => undefined);
      if (!b) continue;
      const stories = b.epics.flatMap((e) => e.stories);
      out.push({
        slug,
        title: b.source.title,
        epics: b.epics.length,
        stories: stories.length,
        unpushed: [...b.epics, ...stories].filter((i) => !i.sync.jiraKey).length,
        projectKey: b.target.projectKey
      });
    }
    return out;
  }

  private async send() {
    const setup = await this.setupState();
    // Setup is a hard gate: nothing else is reachable until it is complete.
    const view: View = setup.complete ? this.view : 'setup';

    const state: PanelState = {
      view,
      setup,
      recent: await this.recent(),
      backlog: this.backlog,
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
      jiraBrowseBase: setup.baseUrl.replace(/\/+$/, ''),
      undoLabel: this.history[this.history.length - 1]?.label,
      redoLabel: this.future[this.future.length - 1]?.label,
      quality: this.quality(),
      criteria: ALL_CRITERIA,
      rubric: {
        threshold: this.rubric.threshold,
        enforcement: this.rubric.enforcement,
        requireReview: this.rubric.requireReview,
        source: this.rubricSource,
        problem: this.rubricProblem
      }
    };
    this.post({ type: 'state', state });
  }

  /* -------------------------------------------------------------- quality */

  /** Deterministic rules cost nothing, so quality is recomputed on every render. */
  private quality(): BacklogQuality | undefined {
    return this.backlog ? evaluateBacklog(this.backlog, this.rubric, this.assessments, this.overrides) : undefined;
  }

  private liveKeys(): Set<string> {
    const keys = new Set<string>();
    for (const epic of this.backlog?.epics ?? []) {
      keys.add(cacheKey('epic', epic.ref, epicFingerprint(epic)));
      for (const story of epic.stories) keys.add(cacheKey('story', story.ref, storyFingerprint(story)));
    }
    return keys;
  }

  private async saveQuality() {
    if (!this.slug) return;
    this.assessments = pruneAssessments(this.assessments, this.liveKeys());
    await saveQuality(new WorkspaceFs(), dataFolder(), this.slug, {
      assessments: this.assessments,
      overrides: this.overrides
    });
  }

  private mutateOverride(level: 'epic' | 'story', ref: string, fn: (o: Override) => void) {
    const key = overrideKey(level, ref);
    const existing = this.overrides.get(key) ?? { level, ref, waivedRules: [], reasons: {} };
    fn(existing);
    // Drop empty overrides rather than leaving hollow records behind.
    if (existing.waivedRules.length === 0 && !existing.acceptedBelowThreshold) this.overrides.delete(key);
    else this.overrides.set(key, existing);
  }

  /** Records that a reviewer judged a rule not to apply to this item. */
  private async waiveFinding(level: 'epic' | 'story', ref: string, ruleId: string) {
    const reason = await vscode.window.showInputBox({
      title: 'Dismiss this check',
      prompt: 'Why does this check not apply here? Recorded against the item.',
      placeHolder: 'e.g. traceability is covered by the linked compliance page',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length >= 4 ? undefined : 'Give a reason — an unexplained exception is worse than none')
    });
    if (reason === undefined) return;
    this.mutateOverride(level, ref, (o) => {
      if (!o.waivedRules.includes(ruleId)) o.waivedRules.push(ruleId);
      o.reasons[ruleId] = reason.trim();
    });
    await this.saveQuality();
    await this.send();
  }

  private async unwaiveFinding(level: 'epic' | 'story', ref: string, ruleId: string) {
    this.mutateOverride(level, ref, (o) => {
      o.waivedRules = o.waivedRules.filter((r) => r !== ruleId);
      delete o.reasons[ruleId];
    });
    await this.saveQuality();
    await this.send();
  }

  /** Accepts an item that scores below the threshold, with an attributed reason. */
  private async acceptBelowThreshold(level: 'epic' | 'story', ref: string) {
    const reason = await vscode.window.showInputBox({
      title: 'Accept below the quality threshold',
      prompt: 'Why is this good enough to send despite the score? Recorded against the item.',
      placeHolder: 'e.g. spike story, detail will follow after the technical investigation',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length >= 4 ? undefined : 'Give a reason — this is the record of the exception')
    });
    if (reason === undefined) return;
    this.mutateOverride(level, ref, (o) => {
      o.acceptedBelowThreshold = { reason: reason.trim(), at: new Date().toISOString() };
    });
    await this.saveQuality();
    await this.send();
  }

  private async revokeAcceptance(level: 'epic' | 'story', ref: string) {
    this.mutateOverride(level, ref, (o) => {
      delete o.acceptedBelowThreshold;
    });
    await this.saveQuality();
    await this.send();
  }

  private async deepReview(only?: string[]) {
    if (!this.backlog) return;
    await this.run('Reviewing quality…', async () => {
      const { llm } = await this.ports();
      const epicRefs = only ?? this.backlog!.epics.map((e) => e.ref);
      const storyRefs = this.backlog!.epics.filter((e) => epicRefs.includes(e.ref)).flatMap((e) =>
        e.stories.map((s) => s.ref)
      );

      this.assessments = await assessBacklog(llm, this.backlog!, this.rubric, {
        only: { epics: epicRefs, stories: storyRefs },
        cached: this.assessments,
        progress: {
          report: (message) => {
            this.busyLabel = message;
            void this.send();
          }
        }
      });
      await this.saveQuality();

      const q = this.quality()!;
      this.notice = {
        kind: q.failed > 0 ? 'warn' : 'info',
        message: `Quality review complete — average ${q.score}, ${q.passed} of ${q.passed + q.failed} items at or above ${q.threshold}.`,
        hint: q.failed > 0 ? `${q.failed} item(s) need work before they can be sent.` : undefined
      };
    });
  }

  /** Turns an item's findings into a refine instruction and runs the normal rewrite flow. */
  private async fixItem(level: 'epic' | 'story', ref: string) {
    const q = this.quality();
    const item = q?.items.find((i) => i.level === level && i.ref === ref);
    if (!item) return;
    await this.refine(level, ref, fixInstruction(item));
  }

  private async createRubricFile() {
    const fs = new WorkspaceFs();
    const relPath = `${dataFolder()}/rubric.yaml`;
    if (await fs.read(relPath)) {
      this.notice = { kind: 'info', message: 'rubric.yaml already exists.' };
    } else {
      await fs.write(relPath, sampleRubricYaml(RULE_IDS, ALL_CRITERIA.map((c) => c.id)));
      await this.reloadRubric();
      this.notice = { kind: 'info', message: 'Created .reqforge/rubric.yaml — edit it to set your own standard.' };
    }
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, ...relPath.split('/'));
    await vscode.window.showTextDocument(uri);
    await this.send();
  }

  private async reloadRubric() {
    const loaded = await loadRubric(new WorkspaceFs(), dataFolder());
    this.rubric = loaded.config;
    this.rubricSource = loaded.source;
    this.rubricProblem = loaded.problem;
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
    }
  }

  async load(slug: string) {
    this.backlog = await this.store().load(slug);
    this.slug = slug;
    this.plan = undefined;
    this.pendingRefine = undefined;
    this.clearHistory();
    await this.reloadRubric();
    const record = await loadQuality(new WorkspaceFs(), dataFolder(), slug);
    this.assessments = record.assessments;
    this.overrides = record.overrides;
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
      // Deliberately does not open a backlog. The panel lands on the home
      // screen so the user chooses what to work on, rather than being dropped
      // into whichever file happened to sort first.
      case 'ready':
        await this.send();
        return;

      case 'navigate':
        this.view = msg.view;
        await this.send();
        return;

      case 'openBacklog':
        await this.load(msg.slug);
        this.view = 'backlog';
        await this.send();
        return;

      case 'deleteBacklog':
        await this.deleteBacklog(msg.slug);
        return;

      case 'decompose':
        await vscode.commands.executeCommand('reqforge.decomposePrd');
        return;

      /* ------------------------------------------------------------ setup */

      case 'saveSettings':
        await this.saveSettings(msg.patch);
        return;

      case 'setToken':
        if (await promptForToken(this.ctx)) {
          this.probes.atlassian = { state: 'unknown', detail: '' };
        }
        await this.send();
        return;

      case 'clearToken':
        await clearApiToken(this.ctx);
        this.probes.atlassian = { state: 'unknown', detail: '' };
        await this.send();
        return;

      case 'testConnection':
        await this.testConnection();
        return;

      /* ------------------------------------------------------- jira refine */

      case 'fetchJiraIssue':
        await this.fetchJiraIssue(msg.key);
        return;


      case 'edit': {
        if (!this.backlog) return;

        // A debounced edit can arrive after the user has switched backlogs.
        // Applying it would write one backlog's contents over another, so an
        // edit authored against a different slug is dropped.
        if (msg.slug !== undefined && msg.slug !== this.slug) {
          this.out.appendLine(`Ignored an edit meant for "${msg.slug}" while "${this.slug}" is open.`);
          return;
        }

        // Editing is not how items are removed — deleteItem is, and it asks
        // first. An edit that would empty a populated backlog is a bug
        // somewhere upstream, and applying it destroys work irrecoverably.
        if (msg.epics.length === 0 && this.backlog.epics.length > 0) {
          this.out.appendLine(
            `Refused an edit that would have removed all ${this.backlog.epics.length} epics from "${this.slug}".`
          );
          this.notice = {
            kind: 'warn',
            message: 'An edit that would have emptied this backlog was ignored.',
            hint: 'Nothing was lost. Use the delete control on an epic if you meant to remove one.'
          };
          await this.send();
          return;
        }

        this.snapshot('edit', 'edit');
        this.backlog.epics = msg.epics;
        await this.save();
        await this.send();
        return;
      }

      case 'undo':
        await this.undo();
        return;

      case 'redo':
        await this.redo();
        return;

      case 'deepReview':
        await this.deepReview(msg.only);
        return;

      case 'fixItem':
        await this.fixItem(msg.level, msg.ref);
        return;

      case 'createRubricFile':
        await this.createRubricFile();
        return;

      case 'waiveFinding':
        await this.waiveFinding(msg.level, msg.ref, msg.ruleId);
        return;

      case 'unwaiveFinding':
        await this.unwaiveFinding(msg.level, msg.ref, msg.ruleId);
        return;

      case 'acceptBelowThreshold':
        await this.acceptBelowThreshold(msg.level, msg.ref);
        return;

      case 'revokeAcceptance':
        await this.revokeAcceptance(msg.level, msg.ref);
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
        await this.openExternal(msg.url);
        return;

      case 'addEpic': {
        if (!this.backlog) return;
        this.snapshot('add epic');
        const ref = this.uniqueRef('new-epic');
        this.backlog.epics.push({
          ref,
          title: 'New epic',
          outcome: '',
          priority: 'Should',
          description: '',
          inScope: [],
          outOfScope: [],
          successMeasures: [],
          nonFunctional: [],
          assumptions: [],
          acceptanceCriteria: [],
          dependsOn: [],
          links: [],
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
          priority: 'Should',
          acceptanceCriteria: [{ given: '', when: '', then: '' }],
          assumptions: [],
          dependsOn: [],
          links: [],
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

  /**
   * Removes a backlog from this machine.
   *
   * Anything already sent stays in Jira — saying so plainly matters, because
   * the two are easy to conflate and one of them is not reversible from here.
   * The stamp labels survive too, so re-decomposing the same page later adopts
   * those issues rather than duplicating them.
   */
  private async deleteBacklog(slug: string) {
    const backlog = await this.store().load(slug).catch(() => undefined);
    const title = backlog?.source.title ?? slug;
    const pushed = backlog
      ? [...backlog.epics, ...backlog.epics.flatMap((e) => e.stories)].filter((i) => i.sync.jiraKey).length
      : 0;

    const detail = pushed
      ? `${pushed} item(s) have already been sent to Jira. They will stay there — this only removes the local copy. ` +
        `If you decompose the same page again, those issues are recognised and updated rather than duplicated.`
      : 'Nothing from this backlog has been sent to Jira, so it will be gone for good.';

    const ok = await vscode.window.showWarningMessage(`Delete "${title}" from this machine?`, { modal: true, detail }, 'Delete');
    if (ok !== 'Delete') return;

    await this.store().remove(slug);
    await deleteQuality(new WorkspaceFs(), dataFolder(), slug);

    // Drop it from memory too if it is the one currently open.
    if (this.slug === slug) {
      this.backlog = undefined;
      this.slug = undefined;
      this.assessments = new Map();
      this.overrides = new Map();
      this.clearHistory();
      this.plan = undefined;
      this.view = 'home';
    }

    this.notice = { kind: 'info', message: `Removed "${title}" from this machine.` };
    await this.send();
  }

  /**
   * Opens a link from the panel.
   *
   * URLs in a backlog reach us from Jira and from git, so they are somebody
   * else's input. `openExternal` will act on a `command:` URI, which would let
   * a crafted issue description run a VS Code command; `file:` would open
   * arbitrary local paths. Only http and https are followed, and anything else
   * is reported rather than silently ignored.
   */
  private async openExternal(raw: string) {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(raw, true);
    } catch {
      this.notice = { kind: 'warn', message: `That is not a valid link: ${raw.slice(0, 80)}` };
      await this.send();
      return;
    }

    if (uri.scheme !== 'http' && uri.scheme !== 'https') {
      this.notice = {
        kind: 'warn',
        message: `Refused to open a "${uri.scheme}:" link.`,
        hint: 'Only http and https links are opened. Links in a backlog can come from Jira or from a colleague.'
      };
      await this.send();
      return;
    }

    await vscode.env.openExternal(uri);
  }

  /* ----------------------------------------------------------------- setup */

  private async saveSettings(patch: SettingsPatch) {
    // Site and account are per-user; project and issue types are per-project.
    const scopes: Record<keyof SettingsPatch, { key: string; scope: 'global' | 'workspace' }> = {
      baseUrl: { key: 'atlassian.baseUrl', scope: 'global' },
      email: { key: 'atlassian.email', scope: 'global' },
      modelFamily: { key: 'llm.modelFamily', scope: 'global' },
      projectKey: { key: 'jira.projectKey', scope: 'workspace' },
      epicIssueType: { key: 'jira.epicIssueType', scope: 'workspace' },
      storyIssueType: { key: 'jira.storyIssueType', scope: 'workspace' }
    };

    for (const [field, value] of Object.entries(patch) as [keyof SettingsPatch, string][]) {
      const target = scopes[field];
      if (!target || value === undefined) continue;
      const clean = field === 'baseUrl' ? value.trim().replace(/\/+$/, '') : value.trim();
      await updateSetting(target.key, clean, target.scope);
    }

    // Anything changed here invalidates a previous test result.
    this.probes = { atlassian: { state: 'unknown', detail: '' }, model: { state: 'unknown', detail: '' } };
    await this.send();
  }

  private async testConnection() {
    await this.run('Checking connections…', async () => {
      const actx = await adapterContext(this.ctx);

      const model = await registry.createLlm(actx).probe();
      this.probes.model = { state: model.ok ? 'ok' : 'failed', detail: model.detail };

      if (actx.baseUrl && actx.email && actx.apiToken) {
        try {
          const result = await registry.createAtlassian(actx).verifyConnection();
          this.probes.atlassian = { state: result.ok ? 'ok' : 'failed', detail: result.detail };
        } catch (err) {
          this.probes.atlassian = { state: 'failed', detail: (err as Error).message };
        }
      } else {
        this.probes.atlassian = { state: 'failed', detail: 'Site, email and API token are all required.' };
      }
    });
  }

  /* ----------------------------------------------------------- jira refine */

  /**
   * Pulls an existing epic in and turns it into a working backlog.
   *
   * Everything downstream — the structured editor, the rubric, story
   * generation, undo, push-as-update — is the same code the PRD path uses.
   * Building a second editor for "edit an existing issue" would have meant
   * maintaining two of everything.
   */
  private async fetchJiraIssue(key: string) {
    const trimmed = key.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(trimmed)) {
      this.notice = { kind: 'warn', message: `"${key}" is not a Jira issue key. Expected something like ACME-123.` };
      await this.send();
      return;
    }

    await this.run(`Fetching ${trimmed}…`, async () => {
      const { atlassian } = await this.ports();
      const c = cfg();
      const result = await backlogFromJiraIssue(
        atlassian,
        trimmed,
        {
          projectKey: c.get<string>('jira.projectKey', ''),
          epicIssueType: c.get<string>('jira.epicIssueType', 'Epic'),
          storyIssueType: c.get<string>('jira.storyIssueType', 'Story')
        },
        {
          progress: {
            report: (message) => {
              this.busyLabel = message;
              void this.send();
            }
          }
        }
      );

      // Nothing has been edited yet, so record it as matching Jira. Otherwise
      // the panel would open claiming everything needs sending.
      markAsSynced(result.backlog);

      await this.store().save(result.slug, result.backlog);
      await this.load(result.slug);
      this.view = 'backlog';
  
      const stories = result.backlog.epics[0]?.stories.length ?? 0;
      this.notice = result.unstructured
        ? {
            kind: 'warn',
            message: `${trimmed} was not created by ReqForge, so it has no structure to read back.`,
            hint: 'Its description is in the Description field. Fill in the outcome and acceptance criteria, or use Fix with AI.'
          }
        : {
            kind: 'info',
            message: `Loaded ${trimmed}${stories ? ` and ${stories} stor${stories === 1 ? 'y' : 'ies'}` : ''}.`
          };
    });
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

    // The gate is enforced here, on the host, and not only in the webview. A
    // disabled button is a hint; this is the rule.
    //
    // Two different things are being judged, and they are treated differently:
    // a structural blocker is a fact about the item (no acceptance criteria,
    // an incomplete given/when/then, a dependency that does not exist) and
    // always stops the send. A low score is a judgement, and by default it
    // does not — the item ships carrying labels and a note saying what fell
    // short, which is more useful than a backlog nobody can move.
    const q = this.quality();
    const included = new Set(only);
    const inScope = (i: { level: 'epic' | 'story'; ref: string }) => {
      const epicRef =
        i.level === 'epic' ? i.ref : this.backlog!.epics.find((e) => e.stories.some((s) => s.ref === i.ref))?.ref;
      return epicRef ? included.has(epicRef) : false;
    };

    const structural = (q?.items ?? []).filter((i) => i.blockedBy.length > 0 && inScope(i));
    if (structural.length > 0) {
      this.notice = {
        kind: 'error',
        message: `${structural.length} item(s) are missing something Jira needs: ${summarise(structural)}.`,
        hint: 'These are structural problems, not scores — fix them, or dismiss the check if it does not apply here.'
      };
      this.plan = undefined;
      await this.send();
      return;
    }

    const belowBar = (q?.items ?? []).filter((i) => !i.passed && i.blockedBy.length === 0 && inScope(i));
    if (belowBar.length > 0 && this.rubric.enforcement !== 'label') {
      const detail = belowBar
        .slice(0, 8)
        .map((i) => `• ${i.title} — ${i.deterministicOnly ? 'not reviewed' : `${i.score}/${i.threshold}`}`)
        .join('\n');
      const more = belowBar.length > 8 ? `\n…and ${belowBar.length - 8} more.` : '';

      if (this.rubric.enforcement === 'block') {
        this.notice = {
          kind: 'error',
          message: `${belowBar.length} item(s) are below the quality threshold of ${this.rubric.threshold}.`,
          hint: 'Fix them, accept one below the threshold with a reason, or set enforcement: label in .reqforge/rubric.yaml.'
        };
        this.plan = undefined;
        await this.send();
        return;
      }

      const proceed = await vscode.window.showWarningMessage(
        `${belowBar.length} item(s) are below the quality threshold.`,
        { modal: true, detail: `${detail}${more}` },
        'Send Anyway'
      );
      if (proceed !== 'Send Anyway') return;
    }

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
      const qualityNow = this.quality();
      const flagged = (qualityNow?.items ?? []).filter((i) => !i.passed && inScope(i)).length;
      const result = await executePush(atlassian, this.backlog!, plan, {
        quality: new Map((qualityNow?.items ?? []).map((i) => [`${i.level}:${i.ref}`, i])),
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
              message: `Done — ${result.created} created, ${result.updated} updated in ${plan.projectKey}.`,
              hint: flagged > 0 ? `${flagged} item(s) were sent tagged with quality problems.` : undefined
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

/** "3 with no acceptance criteria, 1 with an incomplete criterion" */
function summarise(items: { blockedBy: { message: string }[] }[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const b of item.blockedBy) counts.set(b.message, (counts.get(b.message) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([message, n]) => `${n} × ${message.replace(/\.$/, '')}`)
    .join(', ');
}

function nonceOf(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
