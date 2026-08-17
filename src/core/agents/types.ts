// What a review produces is shared vocabulary — the host, the protocol and the
// webview all handle it, and the restricted repository must be able to name it
// without naming this directory. Only the reviewer definitions below, which
// describe how a review is produced, are specific to the full profile.
export type { AttributedCriterion, Conflict, Observation, PanelResult, ReviewerRun } from '../findings';

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
