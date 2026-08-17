import type { CriterionResult, Level, Severity } from '../rubric/types';

/**
 * Multi-agent review.
 *
 * A reviewer earns its place by owning *different criteria and a different
 * lens* — not by wearing a job title. Four specialists rating the slice they
 * own beat one generalist rating everything, because a single critique prompt
 * that must weigh outcome shape, sizing, testability and evidence in one pass
 * does all four adequately and none of them well.
 *
 * The panel is model-only by construction: reviewers receive an LlmPort and
 * nothing else. Anything that needs Jira or Confluence — duplicate detection,
 * evidence retrieval — is a pipeline step around the panel, never inside it.
 */

export interface ReviewerDef {
  id: string;
  name: string;
  /** Shown in the UI beside findings, so a PO knows who said what and why. */
  purpose: string;
  /**
   * Criterion ids this reviewer rates. Across the panel these must partition
   * the rubric exactly: every criterion owned once, none owned twice. A smoke
   * test enforces it, because a criterion owned by nobody would silently score
   * as unassessed and one owned twice would be rated inconsistently.
   */
  owns: string[];
  /** Extra instructions specific to this reviewer's perspective. */
  lens: string;
  /**
   * Whether this reviewer may raise findings outside its criteria — things the
   * rubric has no number for, such as an NFR the source implies but no item
   * covers. Observations never affect the score; they surface as warnings.
   */
  observes: boolean;
  /** Hard cap on model requests for this reviewer in one panel run. */
  maxRequests: number;
}

/** Who produced a piece of judgement, and when. */
export interface Provenance {
  reviewerId: string;
  at: string;
}

/** A criterion rating carrying the reviewer that produced it. */
export type AttributedCriterion = CriterionResult & { reviewerId: string };

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

/** Raised when an agent tries to spend past its allowance. */
export class BudgetExceededError extends Error {
  constructor(
    readonly reviewerId: string,
    readonly limit: number
  ) {
    super(`${reviewerId} exhausted its budget of ${limit} model request(s).`);
    this.name = 'BudgetExceededError';
  }
}
