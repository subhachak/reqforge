import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EpicItem, StoryItem, SyncStatus } from '../core/model';
import { syncStatus } from '../core/model';
import type { AcceptanceCriterion } from '../core/schemas';
import type { CriterionDef, ItemQuality } from '../core/rubric/index';
import type { Conflict, Observation } from '../core/findings';
import type { HostMessage, PanelState, SettingsPatch, WebviewMessage } from '../shared/protocol';
import './styles.css';

/**
 * The product owner's view of a backlog. Deliberately hides everything that
 * belongs to the machine — refs, content hashes, YAML, file paths — and shows
 * only what somebody planning delivery needs to judge and change.
 */

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage) => vscode.postMessage(msg);

const EMPTY: PanelState = {
  view: 'setup',
  setup: {
    baseUrl: '',
    email: '',
    projectKey: '',
    epicIssueType: 'Epic',
    storyIssueType: 'Story',
    modelFamily: '',
    llmProvider: 'copilot',
    transport: 'rest',
    mcpEndpoint: '',
    hasAnthropicKey: false,
    profile: 'restricted',
    availableTransports: ['rest'],
    availableLlmProviders: ['copilot'],
    storageFolder: '',
  storageLocation: '',
    hasToken: false,
    hasWorkspace: false,
    complete: false,
    atlassian: { state: 'unknown', detail: '' },
    model: { state: 'unknown', detail: '' }
  },
  recent: [],
  backlog: undefined,
  slug: undefined,
  busy: false,
  busyLabel: '',
  plan: undefined,
  notice: undefined,
  pendingRefine: undefined,
  jiraBrowseBase: '',
  undoLabel: undefined,
  redoLabel: undefined,
  quality: undefined,
  criteria: [],
  reviewers: [],
  observations: [],
  conflicts: [],
  lastPanelRun: undefined,
  canCheckExisting: false,
  duplicates: undefined,
  improveReport: undefined,
  rubric: { threshold: 70, enforcement: 'label', requireReview: false, source: 'default' }
};

/* ------------------------------------------------------------- primitives */

/** Beyond this a field scrolls internally rather than growing without bound. */
const MAX_GROW_PX = 420;

/**
 * Textarea that grows with its content, so nothing hides behind a scrollbar.
 *
 * Two non-obvious details, both learned the hard way:
 *  - Measuring synchronously on mount can catch the element before CSS width
 *    has settled, at its default 20-column size, where every character wraps
 *    to its own line and a 1000-character field measures ~17000px. Measure on
 *    the next frame instead.
 *  - The result is clamped regardless, so no future mis-measurement can blow
 *    the layout apart.
 */
function Grow(props: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastWidth = useRef(0);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const content = el.scrollHeight + 2;
    const next = Math.min(content, MAX_GROW_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = content > next ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(resize);
    return () => cancelAnimationFrame(raf);
  }, [props.value, resize]);

  // Re-measure when the panel is resized. Width only: reacting to our own
  // height changes would loop.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w !== lastWidth.current) {
        lastWidth.current = w;
        resize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resize]);

  return (
    <textarea
      ref={ref}
      value={props.value}
      placeholder={props.placeholder}
      rows={props.rows ?? 1}
      onChange={(e) => {
        props.onChange(e.target.value);
        resize();
      }}
    />
  );
}

const PRIORITIES = ['Must', 'Should', 'Could'] as const;

function PriorityPicker(props: { value: string; onChange: (v: 'Must' | 'Should' | 'Could') => void }) {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value as 'Must' | 'Should' | 'Could')}>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </select>
  );
}

function Field(props: { label: string; hint?: string; name?: string; children: React.ReactNode }) {
  return (
    <div className="field" data-field={props.name}>
      <label>
        {props.label} {props.hint && <span className="hint">— {props.hint}</span>}
      </label>
      {props.children}
    </div>
  );
}

const LINK_TYPES = ['design', 'spec', 'reference'] as const;
type LinkType = (typeof LINK_TYPES)[number];
interface ItemLinkView {
  type: LinkType;
  label: string;
  url: string;
}

