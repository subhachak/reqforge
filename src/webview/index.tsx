import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EpicItem, StoryItem } from '../core/model';
import type { AcceptanceCriterion } from '../core/schemas';
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
  backlog: undefined,
  available: [],
  slug: undefined,
  busy: false,
  busyLabel: '',
  plan: undefined,
  notice: undefined,
  pendingRefine: undefined,
  jiraBrowseBase: '',
  canPush: false,
  undoLabel: undefined,
  redoLabel: undefined
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

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>
        {props.label} {props.hint && <span className="hint">— {props.hint}</span>}
      </label>
      {props.children}
    </div>
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

/* ------------------------------------------------------------------ status */

type Status = 'new' | 'edited' | 'synced';

function statusOf(item: { sync: { jiraKey?: string; pushedHash?: string } }): Status {
  if (!item.sync.jiraKey) return 'new';
  return item.sync.pushedHash ? 'synced' : 'edited';
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
  onChange: (s: StoryItem) => void;
  onDelete: () => void;
  onRefine: (instruction: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const s = props.story;
  const status = statusOf(s);
  const patch = (p: Partial<StoryItem>) => props.onChange({ ...s, ...p });

  return (
    <div className="story">
      <div className="story-head" onClick={() => setOpen(!open)}>
        <span className={`dot ${status}`} title={STATUS_LABEL[status]} />
        <span className="title">{s.title || 'Untitled story'}</span>
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
        <div className="story-body">
          <Field label="Title">
            <Grow value={s.title} onChange={(v) => patch({ title: v })} />
          </Field>

          <Field label="User story">
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

          <Field label="Acceptance criteria" hint="what QA will actually check">
            <AcEditor items={s.acceptanceCriteria} onChange={(v) => patch({ acceptanceCriteria: v })} />
          </Field>

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

          {s.openQuestions.length > 0 && (
            <Field label="Open questions" hint="answer these before the story is ready">
              <ListEditor
                items={s.openQuestions}
                onChange={(v) => patch({ openQuestions: v })}
                placeholder="What still needs deciding?"
                addLabel="Add question"
              />
            </Field>
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
  onChange: (e: EpicItem) => void;
  onDelete: () => void;
  onRefine: (level: 'epic' | 'story', ref: string, instruction: string) => void;
  onGenerateStories: () => void;
  onAddStory: () => void;
  onDeleteStory: (ref: string) => void;
}) {
  const e = props.epic;
  const [instruction, setInstruction] = useState('');
  const status = statusOf(e);
  const patch = (p: Partial<EpicItem>) => props.onChange({ ...e, ...p });
  const points = e.stories.reduce((n, s) => n + s.points, 0);

  return (
    <>
      <div className="chip-row" style={{ marginBottom: 14 }}>
        <span className={`dot ${status}`} />
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{STATUS_LABEL[status]}</span>
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

      <Field label="Title">
        <input className="title-input" value={e.title} onChange={(ev) => patch({ title: ev.target.value })} />
      </Field>

      <Field label="Outcome" hint="what is true once this ships, in business terms">
        <Grow value={e.outcome} onChange={(v) => patch({ outcome: v })} />
      </Field>

      <Field label="Description">
        <Grow value={e.description} onChange={(v) => patch({ description: v })} rows={4} />
      </Field>

      <Field label="Size">
        <select value={e.sizing} onChange={(ev) => patch({ sizing: ev.target.value as EpicItem['sizing'] })}>
          {(['S', 'M', 'L', 'XL'] as const).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>

      <Field label="In scope">
        <ListEditor
          items={e.inScope}
          onChange={(v) => patch({ inScope: v })}
          placeholder="Something this epic delivers"
          addLabel="Add"
        />
      </Field>

      <Field label="Out of scope" hint="the cheapest way to prevent scope drift">
        <ListEditor
          items={e.outOfScope}
          onChange={(v) => patch({ outOfScope: v })}
          placeholder="Something this epic explicitly does not cover"
          addLabel="Add"
        />
      </Field>

      <Field label="Acceptance criteria">
        <AcEditor items={e.acceptanceCriteria} onChange={(v) => patch({ acceptanceCriteria: v })} />
      </Field>

      {e.openQuestions.length > 0 && (
        <Field label="Open questions" hint="answer these before planning">
          <ListEditor
            items={e.openQuestions}
            onChange={(v) => patch({ openQuestions: v })}
            placeholder="What still needs deciding?"
            addLabel="Add question"
          />
        </Field>
      )}

      {e.sourceEvidence.length > 0 && (
        <Field label="Evidence from the source document" hint="why this epic exists">
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)' }}>
            {e.sourceEvidence.map((q, i) => (
              <li key={i}>“{q}”</li>
            ))}
          </ul>
        </Field>
      )}

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
        <h2>Stories</h2>
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

      {e.stories.map((s) => (
        <StoryCard
          key={s.ref}
          story={s}
          jiraBase={props.jiraBase}
          busy={props.busy}
          onChange={(next) => patch({ stories: e.stories.map((x) => (x.ref === s.ref ? next : x)) })}
          onDelete={() => props.onDeleteStory(s.ref)}
          onRefine={(instr) => props.onRefine('story', s.ref, instr)}
        />
      ))}
    </>
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
        setIncluded((cur) => (cur.size === 0 ? new Set(epics.map((e) => e.ref)) : cur));
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const epics = draft ?? state.backlog?.epics ?? [];

  /** Local edit, then a debounced save. Flushed before any host action. */
  const edit = useCallback((next: EpicItem[]) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => post({ type: 'edit', epics: next }), 400);
  }, []);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (draft) post({ type: 'edit', epics: draft });
  }, [draft]);

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

  const current = useMemo(() => epics.find((e) => e.ref === selected), [epics, selected]);
  const onlyRefs = useMemo(() => [...included], [included]);

  const totals = useMemo(() => {
    const stories = epics.flatMap((e) => e.stories);
    return {
      epics: epics.length,
      stories: stories.length,
      points: stories.reduce((n, s) => n + s.points, 0),
      unpushed: [...epics, ...stories].filter((i) => !i.sync.jiraKey).length
    };
  }, [epics]);

  if (!state.backlog) {
    return (
      <div className="app">
        <div className="empty">
          <h2>No requirements loaded yet</h2>
          <p>
            Start from a Confluence page and ReqForge will propose a set of epics you can review, edit, and send
            to Jira.
          </p>
          <button className="primary" onClick={() => post({ type: 'decompose' })}>
            Start from a Confluence page
          </button>
        </div>
      </div>
    );
  }

  const b = state.backlog;

  return (
    <div className="app">
      <div className="header">
        <div>
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
          {state.available.length > 1 && (
            <select
              style={{ width: 200 }}
              value={state.slug}
              onChange={(e) => act({ type: 'selectBacklog', slug: e.target.value })}
            >
              {state.available.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.title}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => act({ type: 'decompose' })}>New from Confluence</button>
          <button
            disabled={state.busy || !state.canPush}
            className="primary"
            onClick={() => act({ type: 'previewPush', only: onlyRefs })}
          >
            Review &amp; send to Jira{totals.unpushed ? ` (${totals.unpushed})` : ''}
          </button>
        </div>
      </div>

      {state.notice && (
        <div className={`notice ${state.notice.kind}`}>
          <div className="msg">
            <div>{state.notice.message}</div>
            {state.notice.hint && <div className="hint">{state.notice.hint}</div>}
          </div>
          <button className="ghost" onClick={() => post({ type: 'dismissNotice' })}>
            ✕
          </button>
        </div>
      )}

      {(b.prd.openQuestions.length > 0 || b.prd.risks.length > 0) && (
        <div className="insights">
          <div className="section-head" style={{ margin: 0, border: 'none', paddingBottom: 0 }}>
            <h2>What the document leaves unresolved</h2>
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
          {epics.map((e) => {
            const status = statusOf(e);
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
              onChange={(next) => edit(epics.map((x) => (x.ref === next.ref ? next : x)))}
              onDelete={() => act({ type: 'deleteItem', level: 'epic', ref: current.ref })}
              onDeleteStory={(ref) => act({ type: 'deleteItem', level: 'story', ref })}
              onRefine={(level, ref, instruction) => act({ type: 'refine', level, ref, instruction })}
              onGenerateStories={() => act({ type: 'generateStories', epicRefs: [current.ref] })}
              onAddStory={() => act({ type: 'addStory', epicRef: current.ref })}
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

      {state.busy && (
        <div className="busy">
          <div className="spinner" />
          <div>{state.busyLabel || 'Working…'}</div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
