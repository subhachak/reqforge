import type { CriterionResult, Level, Severity } from './rubric/types';
import type { FileSystemLike } from './store';
import type { SearchHit } from './ports';

/**
 * Review findings that carry no score, and where they are kept.
 *
 * These live in core, not beside the reviewers that produce them, because they
 * are a domain concept rather than an implementation detail of the producer: the webview renders them, the protocol carries them, and the host
 * persists them. Only the *producing* of them is profile-specific.
 *
 * Keeping them here is also what lets the restricted build compile without
 * reaching the agent layer at all — see scripts/exportRestricted.mjs, which
 * refuses to export a tree whose build graph touches it.
 */

/** A finding outside the scored criteria — the NFR gap, the missing evidence. */
export interface Observation {
  reviewerId: string;
  level: Level;
  ref: string;
  severity: Severity;
  message: string;
  /** Field to focus in the UI, when the observation belongs to one. */
  field?: string;
}

/**
 * Two reviewers pulling an item in incompatible directions.
 *
 * Surfaced rather than resolved. When the delivery reviewer says to split an
 * epic and the product reviewer says its scope is already the minimum coherent
 * outcome, both are reasoning correctly from their own remit and the trade-off
 * is the PO's to make. A single critic silently picks one and the tension
 * disappears — which is exactly the information worth keeping.
 */
export interface Conflict {
  level: Level;
  ref: string;
  between: [string, string];
  /** What each side is asking for, in its own words. */
  positions: [string, string];
  /** What the PO actually has to decide. */
  tradeoff: string;
}

export interface ReviewerRun {
  reviewerId: string;
  ok: boolean;
  /** Model requests actually consumed. */
  requests: number;
  ms: number;
  /** Set when the reviewer failed. The panel continues without it. */
  error?: string;
  itemsRated: number;
}


/**
 * Panel output that has nowhere else to live.
 *
 * Criterion ratings go in the quality sidecar because they feed the score.
 * Observations and conflicts do not — they are things a reviewer noticed that
 * the rubric has no number for — so they get their own file rather than being
 * smuggled into a record whose shape means "this is what the score was computed
 * from".
 *
 * Both are keyed by `level:ref:fingerprint`, exactly like assessments, so an
 * edited item stops matching and its findings vanish with its ratings. A
 * conflict about wording that has since been rewritten is worse than no
 * conflict at all.
 */

interface PanelFile {
  version: 1;
  observations: Record<string, Observation[]>;
  conflicts: Record<string, Conflict[]>;
}

export interface PanelRecord {
  observations: Map<string, Observation[]>;
  conflicts: Map<string, Conflict[]>;
}

export function panelPath(folder: string, slug: string): string {
  return `${folder}/${slug}.panel.json`;
}

export async function loadPanelFindings(fs: FileSystemLike, folder: string, slug: string): Promise<PanelRecord> {
  const empty: PanelRecord = { observations: new Map(), conflicts: new Map() };
  const text = await fs.read(panelPath(folder, slug));
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text) as PanelFile;
    if (parsed?.version !== 1) return empty;
    return {
      observations: new Map(Object.entries(parsed.observations ?? {})),
      conflicts: new Map(Object.entries(parsed.conflicts ?? {}))
    };
  } catch {
    // Same reasoning as the quality cache: re-running the panel costs model
    // calls, but failing to open a backlog costs the user their work.
    return empty;
  }
}

export async function savePanelFindings(
  fs: FileSystemLike,
  folder: string,
  slug: string,
  record: PanelRecord
): Promise<void> {
  const file: PanelFile = {
    version: 1,
    observations: Object.fromEntries(record.observations),
    conflicts: Object.fromEntries(record.conflicts)
  };
  await fs.write(panelPath(folder, slug), JSON.stringify(file, null, 2));
}

export async function deletePanelFindings(fs: FileSystemLike, folder: string, slug: string): Promise<void> {
  await fs.remove(panelPath(folder, slug));
}

/** Drops entries whose fingerprint is no longer in the backlog. */
export function pruneByKey<T>(entries: Map<string, T[]>, liveKeys: Set<string>): Map<string, T[]> {
  return new Map([...entries].filter(([key]) => liveKeys.has(key)));
}

/** Flattens the live entries for sending to the webview, which filters by ref. */
export function liveValues<T>(entries: Map<string, T[]>, liveKeys: Set<string>): T[] {
  return [...entries].filter(([key]) => liveKeys.has(key)).flatMap(([, values]) => values);
}

/* ------------------------------------------------ shared review vocabulary */

/*
 * The types below describe what a review *produces*, not how it is produced.
 * They live here because the host, the protocol and the webview all handle
 * them, while only the full profile can create them. Keeping them beside the
 * reviewers would force every shared module that mentions a finding to name a
 * path the restricted repository does not contain.
 */

/** A criterion rating carrying the reviewer that produced it. */
export type AttributedCriterion = CriterionResult & { reviewerId: string };

export interface PanelResult {
  /** Keyed by `cacheKey(level, ref, fingerprint)`, mergeable straight into the quality store. */
  criteria: Map<string, AttributedCriterion[]>;
  observations: Observation[];
  conflicts: Conflict[];
  runs: ReviewerRun[];
  /** True when at least one reviewer failed — the result is usable but partial. */
  partial: boolean;
  /** Criterion ids no reviewer managed to rate, so the UI can say so plainly. */
  unrated: string[];
}

/** Progress reporting, structurally identical to the pipelines' own. */
export interface ProgressLike {
  report(message: string): void;
}

export interface CancellationLike {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose(): void };
}

export interface PanelRunOptions {
  only?: { epics?: string[]; stories?: string[] };
  cached?: Map<string, AttributedCriterion[]>;
  batchSize?: number;
  detectConflicts?: boolean;
  progress?: ProgressLike;
  token?: CancellationLike;
  maxTotalRequests?: number;
  concurrency?: number;
}

export type Relationship = 'duplicate' | 'overlaps' | 'related';

export interface DuplicateCandidate {
  level: Level;
  /** The backlog item that may already exist. */
  ref: string;
  title: string;
  /** What was found in the tenant. */
  hit: SearchHit;
  relationship: Relationship;
  /** Why the model judged it so — shown to the PO, never acted on automatically. */
  reason: string;
}

export interface DuplicateReport {
  /** False when the transport cannot reach the graph. Not the same as "nothing found". */
  available: boolean;
  /** Set when unavailable, explaining what the PO would need to change. */
  unavailableReason?: string;
  candidates: DuplicateCandidate[];
  /** Items actually checked, so the UI can distinguish "clean" from "not looked at". */
  checked: string[];
}

export interface DuplicateRunOptions {
  only?: string[];
  perItem?: number;
  progress?: ProgressLike;
  token?: CancellationLike;
}