function LinkEditor(props: { items: ItemLinkView[]; onChange: (v: ItemLinkView[]) => void }) {
  const set = (i: number, patch: Partial<ItemLinkView>) =>
    props.onChange(props.items.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <>
      {props.items.map((link, i) => {
        const openable = /^https?:\/\//i.test(link.url.trim());
        return (
          <div className="row" key={i}>
            <select
              style={{ width: 110, flex: 'none' }}
              value={link.type}
              onChange={(e) => set(i, { type: e.target.value as LinkType })}
            >
              {LINK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              style={{ flex: 1 }}
              value={link.label}
              placeholder="What is at the other end"
              onChange={(e) => set(i, { label: e.target.value })}
            />
            <input
              style={{ flex: 2 }}
              value={link.url}
              placeholder="https://www.figma.com/file/…"
              onChange={(e) => set(i, { url: e.target.value })}
            />
            <button
              className="ghost"
              disabled={!openable}
              title={openable ? 'Open' : 'Only http and https links can be opened'}
              onClick={() => post({ type: 'openExternal', url: link.url })}
            >
              ↗
            </button>
            <button className="ghost danger" title="Remove" onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        );
      })}
      <button className="ghost" onClick={() => props.onChange([...props.items, { type: 'design', label: '', url: '' }])}>
        + Add link
      </button>
    </>
  );
}

function ListEditor(props: { items: string[]; onChange: (v: string[]) => void; placeholder: string; addLabel: string }) {
  const set = (i: number, v: string) => props.onChange(props.items.map((x, j) => (j === i ? v : x)));
  return (
    <>
      {props.items.map((item, i) => (
        <div className="row" key={i}>
          <Grow value={item} onChange={(v) => set(i, v)} placeholder={props.placeholder} />
          <button
            className="ghost danger"
            title="Remove"
            onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button className="ghost" onClick={() => props.onChange([...props.items, ''])}>
        + {props.addLabel}
      </button>
    </>
  );
}

function AcEditor(props: { items: AcceptanceCriterion[]; onChange: (v: AcceptanceCriterion[]) => void }) {
  const set = (i: number, patch: Partial<AcceptanceCriterion>) =>
    props.onChange(props.items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <>
      {props.items.map((ac, i) => (
        <div className="ac" key={i}>
          {(['given', 'when', 'then'] as const).map((k) => (
            <div className="ac-line" key={k}>
              <div className="kw">{k}</div>
              <Grow value={ac[k]} onChange={(v) => set(i, { [k]: v } as Partial<AcceptanceCriterion>)} />
              {k === 'given' && (
                <button
                  className="ghost danger"
                  title="Remove this criterion"
                  onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
      <button
        className="ghost"
        onClick={() => props.onChange([...props.items, { given: '', when: '', then: '' }])}
      >
        + Add acceptance criterion
      </button>
    </>
  );
}

/* ---------------------------------------------------------------- locating */

/**
 * Scrolls to the field a finding is about and flashes it.
 *
 * Scoped by the owning item, and matches are filtered to those whose nearest
 * [data-item] ancestor is that container. Epics and stories both have a
 * "title" field, so if the containers are ever nested — moving the stories
 * inside the epic container would do it — an unscoped query would silently
 * jump to the wrong one.
 */
function locateField(itemKey: string, field: string): void {
  const container = document.querySelector(`[data-item="${itemKey}"]`);
  if (!container) return;

  const target = [...container.querySelectorAll(`[data-field="${field}"]`)].find(
    (el) => el.closest('[data-item]') === container
  ) as HTMLElement | undefined;
  if (!target) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash');
  // Force a reflow so the animation restarts when the same field is clicked twice.
  void target.offsetWidth;
  target.classList.add('flash');
  window.setTimeout(() => target.classList.remove('flash'), 1600);

  const input = target.querySelector('input, textarea') as HTMLElement | null;
  input?.focus({ preventScroll: true });
}

/* ----------------------------------------------------------------- quality */

function scoreClass(q: ItemQuality | undefined): string {
  if (!q || q.deterministicOnly) return 'unknown';
  if (!q.passed) return 'fail';
  return q.score >= 85 ? 'good' : 'pass';
}

/** Compact score pill. Shows blocker count rather than a score when blocked. */
function ScorePill({ quality }: { quality: ItemQuality | undefined }) {
  if (!quality) return null;
  if (quality.blockedBy.length > 0) {
    return (
      <span className="pill fail" title={quality.blockedBy.map((b) => b.message).join('\n')}>
        {quality.blockedBy.length} blocker{quality.blockedBy.length > 1 ? 's' : ''}
      </span>
    );
  }
  if (quality.deterministicOnly) {
    return (
      <span className="pill unknown" title="Not checked yet">
        not checked
      </span>
    );
  }
  return (
    <span
      className={`pill ${scoreClass(quality)}`}
      title={`${quality.score} of 100, threshold ${quality.threshold}`}
    >
      {quality.score}
    </span>
  );
}

/** Full breakdown: every criterion, its rating, why, and what would fix it. */
/**
 * Two reviewers pulling the same item in opposite directions.
 *
 * Shown as a decision rather than a defect: there is no "fix" button, because
 * neither side is wrong and picking one is the PO's call. That is the entire
 * reason the panel surfaces conflicts instead of quietly resolving them.
 */
function ConflictCard({
  conflict,
  nameOf
}: {
  conflict: Conflict;
  nameOf: (id: string) => string;
}) {
  return (
    <div className="conflict">
      <div className="conflict-head">
        <span className="badge skip">needs your call</span>
        <strong>
          {nameOf(conflict.between[0])} and {nameOf(conflict.between[1])} disagree
        </strong>
      </div>
      <div className="conflict-sides">
        {[0, 1].map((i) => (
          <div className="conflict-side" key={i}>
            <div className="conflict-who">{nameOf(conflict.between[i])}</div>
            <div>{conflict.positions[i]}</div>
          </div>
        ))}
      </div>
      <div className="conflict-tradeoff">{conflict.tradeoff}</div>
    </div>
  );
}

function QualityPanel({
  quality,
  criteria,
  reviewers,
  observations,
  conflicts,
  busy,
  onFix,
  onReview,
  onWaive,
  onUnwaive,
  onAccept,
  onRevoke,
  onLocate
}: {
  quality: ItemQuality | undefined;
  criteria: CriterionDef[];
  reviewers: PanelState['reviewers'];
  observations: Observation[];
  conflicts: Conflict[];
  busy: boolean;
  onFix: () => void;
  onReview: () => void;
  onWaive: (ruleId: string) => void;
  onUnwaive: (ruleId: string) => void;
  onAccept: () => void;
  onRevoke: () => void;
  onLocate: (field: string) => void;
}) {
  if (!quality) return null;
  const hasFindings = quality.blockedBy.length > 0 || quality.warnings.length > 0;
  // Falls back to the id so a finding from a reviewer this build no longer has
  // still reads as something rather than disappearing.
  const nameOf = (id: string) => reviewers.find((r) => r.id === id)?.name ?? id;

  // Filtering here rather than at each call site: `quality` already identifies
  // the item, so callers cannot get the two out of step.
  const mine = (f: { level: string; ref: string }) => f.level === quality.level && f.ref === quality.ref;
  const myObservations = observations.filter(mine);
  const myConflicts = conflicts.filter(mine);

  return (
    <>
      <div className="section-head">
        <h2>Quality</h2>
        <ScorePill quality={quality} />
        {!quality.deterministicOnly && (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            threshold {quality.threshold} · {quality.passed ? 'ready' : 'not ready'}
          </span>
        )}
        <div className="spacer" />
        {hasFindings && (
          <button disabled={busy} onClick={onFix} title="Rewrite this item to address the findings below">
            Fix with AI
          </button>
        )}
        {!quality.passed && quality.blockedBy.length === 0 && !quality.acceptedBelowThreshold && (
          <button
            disabled={busy}
            onClick={onAccept}
            title="Send this anyway, recording why"
          >
            Accept anyway
          </button>
        )}
        <button disabled={busy} onClick={onReview}>
          {quality.deterministicOnly ? 'Review quality' : 'Re-review'}
        </button>
      </div>

      {quality.acceptedBelowThreshold && (
        <div className="finding accepted">
          <span className="badge skip">accepted</span>
          <span>
            Sent despite scoring {quality.score} — “{quality.acceptedBelowThreshold.reason}”
          </span>
          <button className="ghost" onClick={onRevoke} title="Withdraw this acceptance">
            undo
          </button>
        </div>
      )}

      {/* A conflict is the one thing here nobody else can decide, so it sits
          above the findings rather than below them. */}
      {myConflicts.map((c, i) => (
        <ConflictCard conflict={c} nameOf={nameOf} key={`conflict-${i}`} />
      ))}

      {[...quality.blockedBy, ...quality.warnings].map((f) => (
        <div className={`finding ${f.severity}`} key={f.ruleId}>
          <span className={`badge ${f.severity === 'blocker' ? 'create' : 'skip'}`} style={f.severity === 'blocker' ? { background: 'var(--red)' } : undefined}>
            {f.severity}
          </span>
          {/* Clicking a finding takes you to the field it is about — the
              fastest manual fix is usually to edit the thing directly. */}
          {f.field ? (
            <button className="link-finding" onClick={() => onLocate(f.field!)} title="Go to this field">
              {f.message}
            </button>
          ) : (
            <span style={{ flex: 1 }}>{f.message}</span>
          )}
          {/* The manual path: a rule that does not apply here can be dismissed
              with a reason, rather than being disabled for the whole project. */}
          <button className="ghost" title="This check does not apply here" onClick={() => onWaive(f.ruleId)}>
            dismiss
          </button>
        </div>
      ))}

      {/* Things a reviewer noticed that the rubric has no number for. Attributed,
          because "the Test reviewer says there is no empty-state criterion"
          carries weight that an anonymous warning does not. */}
      {myObservations.map((o, i) => (
        <div className={`finding ${o.severity} observation`} key={`obs-${i}`}>
          <span className="badge skip">{nameOf(o.reviewerId)}</span>
          {o.field ? (
            <button className="link-finding" onClick={() => onLocate(o.field!)} title="Go to this field">
              {o.message}
            </button>
          ) : (
            <span style={{ flex: 1 }}>{o.message}</span>
          )}
        </div>
      ))}

      {quality.waived.map((f) => (
        <div className="finding waived" key={`waived-${f.ruleId}`}>
          <span className="badge skip">dismissed</span>
          <span style={{ flex: 1 }}>
            {f.message} {f.reason && <em>— “{f.reason}”</em>}
          </span>
          <button className="ghost" title="Reinstate this check" onClick={() => onUnwaive(f.ruleId)}>
            restore
          </button>
        </div>
      ))}

      {quality.deterministicOnly ? (
        <p style={{ color: 'var(--muted)', marginTop: 12 }}>
          Not checked yet. Checking rates it against{' '}
          {quality.level === 'story' ? 'INVEST' : 'the epic criteria'}.
        </p>
      ) : (
        <div className="criteria">
          {quality.criteria.map((c) => {
            const def = criteria.find((d) => d.id === c.id);
            return (
              <div className="criterion" key={c.id}>
                {/* Three ticks, filled to the rating: 0 shows none, 3 shows all. */}
                <div className="rating" title={`${c.rating} of 3`}>
                  {[1, 2, 3].map((n) => (
                    <span key={n} className={`tick ${n <= c.rating ? `on r${c.rating}` : ''}`} />
                  ))}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div>
                    <strong>{def?.name ?? c.id}</strong>{' '}
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>{def?.standard}</span>
                    {/* Only present when a panel produced the rating. The
                        restricted build has one reviewer and nothing to
                        attribute, so the same markup renders correctly there. */}
                    {'reviewerId' in c && (c as { reviewerId?: string }).reviewerId && (
                      <span className="attribution" title="The reviewer that rated this criterion">
                        {nameOf((c as { reviewerId: string }).reviewerId)}
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'var(--muted)' }}>{c.justification}</div>
                  {c.suggestion && c.rating < 3 && (
                    <div style={{ marginTop: 2 }}>
                      <span style={{ color: 'var(--muted)' }}>Suggested: </span>
                      {c.suggestion}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}


/* --------------------------------------------------------------- next step */

/**
 * What to do next, decided here rather than by the person using it.
 *
 * The panel accumulated eight header controls, and a product owner had to know
 * the order to use them in — check, then fix, then send. That order is knowable
 * from the state, so the panel states it and offers one button. Everything else
 * stays reachable but stops competing for attention.
 */
function nextStep(state: PanelState, pending: number):
  | { label: string; why: string; msg: WebviewMessage }
  | undefined {
  const q = state.quality;
  if (!state.backlog?.epics.length) return undefined;

  if (q && q.unassessed > 0) {
    return {
      label: `Check quality (${q.unassessed})`,
      why: `${q.unassessed} item${q.unassessed === 1 ? ' has' : 's have'} not been checked yet.`,
      msg: { type: 'deepReview' }
    };
  }
  if (q && q.failed > 0) {
    return {
      label: `Fix ${q.failed} item${q.failed === 1 ? '' : 's'}`,
      why: `${q.failed} item${q.failed === 1 ? ' needs' : 's need'} work. ReqForge can rewrite them and check again.`,
      msg: { type: 'improve' }
    };
  }
  if (pending > 0) {
    return {
      label: `Send ${pending} to Jira`,
      why: `Everything looks good. ${pending} item${pending === 1 ? ' is' : 's are'} ready to send.`,
      msg: { type: 'previewPush', only: state.backlog.epics.map((e) => e.ref) }
    };
  }
  return undefined;
}

/* ------------------------------------------------------------ epic filtering */

type PendingFilter = 'all' | 'not-checked' | 'needs-work' | 'blocked' | 'not-sent' | 'no-stories';

const PENDING_LABEL: Record<PendingFilter, string> = {
  all: 'All epics',
  'not-checked': 'Not checked',
  'needs-work': 'Needs work',
  blocked: 'Missing something',
  'not-sent': 'Not sent',
  'no-stories': 'Without stories'
};

/**
 * Whether an epic matches a filter, taking its stories into account.
 *
 * An epic that reads perfectly but whose stories are unusable is not ready, so
 * the rail looks down a level. Without that, "needs work" would hide exactly
 * the epics somebody needs to open.
 */
function epicMatches(
  epic: EpicItem,
  filter: PendingFilter,
  qualityFor: (level: 'epic' | 'story', ref: string) => ItemQuality | undefined
): boolean {
  if (filter === 'all') return true;
  if (filter === 'no-stories') return epic.stories.length === 0;

  const all = [qualityFor('epic', epic.ref), ...epic.stories.map((s) => qualityFor('story', s.ref))].filter(
    Boolean
  ) as ItemQuality[];

  switch (filter) {
    case 'not-checked':
      return all.length === 0 || all.some((q) => q.deterministicOnly);
    case 'needs-work':
      return all.some((q) => !q.passed && !q.deterministicOnly && q.blockedBy.length === 0);
    case 'blocked':
      return all.some((q) => q.blockedBy.length > 0);
    case 'not-sent':
      return (
        statusOf(epic, qualityFor('epic', epic.ref)) !== 'synced' ||
        epic.stories.some((s) => statusOf(s, qualityFor('story', s.ref)) !== 'synced')
      );
  }
}

/* ------------------------------------------------------------------ status */

type Status = SyncStatus;

/**
 * `quality.assessedHash` is the item's fingerprint as of this render, so it is
 * what `pushedHash` must be compared against. Without it an item edited after
 * a push reads as synced — the one case where sending matters most.
 */
function statusOf(item: { sync: { jiraKey?: string; pushedHash?: string } }, quality?: ItemQuality): Status {
  return syncStatus(item.sync, quality?.assessedHash ?? '');
}

const STATUS_LABEL: Record<Status, string> = {
  new: 'Not in Jira yet',
  edited: 'Changed since last sent',
  synced: 'In Jira'
};

/* -------------------------------------------------------------- epic detail */

function StoryCard(props: {
  story: StoryItem;
  jiraBase: string;
  busy: boolean;
  quality: ItemQuality | undefined;
  criteria: CriterionDef[];
  reviewers: PanelState['reviewers'];
  observations: Observation[];
  conflicts: Conflict[];
  onChange: (s: StoryItem) => void;
  onDelete: () => void;
  onRefine: (instruction: string) => void;
  onFix: () => void;
  onReview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [instruction, setInstruction] = useState('');
  const s = props.story;
  const status = statusOf(s, props.quality);
  const patch = (p: Partial<StoryItem>) => props.onChange({ ...s, ...p });

  return (
    <div className="story">
      <div className="story-head" onClick={() => setOpen(!open)}>
        <span className={`dot ${status}`} title={STATUS_LABEL[status]} />
        <span className="title">{s.title || 'Untitled story'}</span>
        <ScorePill quality={props.quality} />
        <span className="chip">{s.points} pts</span>
        {s.sync.jiraKey && (
          <a
            className="chip link"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: 'openExternal', url: `${props.jiraBase}/browse/${s.sync.jiraKey}` });
            }}
          >
            {s.sync.jiraKey}
          </a>
        )}
        <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="story-body" data-item={`story:${s.ref}`}>
          <Field label="Title" name="title">
            <Grow value={s.title} onChange={(v) => patch({ title: v })} />
          </Field>

          <Field label="User story" name="narrative">
            <div className="row">
              <div className="kw" style={{ width: 60 }}>As a</div>
              <Grow value={s.narrative.asA} onChange={(v) => patch({ narrative: { ...s.narrative, asA: v } })} />
            </div>
            <div className="row">
              <div className="kw" style={{ width: 60 }}>I want</div>
              <Grow value={s.narrative.iWant} onChange={(v) => patch({ narrative: { ...s.narrative, iWant: v } })} />
            </div>
            <div className="row">
              <div className="kw" style={{ width: 60 }}>So that</div>
              <Grow value={s.narrative.soThat} onChange={(v) => patch({ narrative: { ...s.narrative, soThat: v } })} />
            </div>
          </Field>

          <Field label="Description" hint="what a developer needs that the narrative cannot carry" name="description">
            <Grow value={s.description ?? ''} onChange={(v) => patch({ description: v })} rows={4} />
          </Field>

          <Field
            label="Acceptance criteria"
            hint="main path, at least one failure, the empty state, any permission rule"
            name="acceptanceCriteria"
          >
            <AcEditor items={s.acceptanceCriteria} onChange={(v) => patch({ acceptanceCriteria: v })} />
          </Field>

          <button className="disclosure" onClick={() => setShowAll(!showAll)}>
            <span>{showAll ? '▾' : '▸'} More detail</span>
            <span className="disclosure-hint">scope, technical notes, assumptions, links, dependencies</span>
          </button>

          {showAll && (
          <>
          <Field label="Out of scope" hint="what belongs to a sibling story" name="outOfScope">
            <ListEditor
              items={s.outOfScope ?? []}
              onChange={(v) => patch({ outOfScope: v })}
              placeholder="Something a reader would assume is here but is not"
              addLabel="Add exclusion"
            />
          </Field>

          <Field
            label="Technical notes"
            hint="constraints and systems touched — not how to build it"
            name="technicalNotes"
          >
            <ListEditor
              items={s.technicalNotes ?? []}
              onChange={(v) => patch({ technicalNotes: v })}
              placeholder="e.g. reads tokens from the payment provider; no card data stored here"
              addLabel="Add note"
            />
          </Field>

          <div className="row">
            <div style={{ flex: 1 }}>
              <Field label="Priority" name="priority">
                <PriorityPicker value={s.priority ?? 'Should'} onChange={(v) => patch({ priority: v })} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Estimate">
                <select
                  value={String(s.points)}
                  onChange={(e) => patch({ points: Number(e.target.value) as StoryItem['points'] })}
                >
                  {[1, 2, 3, 5, 8, 13].map((p) => (
                    <option key={p} value={p}>
                      {p} points
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          <Field label="Assumptions" hint="taken as true in order to proceed" name="assumptions">
            <ListEditor
              items={s.assumptions ?? []}
              onChange={(v) => patch({ assumptions: v })}
              placeholder="What are you taking as given?"
              addLabel="Add assumption"
            />
          </Field>

          <Field label="Links" hint="the design frame or spec for this story" name="links">
            <LinkEditor items={(s.links ?? []) as ItemLinkView[]} onChange={(v) => patch({ links: v })} />
          </Field>

          <Field label="Depends on" hint="other stories that must land first — fewer is better" name="dependsOn">
            <ListEditor
              items={s.dependsOn ?? []}
              onChange={(v) => patch({ dependsOn: v })}
              placeholder="Another story this one needs"
              addLabel="Add dependency"
            />
          </Field>

          {s.openQuestions.length > 0 && (
            <Field label="Open questions" hint="answer these before the story is ready" name="openQuestions">
              <ListEditor
                items={s.openQuestions}
                onChange={(v) => patch({ openQuestions: v })}
                placeholder="What still needs deciding?"
                addLabel="Add question"
              />
            </Field>
          )}

          <QualityPanel
            quality={props.quality}
            criteria={props.criteria}
            reviewers={props.reviewers}
            observations={props.observations}
            conflicts={props.conflicts}
            busy={props.busy}
            onFix={props.onFix}
            onReview={props.onReview}
            onWaive={(ruleId) => post({ type: 'waiveFinding', level: 'story', ref: s.ref, ruleId })}
            onUnwaive={(ruleId) => post({ type: 'unwaiveFinding', level: 'story', ref: s.ref, ruleId })}
            onAccept={() => post({ type: 'acceptBelowThreshold', level: 'story', ref: s.ref })}
            onRevoke={() => post({ type: 'revokeAcceptance', level: 'story', ref: s.ref })}
            onLocate={(field) => locateField(`story:${s.ref}`, field)}
          />

          </>
          )}

          <div className="refine">
            <input
              value={instruction}
              placeholder="Ask for a change — e.g. add criteria for the error states"
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && instruction.trim()) {
                  props.onRefine(instruction.trim());
                  setInstruction('');
                }
              }}
            />
            <button
              disabled={props.busy || !instruction.trim()}
              onClick={() => {
                props.onRefine(instruction.trim());
                setInstruction('');
              }}
            >
              Rewrite
            </button>
            <button className="ghost danger" onClick={props.onDelete}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EpicDetail(props: {
  epic: EpicItem;
  jiraBase: string;
  busy: boolean;
  quality: ItemQuality | undefined;
  qualityFor: (level: 'epic' | 'story', ref: string) => ItemQuality | undefined;
  criteria: CriterionDef[];
  reviewers: PanelState['reviewers'];
  observations: Observation[];
  conflicts: Conflict[];
  sourceKind: 'confluence' | 'jira';
  onFix: (level: 'epic' | 'story', ref: string) => void;
  onReview: () => void;
  onChange: (e: EpicItem) => void;
  onDelete: () => void;
  onRefine: (level: 'epic' | 'story', ref: string, instruction: string) => void;
  onGenerateStories: () => void;
  onAddStory: () => void;
  onDeleteStory: (ref: string) => void;
  storiesNeedingWorkOnly: boolean;
  onToggleStoryFilter: (value: boolean) => void;
}) {
  const e = props.epic;
  const sourceKind = props.sourceKind;
  const [instruction, setInstruction] = useState('');
  // Fourteen fields at once is a form, not a review. Five carry the decisions a
  // product owner actually makes; the rest are there when wanted.
  const [showAll, setShowAll] = useState(false);
  const status = statusOf(e, props.quality);
  const patch = (p: Partial<EpicItem>) => props.onChange({ ...e, ...p });
  const points = e.stories.reduce((n, s) => n + s.points, 0);

  const storyNeedsWork = (ref: string) => {
    const q = props.qualityFor('story', ref);
    return !q || q.deterministicOnly || !q.passed;
  };
  const needingWork = e.stories.filter((s) => storyNeedsWork(s.ref)).length;
  const visibleStories = props.storiesNeedingWorkOnly ? e.stories.filter((s) => storyNeedsWork(s.ref)) : e.stories;

  return (
    <>
      <div data-item={`epic:${e.ref}`} className="issue">
      <div className="issue-main">

      {/* Breadcrumb and title, as an issue page opens. */}
      <div className="issue-crumb">
        <span>Epic</span>
        {e.sync.jiraKey && (
          <>
            <span>/</span>
            <a className="crumb-link" onClick={() => post({ type: 'openExternal', url: `${props.jiraBase}/browse/${e.sync.jiraKey}` })}>
              {e.sync.jiraKey} ↗
            </a>
          </>
        )}
      </div>

      <input
        className="issue-title"
        value={e.title}
        placeholder="Untitled epic"
        onChange={(ev) => patch({ title: ev.target.value })}
      />

      <Field label="Outcome" hint="what is true once this ships, in business terms" name="outcome">
        <Grow value={e.outcome} onChange={(v) => patch({ outcome: v })} />
      </Field>

      <Field label="Description">
        <Grow value={e.description} onChange={(v) => patch({ description: v })} rows={4} />
      </Field>

      <Field label="Acceptance criteria" name="acceptanceCriteria">
        <AcEditor items={e.acceptanceCriteria} onChange={(v) => patch({ acceptanceCriteria: v })} />
      </Field>

      <button className="disclosure" onClick={() => setShowAll(!showAll)}>
        <span>{showAll ? '▾' : '▸'} More detail</span>
        <span className="disclosure-hint">
          success measures, scope, non-functional requirements, assumptions, links, dependencies
        </span>
      </button>

      {showAll && (
      <>
      <Field label="Success measures" hint="how you would know the outcome happened" name="successMeasures">
        <ListEditor
          items={e.successMeasures ?? []}
          onChange={(v) => patch({ successMeasures: v })}
          placeholder="e.g. call volume down 40% against the pre-launch baseline"
          addLabel="Add measure"
        />
      </Field>

      <Field label="In scope">
        <ListEditor
          items={e.inScope}
          onChange={(v) => patch({ inScope: v })}
          placeholder="Something this epic delivers"
          addLabel="Add"
        />
      </Field>

      <Field label="Out of scope" hint="the cheapest way to prevent scope drift" name="outOfScope">
        <ListEditor
          items={e.outOfScope}
          onChange={(v) => patch({ outOfScope: v })}
          placeholder="Something this epic explicitly does not cover"
          addLabel="Add"
        />
      </Field>

      <Field
        label="Non-functional requirements"
        hint="performance, availability, accessibility, security"
        name="nonFunctional"
      >
        <ListEditor
          items={e.nonFunctional ?? []}
          onChange={(v) => patch({ nonFunctional: v })}
          placeholder="e.g. dashboard interactive within 2s at the 95th percentile"
          addLabel="Add requirement"
        />
      </Field>

      <Field label="Links" hint="design files, specs, decision records" name="links">
        <LinkEditor items={(e.links ?? []) as ItemLinkView[]} onChange={(v) => patch({ links: v })} />
      </Field>

      <Field label="Assumptions" hint="taken as true in order to proceed — not the same as an open question" name="assumptions">
        <ListEditor
          items={e.assumptions ?? []}
          onChange={(v) => patch({ assumptions: v })}
          placeholder="e.g. member email addresses in the system of record are accurate"
          addLabel="Add assumption"
        />
      </Field>

      {e.openQuestions.length > 0 && (
        <Field label="Open questions" hint="answer these before planning" name="openQuestions">
          <ListEditor
            items={e.openQuestions}
            onChange={(v) => patch({ openQuestions: v })}
            placeholder="What still needs deciding?"
            addLabel="Add question"
          />
        </Field>
      )}

      </>
      )}

      {showAll && e.sourceEvidence.length > 0 && (
        <Field
          label={sourceKind === 'jira' ? 'Evidence' : 'Evidence from the source document'}
          hint="quoted when this epic was created, and not rewritten since"
          name="sourceEvidence"
        >
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)' }}>
            {e.sourceEvidence.map((q, i) => (
              <li key={i}>“{q}”</li>
            ))}
          </ul>
        </Field>
      )}

      <QualityPanel
        quality={props.quality}
        criteria={props.criteria}
        reviewers={props.reviewers}
        observations={props.observations}
        conflicts={props.conflicts}
        busy={props.busy}
        onFix={() => props.onFix('epic', e.ref)}
        onReview={props.onReview}
        onWaive={(ruleId) => post({ type: 'waiveFinding', level: 'epic', ref: e.ref, ruleId })}
        onUnwaive={(ruleId) => post({ type: 'unwaiveFinding', level: 'epic', ref: e.ref, ruleId })}
        onAccept={() => post({ type: 'acceptBelowThreshold', level: 'epic', ref: e.ref })}
        onRevoke={() => post({ type: 'revokeAcceptance', level: 'epic', ref: e.ref })}
        onLocate={(field) => locateField(`epic:${e.ref}`, field)}
      />

      <div className="refine">
        <input
          value={instruction}
          placeholder="Ask for a change — e.g. split out the migration work"
          onChange={(ev) => setInstruction(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && instruction.trim()) {
              props.onRefine('epic', e.ref, instruction.trim());
              setInstruction('');
            }
          }}
        />
        <button
          disabled={props.busy || !instruction.trim()}
          onClick={() => {
            props.onRefine('epic', e.ref, instruction.trim());
            setInstruction('');
          }}
        >
          Rewrite
        </button>
        <button className="ghost danger" onClick={props.onDelete}>
          Delete epic
        </button>
      </div>

      <div className="section-head">
        <h2>Child issues</h2>
        {needingWork > 0 && (
          <button
            className="ghost"
            title="Show only stories that are below the threshold or not yet reviewed"
            onClick={() => props.onToggleStoryFilter(!props.storiesNeedingWorkOnly)}
          >
            {props.storiesNeedingWorkOnly ? `showing ${needingWork} needing work` : `${needingWork} need work`}
          </button>
        )}
        <div className="spacer" />
        <button className="ghost" onClick={props.onAddStory}>
          + Add manually
        </button>
        <button disabled={props.busy} onClick={props.onGenerateStories}>
          {e.stories.length ? 'Regenerate stories' : 'Generate stories'}
        </button>
      </div>

      {e.stories.length === 0 && (
        <p style={{ color: 'var(--muted)' }}>
          No stories yet. Generate them, or add one by hand.
        </p>
      )}

      {visibleStories.map((s) => (
        <StoryCard
          key={s.ref}
          story={s}
          jiraBase={props.jiraBase}
          reviewers={props.reviewers}
          observations={props.observations}
          conflicts={props.conflicts}
          busy={props.busy}
          quality={props.qualityFor('story', s.ref)}
          criteria={props.criteria}
          onChange={(next) => patch({ stories: e.stories.map((x) => (x.ref === s.ref ? next : x)) })}
          onDelete={() => props.onDeleteStory(s.ref)}
          onRefine={(instr) => props.onRefine('story', s.ref, instr)}
          onFix={() => props.onFix('story', s.ref)}
          onReview={props.onReview}
        />
      ))}

      </div>

      {/*
        The details sidebar, where Jira keeps the same things: status, priority,
        estimate, links. Putting them here rather than inline among the prose is
        most of what makes this read as an issue rather than a form.
      */}
      <aside className="issue-side">
        <div className="side-head">Details</div>
        <dl className="side-list">
          <dt>Status</dt>
          <dd>
            <span className={`lozenge ${status}`}>{STATUS_LABEL[status]}</span>
          </dd>

          <dt>Quality</dt>
          <dd>
            <ScorePill quality={props.quality} />
          </dd>

          <dt>Priority</dt>
          <dd>
            <PriorityPicker value={e.priority ?? 'Should'} onChange={(v) => patch({ priority: v })} />
          </dd>

          <dt>Size</dt>
          <dd>
            <select value={e.sizing} onChange={(ev) => patch({ sizing: ev.target.value as EpicItem['sizing'] })}>
              {(['S', 'M', 'L', 'XL'] as const).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </dd>

          <dt>Child issues</dt>
          <dd>{e.stories.length}</dd>

          {points > 0 && (
            <>
              <dt>Points</dt>
              <dd>{points}</dd>
            </>
          )}

          {e.sync.jiraKey && (
            <>
              <dt>Issue</dt>
              <dd>
                <a
                  className="crumb-link"
                  onClick={() => post({ type: 'openExternal', url: `${props.jiraBase}/browse/${e.sync.jiraKey}` })}
                >
                  {e.sync.jiraKey} ↗
                </a>
              </dd>
            </>
          )}
        </dl>
      </aside>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ setup */

function StatusLine({ label, probe }: { label: string; probe: { state: string; detail: string } }) {
  const colour =
    probe.state === 'ok' ? 'var(--green)' : probe.state === 'failed' ? 'var(--red)' : 'var(--muted)';
  const text = probe.state === 'unknown' ? 'Not checked yet' : probe.detail;
  // The MCP check answers with a summary line followed by a table of which
  // server tool satisfied which operation. The table needs fixed-width
  // alignment and its own horizontal scroll; the summary needs to wrap. Sharing
  // one scroll box clips the sentence you read first.
  const [summary, ...table] = text.split('\n');
  return (
    <div className="row" style={{ alignItems: 'baseline' }}>
      <span style={{ width: 90, flex: 'none', color: 'var(--muted)', fontSize: 12 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: colour }}>{summary}</span>
        {table.length > 0 && <pre className="probe-detail">{table.join('\n')}</pre>}
      </div>
    </div>
  );
}

/**
 * First-run setup. Until this is complete the rest of the panel is unreachable
 * — half-configured tools fail later, in the middle of real work, with errors
 * that read as bugs.
 */
function Setup({ state }: { state: PanelState }) {
  const s = state.setup;
  const [form, setForm] = useState({
    baseUrl: s.baseUrl,
    email: s.email,
    projectKey: s.projectKey,
    epicIssueType: s.epicIssueType,
    storyIssueType: s.storyIssueType,
    modelFamily: s.modelFamily,
    mcpEndpoint: s.mcpEndpoint
  });

  // Adopt host values when they change underneath us (e.g. the token prompt or storage folder selection).
  useEffect(() => {
    setForm({
      baseUrl: s.baseUrl,
      email: s.email,
      projectKey: s.projectKey,
      epicIssueType: s.epicIssueType,
      storyIssueType: s.storyIssueType,
      modelFamily: s.modelFamily,
      mcpEndpoint: s.mcpEndpoint
    });
  }, [s.baseUrl, s.email, s.projectKey, s.epicIssueType, s.storyIssueType, s.modelFamily, s.mcpEndpoint]);

  // Takes the full patch type, not just the locally-edited fields: the
  // transport and provider selects write settings without a form entry, since
  // they read straight from host state.
  const save = (patch: SettingsPatch) => {
    setForm((f) => ({ ...f, ...patch }) as typeof f);
    post({ type: 'saveSettings', patch });
  };

  const missing = [
    !form.baseUrl && 'Atlassian site',
    !form.email && 'account email',
    !s.hasToken && 'API token',
    !form.projectKey && 'Jira project',
    !s.hasWorkspace && !s.storageFolder && 'storage folder'
  ].filter(Boolean) as string[];

  return (
    <div className="detail" style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Set up ReqForge</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        ReqForge reads requirements from Confluence and writes epics and stories to Jira. It needs to know
        where those live and who it should act as.
      </p>

      {!s.complete && missing.length > 0 && (
        <div className="notice warn" style={{ borderRadius: 6, border: '1px solid var(--border)' }}>
          <div className="msg">
            Still needed: <strong>{missing.join(', ')}</strong>
            <div className="hint">Everything else stays locked until these are filled in.</div>
          </div>
        </div>
      )}

      <div className="section-head">
        <h2>Atlassian</h2>
      </div>

      <Field label="Site" hint="the address you use to open Jira in a browser">
        <input
          value={form.baseUrl}
          placeholder="https://yourcompany.atlassian.net"
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          onBlur={(e) => save({ baseUrl: e.target.value })}
        />
      </Field>

      <Field label="Account email" hint="the account the API token belongs to">
        <input
          value={form.email}
          placeholder="you@yourcompany.com"
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          onBlur={(e) => save({ email: e.target.value })}
        />
      </Field>

      <Field label="API token" hint="stored in your operating system keychain, never in a settings file">
        <div className="chip-row">
          <span className="chip" style={{ background: s.hasToken ? 'var(--green)' : 'var(--secondary)', color: s.hasToken ? '#000' : undefined }}>
            {s.hasToken ? 'Token saved' : 'No token yet'}
          </span>
          <button onClick={() => post({ type: 'setToken' })}>{s.hasToken ? 'Replace' : 'Add token'}</button>
          {s.hasToken && (
            <button className="ghost danger" onClick={() => post({ type: 'clearToken' })}>
              Remove
            </button>
          )}
          <a
            className="chip link"
            onClick={() => post({ type: 'openExternal', url: 'https://id.atlassian.com/manage-profile/security/api-tokens' })}
          >
            Create one ↗
          </a>
        </div>
      </Field>

      {s.storageLocation && (
        <Field label="Backlogs are stored in" hint="the folder ReqForge reads and writes">
          <div className="chip-row">
            <code style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>{s.storageLocation}</code>
          </div>
          {s.hasWorkspace && s.storageFolder && (
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
              A storage folder is also set ({s.storageFolder}), but the open workspace takes precedence. Anything
              saved without a workspace open is still in that folder.
            </p>
          )}
        </Field>
      )}

      <div className="section-head">
        <h2>Jira project</h2>
      </div>

      <Field label="Project key" hint="the prefix on issue numbers, e.g. ACME in ACME-123">
        <input
          value={form.projectKey}
          placeholder="ACME"
          onChange={(e) => setForm({ ...form, projectKey: e.target.value.toUpperCase() })}
          onBlur={(e) => save({ projectKey: e.target.value.toUpperCase() })}
        />
      </Field>

      <div className="row">
        <div style={{ flex: 1 }}>
          <Field label="Epic issue type">
            <input
              value={form.epicIssueType}
              onChange={(e) => setForm({ ...form, epicIssueType: e.target.value })}
              onBlur={(e) => save({ epicIssueType: e.target.value })}
            />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Story issue type" hint="some projects call this User Story">
            <input
              value={form.storyIssueType}
              onChange={(e) => setForm({ ...form, storyIssueType: e.target.value })}
              onBlur={(e) => save({ storyIssueType: e.target.value })}
            />
          </Field>
        </div>
      </div>

      {!s.hasWorkspace && (
        <>
          <div className="section-head">
            <h2>Storage Location</h2>
          </div>

          <Field
            label="Storage folder"
            hint="where backlog files are stored when no workspace is open"
          >
            <div className="chip-row">
              <span
                className="chip"
                style={{
                  background: s.storageFolder ? 'var(--green)' : 'var(--secondary)',
                  color: s.storageFolder ? '#000' : undefined,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {s.storageFolder || 'No folder selected'}
              </span>
              <button onClick={() => post({ type: 'browseStorageFolder' })}>
                {s.storageFolder ? 'Change' : 'Select Folder'}
              </button>
            </div>
          </Field>
        </>
      )}

      <div className="section-head">
        <h2>Language model</h2>
      </div>

      <Field label="Preferred model" hint="leave blank to use whichever Copilot model has the largest context">
        <input
          value={form.modelFamily}
          placeholder="(automatic)"
          onChange={(e) => setForm({ ...form, modelFamily: e.target.value })}
          onBlur={(e) => save({ modelFamily: e.target.value })}
        />
      </Field>

      {/* Only rendered when the build has more than one option. The restricted
          build has exactly one transport and one provider, so showing a
          one-item dropdown would imply a choice that does not exist. */}
      {(s.availableTransports.length > 1 || s.availableLlmProviders.length > 1) && (
        <>
          <div className="section-head">
            <h2>Connections</h2>
          </div>

          {s.availableTransports.length > 1 && (
            <Field label="Atlassian transport" hint="MCP adds Teamwork Graph search; REST cannot reach it">
              <select value={s.transport} onChange={(e) => save({ transport: e.target.value })}>
                {s.availableTransports.map((t) => (
                  <option key={t} value={t}>
                    {t === 'mcp' ? 'MCP (Teamwork Graph)' : 'REST'}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {s.transport === 'mcp' && (
            <Field
              label="MCP server"
              hint="an https:// URL, or a command line — a stdio proxy handles its own sign-in"
            >
              {/* No concrete host in the placeholder: the webview bundle is
                  shared by both profiles, so a literal Atlassian MCP domain
                  would ship inside the restricted build — which is exactly what
                  a client audit flags. The full address is in the README. */}
              <input
                value={form.mcpEndpoint}
                placeholder="npx -y mcp-remote <your MCP server URL>"
                onChange={(e) => setForm({ ...form, mcpEndpoint: e.target.value })}
                onBlur={(e) => save({ mcpEndpoint: e.target.value })}
              />
            </Field>
          )}

          {s.availableLlmProviders.length > 1 && (
            <Field label="Model provider" hint="Copilot uses your VS Code entitlement; Anthropic uses your own key">
              <select value={s.llmProvider} onChange={(e) => save({ llmProvider: e.target.value })}>
                {s.availableLlmProviders.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {s.llmProvider === 'anthropic' && (
            <Field label="Anthropic API key" hint="stored in the OS keychain, never in settings">
              <div className="row">
                <span style={{ flex: 1, color: s.hasAnthropicKey ? 'var(--green)' : 'var(--muted)' }}>
                  {s.hasAnthropicKey ? 'A key is stored.' : 'No key stored yet.'}
                </span>
                <button onClick={() => post({ type: 'setAnthropicKey' })}>
                  {s.hasAnthropicKey ? 'Replace key' : 'Set key'}
                </button>
              </div>
            </Field>
          )}
        </>
      )}

      <div className="section-head">
        <h2>Check</h2>
        <span className="build-badge" title="Which ReqForge build is installed">
          {s.profile === 'full' ? 'Studio build' : 'Restricted build'}
        </span>
        <div className="spacer" />
        <button disabled={state.busy} onClick={() => post({ type: 'testConnection' })}>
          Test connections
        </button>
      </div>

      <StatusLine label="Atlassian" probe={s.atlassian} />
      {/* Named for the provider actually configured: labelling an Anthropic
          probe "Copilot" makes a failure impossible to diagnose. */}
      <StatusLine label={s.llmProvider === 'anthropic' ? 'Anthropic' : 'Copilot'} probe={s.model} />

      <div style={{ display: 'flex', gap: 8, marginTop: 26, marginBottom: 40 }}>
        <button className="primary" disabled={!s.complete} onClick={() => post({ type: 'navigate', view: 'home' })}>
          {s.complete ? 'Done — continue' : 'Fill in the fields above to continue'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- home */

/**
 * Deliberately does not open anything on its own. The user says what they came
 * to do; nothing is fetched from Jira until they ask for it.
 */
function Home({
  state,
  onOpen,
  onDelete
}: {
  state: PanelState;
  onOpen: (slug: string) => void;
  onDelete: (slug: string) => void;
}) {
  const [issueKey, setIssueKey] = useState('');

  return (
    <div className="detail" style={{ maxWidth: 860, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>What would you like to do?</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0, marginBottom: 24 }}>
        Sending to <strong>{state.setup.projectKey}</strong> on {state.setup.baseUrl.replace(/^https?:\/\//, '')}.
      </p>

      <div className="cards">
        <div className="card">
          <h3>Start from a PRD</h3>
          <p>
            Point ReqForge at a Confluence page. It proposes a set of epics, flags what the document leaves
            unresolved, and you review everything before anything reaches Jira.
          </p>
          <button className="primary" onClick={() => post({ type: 'decompose' })}>
            Choose a Confluence page
          </button>
        </div>

        <div className="card">
          <h3>Work on an existing epic</h3>
          <p>
            Pull an epic that already exists in Jira, with its stories, into the same editor. Change it,
            check it against the rubric, generate or add stories, then send your changes back.
          </p>
          <div className="refine" style={{ marginTop: 'auto' }}>
            <input
              value={issueKey}
              placeholder={`${state.setup.projectKey || 'ACME'}-123`}
              onChange={(e) => setIssueKey(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && issueKey.trim()) post({ type: 'fetchJiraIssue', key: issueKey.trim() });
              }}
            />
            <button
              disabled={state.busy || !issueKey.trim()}
              onClick={() => post({ type: 'fetchJiraIssue', key: issueKey.trim() })}
            >
              Open
            </button>
          </div>
        </div>
      </div>

      {state.recent.length > 0 && (
        <>
          <div className="section-head">
            <h2>Pick up where you left off</h2>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>saved on this machine</span>
          </div>
          {state.recent.map((r) => (
            <div key={r.slug} className="recent" onClick={() => onOpen(r.slug)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{r.title}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {r.epics} epics · {r.stories} stories · {r.projectKey}
                </div>
              </div>
              {r.unpushed > 0 && <span className="chip">{r.unpushed} not sent</span>}
              <button
                className="ghost danger"
                title="Remove this backlog from this machine"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDelete(r.slug);
                }}
              >
                ✕
              </button>
              <span style={{ color: 'var(--muted)' }}>›</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- modals */

function RefineModal({ state }: { state: PanelState }) {
  const r = state.pendingRefine!;
  return (
    <div className="overlay">
      <div className="modal">
        <header>
          <h2>Proposed rewrite — {r.title}</h2>
        </header>
        <div className="content">
          {!r.changed && (
            <p style={{ color: 'var(--muted)' }}>
              The model did not change anything meaningful. You can discard this safely.
            </p>
          )}
          <div className="diff">
            <div className="side">
              <h3>Current</h3>
              <pre>{r.beforeMarkdown}</pre>
            </div>
            <div className="side">
              <h3>Proposed</h3>
              <pre>{r.afterMarkdown}</pre>
            </div>
          </div>
        </div>
        <footer>
          <button onClick={() => post({ type: 'discardRefine' })}>Discard</button>
          <button className="primary" onClick={() => post({ type: 'acceptRefine' })}>
            Use this version
          </button>
        </footer>
      </div>
    </div>
  );
}

function ImproveModal({ state }: { state: PanelState }) {
  const r = state.improveReport!;
  const moved = r.steps.filter((s) => s.scoreAfter > s.scoreBefore);

  return (
    <div className="overlay">
      <div className="modal">
        <header>
          <h2>Improvement run</h2>
        </header>
        <div className="content">
          <p>
            <strong>{r.passedBefore} → {r.passedAfter}</strong> items meeting the threshold ·{' '}
            <strong>{r.scoreBefore} → {r.scoreAfter}</strong> average score
          </p>
          <p style={{ color: 'var(--muted)' }}>
            {r.iterations} pass{r.iterations === 1 ? '' : 'es'}, {r.requests} model requests. {r.stopExplanation}
          </p>

          {r.steps.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>Nothing was rewritten.</p>
          ) : (
            <>
              <div className="section-head">
                <h2>What it rewrote</h2>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {moved.length} of {r.steps.length} improved
                </span>
              </div>
              {r.steps.map((s, i) => (
                <div className="plan-item" key={`${s.ref}-${i}`}>
                  <span className={`badge ${s.scoreAfter > s.scoreBefore ? 'create' : 'skip'}`}>
                    pass {s.iteration}
                  </span>
                  <span style={{ flex: 1 }}>
                    {s.title} <span style={{ color: 'var(--muted)' }}>({s.level})</span>
                  </span>
                  <span className={`pill ${s.scoreAfter > s.scoreBefore ? 'pass' : 'unknown'}`}>
                    {s.scoreBefore} → {s.scoreAfter}
                  </span>
                </div>
              ))}
            </>
          )}

          <p style={{ color: 'var(--muted)', marginTop: 18 }}>
            Nothing was sent to Jira. Every rewrite is a local edit, and one Undo reverses the whole run.
          </p>
        </div>
        <footer>
          <button className="primary" onClick={() => post({ type: 'dismissImproveReport' })}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

function PlanModal({ state, only }: { state: PanelState; only: string[] }) {
  const plan = state.plan!;
  const counts = plan.actions.reduce(
    (acc, a) => ({ ...acc, [a.verb]: acc[a.verb] + 1 }),
    { create: 0, update: 0, skip: 0 } as Record<string, number>
  );
  return (
    <div className="overlay">
      <div className="modal">
        <header>
          <h2>Send to Jira — {plan.projectKey}</h2>
        </header>
        <div className="content">
          <p>
            <strong>{counts.create}</strong> to create · <strong>{counts.update}</strong> to update ·{' '}
            <strong>{counts.skip}</strong> unchanged
          </p>

          {plan.blockingFields.length > 0 && (
            <div className="notice error" style={{ borderRadius: 6, marginBottom: 12 }}>
              <div className="msg">
                <strong>Jira requires fields ReqForge does not fill in.</strong>
                <div className="hint">
                  Creating will fail until an administrator gives these a default or makes them optional:
                  <ul>
                    {plan.blockingFields.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {plan.actions
            .filter((a) => a.level === 'epic')
            .map((a) => (
              <div key={a.ref}>
                <div className="plan-item">
                  <span className={`badge ${a.verb}`}>{a.verb === 'skip' ? 'no change' : a.verb}</span>
                  <span>
                    {a.title} {a.jiraKey && <span style={{ color: 'var(--muted)' }}>→ {a.jiraKey}</span>}
                  </span>
                </div>
                {plan.actions
                  .filter((s) => s.level === 'story' && s.parentRef === a.ref)
                  .map((s) => (
                    <div className="plan-item story" key={s.ref}>
                      <span className={`badge ${s.verb}`}>{s.verb === 'skip' ? 'no change' : s.verb}</span>
                      <span>{s.title}</span>
                    </div>
                  ))}
              </div>
            ))}
        </div>
        <footer>
          <button onClick={() => post({ type: 'dismissPlan' })}>Cancel</button>
          <button className="primary" onClick={() => post({ type: 'push', only })}>
            Send {counts.create + counts.update} to Jira
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Work that may already exist in Jira.
 *
 * Presented as reading material before a send, never as a filter over it.
 * Nothing here removes anything from a push — a PO decides whether a match
 * means "do not create this", because an issue that silently failed to appear
 * is far harder to notice than a duplicate.
 */
function DuplicatesModal({ state }: { state: PanelState }) {
  const report = state.duplicates!;
  const byEpic = new Map<string, typeof report.candidates>();
  for (const candidate of report.candidates) {
    byEpic.set(candidate.ref, [...(byEpic.get(candidate.ref) ?? []), candidate]);
  }

  return (
    <div className="overlay">
      <div className="modal">
        <header>
          <h2>Existing work in Jira</h2>
        </header>
        <div className="content">
          {!report.available ? (
            <p style={{ color: 'var(--muted)' }}>{report.unavailableReason}</p>
          ) : report.candidates.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>
              Nothing in Jira looks like it already covers this work.
            </p>
          ) : (
            <>
              <p style={{ color: 'var(--muted)' }}>
                Nothing has been skipped. Review these, then send as normal.
              </p>
              {[...byEpic].map(([ref, candidates]) => (
                <div key={ref} style={{ marginTop: 16 }}>
                  <strong>{candidates[0].title}</strong>
                  {candidates.map((c, i) => (
                    <div className="dupe" key={`${c.hit.id}-${i}`}>
                      <span className={`badge ${c.relationship}`}>{c.relationship}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div>
                          {c.hit.url ? (
                            <button
                              className="link-finding"
                              onClick={() => post({ type: 'openExternal', url: c.hit.url! })}
                            >
                              {c.hit.id} — {c.hit.title}
                            </button>
                          ) : (
                            <span>
                              {c.hit.id} — {c.hit.title}
                            </span>
                          )}
                        </div>
                        <div className="dupe-reason">{c.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
        <footer>
          <button className="primary" onClick={() => post({ type: 'dismissDuplicates' })}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- app */

function App() {
  const [state, setState] = useState<PanelState>(EMPTY);
  const [selected, setSelected] = useState<string | undefined>();
  const [showMore, setShowMore] = useState(false);
  // The rail carries what the separate list view used to: search, a readiness
  // filter, and a selection to act on in bulk.
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PendingFilter>('all');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSearch('');
    setFilter('all');
    setChosen(new Set());
  }, [state.slug]);
  const [storiesNeedingWorkOnly, setStoriesNeedingWorkOnly] = useState(false);
  // Collapsed by default: valuable, but it must not push the epics below the
  // fold on first open. The counts in the header keep it discoverable.
  const [showInsights, setShowInsights] = useState(false);
  const [draft, setDraft] = useState<EpicItem[] | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const msg = event.data;
      if (msg.type === 'state') {
        setState(msg.state);
        setDraft(undefined); // host is authoritative; local edits are flushed before actions
        const epics = msg.state.backlog?.epics ?? [];
        setSelected((cur) => (cur && epics.some((e) => e.ref === cur) ? cur : epics[0]?.ref));
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const epics = draft ?? state.backlog?.epics ?? [];

  /**
   * Local edit, then a debounced save.
   *
   * The slug travels with the message. A debounced edit that fires after the
   * user has switched to a different backlog would otherwise be applied to
   * whichever one is loaded now, writing one backlog's contents over another.
   */
  const edit = useCallback(
    (next: EpicItem[]) => {
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      const slug = state.slug;
      timer.current = setTimeout(() => post({ type: 'edit', slug, epics: next }), 400);
    },
    [state.slug]
  );

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (draft) post({ type: 'edit', slug: state.slug, epics: draft });
  }, [draft, state.slug]);

  /** Abandons a pending edit without sending it. Used when leaving a backlog. */
  const discardPending = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    setDraft(undefined);
  }, []);

  const act = useCallback(
    (msg: WebviewMessage) => {
      flush();
      post(msg);
    },
    [flush]
  );

  /**
   * Undo/redo is intercepted globally rather than deferring to the browser's
   * native textarea undo, which does not work usefully in a controlled React
   * input anyway. Pending edits are flushed first so the host's history has
   * the current text in it before it steps back.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      flush();
      post({ type: e.shiftKey ? 'redo' : 'undo' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flush]);

  /** Quality is keyed by level and ref; the host recomputes it on every state push. */
  const qualityFor = useCallback(
    (level: 'epic' | 'story', ref: string) => state.quality?.items.find((i) => i.level === level && i.ref === ref),
    [state.quality]
  );

  const current = useMemo(() => epics.find((e) => e.ref === selected), [epics, selected]);
  // Sending from the header means the whole backlog; the list view is where a
  // subset gets chosen.
  const onlyRefs = useMemo(() => epics.map((e) => e.ref), [epics]);

  const totals = useMemo(() => {
    const stories = epics.flatMap((e) => e.stories);
    // "Pending" is what a push would create or update — which includes items
    // already in Jira that have been edited since. Counting only items without
    // a key understates the work and leaves the button lying about it.
    const pending = [
      ...epics.filter((e) => statusOf(e, qualityFor('epic', e.ref)) !== 'synced'),
      ...stories.filter((s) => statusOf(s, qualityFor('story', s.ref)) !== 'synced')
    ].length;
    return {
      epics: epics.length,
      stories: stories.length,
      points: stories.reduce((n, s) => n + s.points, 0),
      pending,
      total: epics.length + stories.length
    };
  }, [epics, qualityFor]);

  const step = useMemo(() => nextStep(state, totals.pending), [state, totals.pending]);

  const filterCounts = useMemo(() => {
    const counts = {} as Record<PendingFilter, number>;
    for (const f of Object.keys(PENDING_LABEL) as PendingFilter[]) {
      counts[f] = epics.filter((e) => epicMatches(e, f, qualityFor)).length;
    }
    return counts;
  }, [epics, qualityFor]);

  const visibleEpics = useMemo(() => {
    const term = search.trim().toLowerCase();
    return epics.filter(
      (e) => epicMatches(e, filter, qualityFor) && (!term || e.title.toLowerCase().includes(term))
    );
  }, [epics, filter, search, qualityFor]);

  // Keep the open issue in the rail rather than showing something filtered out.
  useEffect(() => {
    if (visibleEpics.length === 0) return;
    if (!selected || !visibleEpics.some((e) => e.ref === selected)) setSelected(visibleEpics[0].ref);
  }, [visibleEpics, selected]);

  /* Chrome shared by every view: the notice banner, busy overlay, and a way
     back to the home screen. Setup deliberately has no escape hatch. */
  const chrome = (title: string, sub: string, actions: React.ReactNode) => (
    <div className="header">
      {state.view !== 'setup' && state.view !== 'home' && (
        <button className="ghost" title="Back" onClick={() => act({ type: 'navigate', view: 'home' })}>
          ‹ Back
        </button>
      )}
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        <div className="sub">{sub}</div>
      </div>
      <div className="spacer" />
      <div className="actions">{actions}</div>
    </div>
  );

  const banner = state.notice && (
    <div className={`notice ${state.notice.kind}`}>
      <div className="msg">
        <div>{state.notice.message}</div>
        {state.notice.hint && <div className="hint">{state.notice.hint}</div>}
      </div>
      <button className="ghost" onClick={() => post({ type: 'dismissNotice' })}>
        ✕
      </button>
    </div>
  );

  const overlay = state.busy && (
    <div className="busy">
      <div className="spinner" />
      <div>{state.busyLabel || 'Working…'}</div>
    </div>
  );

  if (state.view === 'setup') {
    return (
      <div className="app">
        {chrome('ReqForge', 'First-time setup', null)}
        {banner}
        <div className="body">
          <Setup state={state} />
        </div>
        {overlay}
      </div>
    );
  }

  if (state.view === 'home') {
    return (
      <div className="app">
        {chrome(
          'ReqForge',
          'Requirements into Jira',
          <button className="ghost" onClick={() => act({ type: 'navigate', view: 'setup' })}>
            ⚙ Settings
          </button>
        )}
        {banner}
        <div className="body">
          <Home
            state={state}
            onOpen={(slug) => act({ type: 'openBacklog', slug })}
            onDelete={(slug) => {
              discardPending();
              post({ type: 'deleteBacklog', slug });
            }}
          />
        </div>
        {overlay}
      </div>
    );
  }

  if (!state.backlog) {
    return (
      <div className="app">
        {chrome('ReqForge', '', null)}
        <div className="empty">
          <h2>Nothing loaded</h2>
          <button className="primary" onClick={() => act({ type: 'navigate', view: 'home' })}>
            Back to start
          </button>
        </div>
      </div>
    );
  }

  const b = state.backlog;

  return (
    <div className="app">
      <div className="header">
        <button className="ghost" title="Back to the start" onClick={() => act({ type: 'navigate', view: 'home' })}>
          ‹ Back
        </button>
        <div style={{ minWidth: 0 }}>
          <h1>{b.source.title}</h1>
          <div className="sub">
            {totals.epics} epics · {totals.stories} stories · {totals.points} points · sending to{' '}
            {b.target.projectKey}
          </div>
        </div>
        <div className="spacer" />
        <div className="actions">
          {step ? (
            <button className="primary" disabled={state.busy} onClick={() => act(step.msg)} title={step.why}>
              {step.label}
            </button>
          ) : (
            <span className="pill pass">Everything is ready</span>
          )}
          <button className="ghost" title="More" onClick={() => setShowMore(!showMore)}>
            ⋯
          </button>
          {showMore && (
            <div className="overflow">
              <button
                disabled={state.busy || !state.undoLabel}
                onClick={() => {
                  act({ type: 'undo' });
                  setShowMore(false);
                }}
              >
                Undo {state.undoLabel ?? ''} <span className="key">⌘Z</span>
              </button>
              <button
                disabled={state.busy || !state.redoLabel}
                onClick={() => {
                  act({ type: 'redo' });
                  setShowMore(false);
                }}
              >
                Redo <span className="key">⇧⌘Z</span>
              </button>
              <button
                disabled={state.busy || (state.quality?.unassessed ?? 0) === 0}
                onClick={() => {
                  act({ type: 'deepReview' });
                  setShowMore(false);
                }}
              >
                Check quality
              </button>
              <button
                disabled={state.busy}
                onClick={() => {
                  act({ type: 'improve' });
                  setShowMore(false);
                }}
              >
                Fix what needs work
              </button>
              <button
                disabled={state.busy || totals.pending === 0}
                onClick={() => {
                  act({ type: 'previewPush', only: onlyRefs });
                  setShowMore(false);
                }}
              >
                Send to Jira
              </button>
              <button
                onClick={() => {
                  act({ type: 'navigate', view: 'setup' });
                  setShowMore(false);
                }}
              >
                Settings
              </button>
            </div>
          )}
        </div>
      </div>

      {banner}

      {step && !state.busy && (
        <div className="guidance">
          <span>{step.why}</span>
        </div>
      )}

      {(b.prd.openQuestions.length > 0 || b.prd.risks.length > 0) && (
        <div className="insights">
          <div className="section-head" style={{ margin: 0, border: 'none', paddingBottom: 0 }}>
            <h2>{b.source.kind === 'jira' ? 'Unresolved' : 'What the document leaves unresolved'}</h2>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              {[
                b.prd.openQuestions.length ? `${b.prd.openQuestions.length} open questions` : '',
                b.prd.risks.length ? `${b.prd.risks.length} contradictions and risks` : ''
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <div className="spacer" />
            <button className="ghost" onClick={() => setShowInsights(!showInsights)}>
              {showInsights ? 'Hide' : 'Show'}
            </button>
          </div>
          {showInsights && (
            <div className="cols" style={{ marginTop: 10 }}>
              {b.prd.openQuestions.length > 0 && (
                <div className="col">
                  <h3>Open questions ({b.prd.openQuestions.length})</h3>
                  <ul>
                    {b.prd.openQuestions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              {b.prd.risks.length > 0 && (
                <div className="col">
                  <h3>Contradictions and risks ({b.prd.risks.length})</h3>
                  <ul>
                    {b.prd.risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="body">
        <div className="rail">
          <div className="rail-tools">
            <input
              className="rail-search"
              value={search}
              placeholder="Search epics…"
              onChange={(e) => setSearch(e.target.value)}
            />
            <select value={filter} onChange={(e) => setFilter(e.target.value as PendingFilter)}>
              {(Object.keys(PENDING_LABEL) as PendingFilter[]).map((f) => (
                <option key={f} value={f} disabled={f !== 'all' && filterCounts[f] === 0}>
                  {PENDING_LABEL[f]} ({filterCounts[f]})
                </option>
              ))}
            </select>
          </div>

          {visibleEpics.length === 0 && (
            <p style={{ color: 'var(--muted)', padding: '10px' }}>
              Nothing matches. {epics.length} epic{epics.length === 1 ? '' : 's'} in total.
            </p>
          )}

          {visibleEpics.map((e) => {
            const q = qualityFor('epic', e.ref);
            const st = statusOf(e, q);
            return (
              <div
                key={e.ref}
                className={`epic-row ${selected === e.ref ? 'selected' : ''}`}
                onClick={() => setSelected(e.ref)}
              >
                <input
                  type="checkbox"
                  checked={chosen.has(e.ref)}
                  title="Select for a bulk action"
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={(ev) => {
                    const next = new Set(chosen);
                    ev.target.checked ? next.add(e.ref) : next.delete(e.ref);
                    setChosen(next);
                  }}
                />
                <span className={`dot ${st}`} title={STATUS_LABEL[st]} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="title">{e.title || 'Untitled epic'}</div>
                  <div className="meta">
                    {e.priority ?? 'Should'} · {e.sizing} · {e.stories.length} stor
                    {e.stories.length === 1 ? 'y' : 'ies'}
                  </div>
                </div>
                <ScorePill quality={q} />
              </div>
            );
          })}

          <div className="rail-foot">
            <button className="ghost" onClick={() => act({ type: 'addEpic' })}>
              + Add epic
            </button>
            {visibleEpics.length > 0 && (
              <button
                className="ghost"
                onClick={() =>
                  setChosen(
                    chosen.size === visibleEpics.length ? new Set() : new Set(visibleEpics.map((e) => e.ref))
                  )
                }
              >
                {chosen.size === visibleEpics.length ? 'none' : 'select all'}
              </button>
            )}
          </div>

          {/* The bulk actions the list view used to carry, on the selection made here. */}
          {chosen.size > 0 && (
            <div className="rail-actions">
              <strong>{chosen.size} selected</strong>
              <button disabled={state.busy} onClick={() => act({ type: 'deepReview', only: [...chosen] })}>
                Check quality
              </button>
              <button disabled={state.busy} onClick={() => act({ type: 'improve', only: [...chosen] })}>
                ✦ Fix
              </button>
              <button disabled={state.busy} onClick={() => act({ type: 'generateStories', epicRefs: [...chosen] })}>
                Generate stories
              </button>
              {state.canCheckExisting && (
                <button
                  disabled={state.busy}
                  title="Look for issues in Jira that may already cover this work"
                  onClick={() => act({ type: 'checkExisting', only: [...chosen] })}
                >
                  Check existing
                </button>
              )}
              <button className="primary" disabled={state.busy} onClick={() => act({ type: 'previewPush', only: [...chosen] })}>
                Send to Jira
              </button>
              <select
                value=""
                title="Set priority on the selected epics — a local edit"
                onChange={(ev) => {
                  if (!ev.target.value) return;
                  const p = ev.target.value as EpicItem['priority'];
                  edit(epics.map((e) => (chosen.has(e.ref) ? { ...e, priority: p } : e)));
                }}
              >
                <option value="">Set priority…</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select
                value=""
                title="Set size on the selected epics"
                onChange={(ev) => {
                  if (!ev.target.value) return;
                  const z = ev.target.value as EpicItem['sizing'];
                  edit(epics.map((e) => (chosen.has(e.ref) ? { ...e, sizing: z } : e)));
                }}
              >
                <option value="">Set size…</option>
                {['S', 'M', 'L', 'XL'].map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="detail">
          {current ? (
            <EpicDetail
              epic={current}
              jiraBase={state.jiraBrowseBase}
              busy={state.busy}
              quality={qualityFor('epic', current.ref)}
              qualityFor={qualityFor}
              criteria={state.criteria}
              reviewers={state.reviewers}
              observations={state.observations}
              conflicts={state.conflicts}
              sourceKind={b.source.kind}
              onFix={(level, ref) => act({ type: 'fixItem', level, ref })}
              onReview={() => act({ type: 'deepReview', only: [current.ref] })}
              onChange={(next) => edit(epics.map((x) => (x.ref === next.ref ? next : x)))}
              onDelete={() => act({ type: 'deleteItem', level: 'epic', ref: current.ref })}
              onDeleteStory={(ref) => act({ type: 'deleteItem', level: 'story', ref })}
              onRefine={(level, ref, instruction) => act({ type: 'refine', level, ref, instruction })}
              onGenerateStories={() => act({ type: 'generateStories', epicRefs: [current.ref] })}
              onAddStory={() => act({ type: 'addStory', epicRef: current.ref })}
              storiesNeedingWorkOnly={storiesNeedingWorkOnly}
              onToggleStoryFilter={setStoriesNeedingWorkOnly}
            />
          ) : (
            <div className="empty">
              <h2>No epics yet</h2>
              <p>Add one by hand, or start again from the Confluence page.</p>
            </div>
          )}
        </div>
      </div>

      {state.pendingRefine && <RefineModal state={state} />}
      {state.plan && <PlanModal state={state} only={onlyRefs} />}
      {state.improveReport && <ImproveModal state={state} />}
      {state.duplicates && <DuplicatesModal state={state} />}
      {overlay}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
