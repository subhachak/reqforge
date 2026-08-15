import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EpicItem, StoryItem, SyncStatus } from '../core/model';
import { syncStatus } from '../core/model';
import type { AcceptanceCriterion } from '../core/schemas';
import type { CriterionDef, ItemQuality } from '../core/rubric/index';
import type { HostMessage, PanelState, WebviewMessage } from '../shared/protocol';
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
    hasToken: false,
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
      <span className="pill unknown" title="Not reviewed yet — run a quality review">
        not reviewed
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
function QualityPanel({
  quality,
  criteria,
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
          Automatic checks only. Run a quality review to rate this against{' '}
          {quality.level === 'story' ? 'INVEST' : 'the epic rubric'}.
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

/* --------------------------------------------------------------- filtering */

export type ReadinessFilter = 'all' | 'needs-work' | 'not-reviewed' | 'ready';

/**
 * An epic's readiness is the worst of itself and its stories: an epic whose
 * stories are unusable is not ready, however well the epic itself reads. This
 * is what makes the filter useful rather than merely decorative.
 */
function epicReadiness(
  epic: EpicItem,
  qualityFor: (level: 'epic' | 'story', ref: string) => ItemQuality | undefined
): Exclude<ReadinessFilter, 'all'> {
  const all = [qualityFor('epic', epic.ref), ...epic.stories.map((s) => qualityFor('story', s.ref))].filter(
    Boolean
  ) as ItemQuality[];
  if (all.length === 0) return 'not-reviewed';
  if (all.some((q) => !q.passed && !q.deterministicOnly)) return 'needs-work';
  if (all.some((q) => q.blockedBy.length > 0)) return 'needs-work';
  if (all.some((q) => q.deterministicOnly)) return 'not-reviewed';
  return 'ready';
}

const FILTER_LABEL: Record<ReadinessFilter, string> = {
  all: 'All',
  'needs-work': 'Needs work',
  'not-reviewed': 'Not reviewed',
  ready: 'Ready'
};

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
  onChange: (s: StoryItem) => void;
  onDelete: () => void;
  onRefine: (instruction: string) => void;
  onFix: () => void;
  onReview: () => void;
}) {
  const [open, setOpen] = useState(false);
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

          <Field label="Acceptance criteria" hint="what QA will actually check" name="acceptanceCriteria">
            <AcEditor items={s.acceptanceCriteria} onChange={(v) => patch({ acceptanceCriteria: v })} />
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
            busy={props.busy}
            onFix={props.onFix}
            onReview={props.onReview}
            onWaive={(ruleId) => post({ type: 'waiveFinding', level: 'story', ref: s.ref, ruleId })}
            onUnwaive={(ruleId) => post({ type: 'unwaiveFinding', level: 'story', ref: s.ref, ruleId })}
            onAccept={() => post({ type: 'acceptBelowThreshold', level: 'story', ref: s.ref })}
            onRevoke={() => post({ type: 'revokeAcceptance', level: 'story', ref: s.ref })}
            onLocate={(field) => locateField(`story:${s.ref}`, field)}
          />

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
      <div data-item={`epic:${e.ref}`}>
      <div className="chip-row" style={{ marginBottom: 14 }}>
        <span className={`dot ${status}`} />
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{STATUS_LABEL[status]}</span>
        <ScorePill quality={props.quality} />
        {e.sync.jiraKey && (
          <a
            className="chip link"
            onClick={() => post({ type: 'openExternal', url: `${props.jiraBase}/browse/${e.sync.jiraKey}` })}
          >
            {e.sync.jiraKey} ↗
          </a>
        )}
        <span className="chip">{e.stories.length} stories</span>
        {points > 0 && <span className="chip">{points} points</span>}
      </div>

      <Field label="Title" name="title">
        <input className="title-input" value={e.title} onChange={(ev) => patch({ title: ev.target.value })} />
      </Field>

      <Field label="Outcome" hint="what is true once this ships, in business terms" name="outcome">
        <Grow value={e.outcome} onChange={(v) => patch({ outcome: v })} />
      </Field>

      <Field label="Description">
        <Grow value={e.description} onChange={(v) => patch({ description: v })} rows={4} />
      </Field>

      <div className="row">
        <div style={{ flex: 1 }}>
          <Field label="Priority" hint="MoSCoW, as the requirements state it" name="priority">
            <PriorityPicker value={e.priority ?? 'Should'} onChange={(v) => patch({ priority: v })} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Size">
            <select value={e.sizing} onChange={(ev) => patch({ sizing: ev.target.value as EpicItem['sizing'] })}>
              {(['S', 'M', 'L', 'XL'] as const).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

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

      <Field label="Acceptance criteria" name="acceptanceCriteria">
        <AcEditor items={e.acceptanceCriteria} onChange={(v) => patch({ acceptanceCriteria: v })} />
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

      {e.sourceEvidence.length > 0 && (
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

      </div>

      <div className="section-head">
        <h2>Stories</h2>
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
    </>
  );
}

/* ------------------------------------------------------------------ setup */

function StatusLine({ label, probe }: { label: string; probe: { state: string; detail: string } }) {
  const colour =
    probe.state === 'ok' ? 'var(--green)' : probe.state === 'failed' ? 'var(--red)' : 'var(--muted)';
  const text = probe.state === 'unknown' ? 'Not checked yet' : probe.detail;
  return (
    <div className="row" style={{ alignItems: 'baseline' }}>
      <span style={{ width: 90, flex: 'none', color: 'var(--muted)', fontSize: 12 }}>{label}</span>
      <span style={{ color: colour }}>{text}</span>
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
    modelFamily: s.modelFamily
  });

  // Adopt host values when they change underneath us (e.g. the token prompt).
  useEffect(() => {
    setForm({
      baseUrl: s.baseUrl,
      email: s.email,
      projectKey: s.projectKey,
      epicIssueType: s.epicIssueType,
      storyIssueType: s.storyIssueType,
      modelFamily: s.modelFamily
    });
  }, [s.baseUrl, s.email, s.projectKey, s.epicIssueType, s.storyIssueType, s.modelFamily]);

  const save = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    post({ type: 'saveSettings', patch });
  };

  const missing = [
    !form.baseUrl && 'Atlassian site',
    !form.email && 'account email',
    !s.hasToken && 'API token',
    !form.projectKey && 'Jira project'
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

      <div className="section-head">
        <h2>Check</h2>
        <div className="spacer" />
        <button disabled={state.busy} onClick={() => post({ type: 'testConnection' })}>
          Test connections
        </button>
      </div>

      <StatusLine label="Atlassian" probe={s.atlassian} />
      <StatusLine label="Copilot" probe={s.model} />

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

/* -------------------------------------------------------------------- app */

function App() {
  const [state, setState] = useState<PanelState>(EMPTY);
  const [selected, setSelected] = useState<string | undefined>();
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<ReadinessFilter>('all');
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
        setIncluded(new Set(epics.map((e) => e.ref)));
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

  const readiness = useCallback((epic: EpicItem) => epicReadiness(epic, qualityFor), [qualityFor]);

  const filterCounts = useMemo(() => {
    const counts: Record<ReadinessFilter, number> = { all: epics.length, 'needs-work': 0, 'not-reviewed': 0, ready: 0 };
    for (const e of epics) counts[readiness(e)]++;
    return counts;
  }, [epics, readiness]);

  const visibleEpics = useMemo(
    () => (filter === 'all' ? epics : epics.filter((e) => readiness(e) === filter)),
    [epics, filter, readiness]
  );

  // Keep the detail pane in step with the filter rather than showing a hidden item.
  useEffect(() => {
    if (visibleEpics.length === 0) return;
    if (!selected || !visibleEpics.some((e) => e.ref === selected)) setSelected(visibleEpics[0].ref);
  }, [visibleEpics, selected]);

  const current = useMemo(() => epics.find((e) => e.ref === selected), [epics, selected]);
  const onlyRefs = useMemo(() => [...included], [included]);

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
        <button className="ghost" title="Back" onClick={() => act({ type: 'navigate', view: 'home' })}>
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
          <button
            className="ghost"
            disabled={state.busy || !state.undoLabel}
            title={state.undoLabel ? `Undo ${state.undoLabel} (⌘Z)` : 'Nothing to undo'}
            onClick={() => act({ type: 'undo' })}
          >
            ↶ Undo
          </button>
          <button
            className="ghost"
            disabled={state.busy || !state.redoLabel}
            title={state.redoLabel ? `Redo ${state.redoLabel} (⇧⌘Z)` : 'Nothing to redo'}
            onClick={() => act({ type: 'redo' })}
          >
            ↷ Redo
          </button>
          {state.quality && (
            <span
              className={`pill ${state.quality.unassessed > 0 ? 'unknown' : state.quality.failed > 0 ? 'fail' : 'pass'}`}
              title={`Average score across reviewed items. Threshold ${state.quality.threshold}.`}
            >
              {state.quality.unassessed === state.quality.items.length
                ? 'not reviewed'
                : `${state.quality.score} avg · ${state.quality.failed} below`}
            </span>
          )}
          <button
            disabled={state.busy || (state.quality?.unassessed ?? 0) === 0}
            onClick={() => act({ type: 'deepReview' })}
            title={
              (state.quality?.unassessed ?? 0) === 0
                ? 'Every item has been reviewed against the current content. Edit something to re-run, or use Re-review on a single item.'
                : `Rate ${state.quality?.unassessed} item(s) against the rubric`
            }
          >
            {(state.quality?.unassessed ?? 0) === 0
              ? 'Reviewed'
              : `Review quality (${state.quality?.unassessed})`}
          </button>
          <button className="ghost" onClick={() => act({ type: 'navigate', view: 'setup' })}>
            ⚙
          </button>
          <button
            disabled={state.busy || totals.pending === 0}
            className="primary"
            onClick={() => act({ type: 'previewPush', only: onlyRefs })}
            title={
              totals.pending === 0
                ? `All ${totals.total} items match what is in Jira. Edit something to send again.`
                : `${totals.pending} item(s) to create or update`
            }
          >
            {totals.pending === 0 ? 'All sent to Jira' : `Review & send to Jira (${totals.pending})`}
          </button>
        </div>
      </div>

      {banner}

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
            <select value={filter} onChange={(ev) => setFilter(ev.target.value as ReadinessFilter)}>
              {(['all', 'needs-work', 'not-reviewed', 'ready'] as ReadinessFilter[]).map((f) => (
                <option key={f} value={f} disabled={f !== 'all' && filterCounts[f] === 0}>
                  {FILTER_LABEL[f]} ({filterCounts[f]})
                </option>
              ))}
            </select>
            <div className="rail-select">
              <span>send:</span>
              <button
                className="ghost"
                title="Include every epic currently shown"
                onClick={() => setIncluded(new Set([...included, ...visibleEpics.map((e) => e.ref)]))}
              >
                all shown
              </button>
              <button className="ghost" title="Include none" onClick={() => setIncluded(new Set())}>
                none
              </button>
              <span style={{ marginLeft: 'auto' }}>{included.size} selected</span>
            </div>
          </div>

          {visibleEpics.length === 0 && (
            <p style={{ color: 'var(--muted)', padding: '12px 10px' }}>
              No epics are {FILTER_LABEL[filter].toLowerCase()}.
            </p>
          )}

          {visibleEpics.map((e) => {
            const status = statusOf(e, qualityFor('epic', e.ref));
            return (
              <div
                key={e.ref}
                className={`epic-row ${selected === e.ref ? 'selected' : ''}`}
                onClick={() => setSelected(e.ref)}
              >
                <input
                  type="checkbox"
                  checked={included.has(e.ref)}
                  title="Include when sending to Jira"
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={(ev) => {
                    const next = new Set(included);
                    ev.target.checked ? next.add(e.ref) : next.delete(e.ref);
                    setIncluded(next);
                  }}
                />
                <span className={`dot ${status}`} title={STATUS_LABEL[status]} />
                <div style={{ minWidth: 0 }}>
                  <div className="title">{e.title || 'Untitled epic'}</div>
                  <div className="meta">
                    {e.sizing} · {e.stories.length} stories
                    {e.sync.jiraKey ? ` · ${e.sync.jiraKey}` : ''}
                  </div>
                </div>
                <ScorePill quality={qualityFor('epic', e.ref)} />
              </div>
            );
          })}
          <button className="ghost" style={{ width: '100%', marginTop: 6 }} onClick={() => act({ type: 'addEpic' })}>
            + Add epic
          </button>
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
      {overlay}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
