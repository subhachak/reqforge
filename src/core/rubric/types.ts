/**
 * Quality assessment of backlog items against named, industry-standard criteria.
 *
 * The central design decision: the model never produces a score. It rates each
 * named criterion 0–3 and justifies the rating; the score is computed here from
 * those ratings and the configured weights. A number a model invented is not
 * reproducible and cannot be argued with. A number derived from "Independent: 1
 * — this story cannot start until the schema story lands" can be.
 */

export type Severity = 'blocker' | 'warn' | 'info';
export type Level = 'epic' | 'story';

/** 0 absent · 1 poor · 2 acceptable · 3 good. Deliberately coarse: finer scales invite false precision. */
export type Rating = 0 | 1 | 2 | 3;
export const MAX_RATING = 3;

export interface CriterionDef {
  id: string;
  /** Shown in the UI. */
  name: string;
  /** Where the criterion comes from, so a reviewer can look it up. */
  standard: string;
  /** Sent to the model as the definition it rates against. */
  definition: string;
  /** What a 3 looks like, and what a 0 looks like. Anchors make ratings stable. */
  anchors: { good: string; bad: string };
  weight: number;
  appliesTo: Level[];
}

export interface CriterionResult {
  id: string;
  rating: Rating;
  /** Why the model gave this rating. Required — an unjustified rating is not reviewable. */
  justification: string;
  /** A concrete rewrite or split. Empty when the rating is already good. */
  suggestion: string;
}

/** A deterministic rule violation. These are facts, not judgements. */
export interface RuleFinding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Field to focus in the UI, when the problem belongs to one. */
  field?: string;
}

/**
 * A human decision that overrides the rubric for one item.
 *
 * Rubrics produce false positives — a rule that is right ninety times is wrong
 * the ninety-first, and a criterion can misjudge an item whose context lives
 * outside the text. Without a way to say "I have looked at this and it is
 * fine", people either disable the rule globally or stop trusting the whole
 * system. Both are worse than a recorded, attributed exception.
 */
export interface Override {
  level: Level;
  ref: string;
  /** Rule ids the reviewer has judged not to apply here. */
  waivedRules: string[];
  /** Set when the reviewer accepts the item despite a score below the threshold. */
  acceptedBelowThreshold?: { reason: string; at: string };
  /** Reasons per waived rule, keyed by rule id. */
  reasons: Record<string, string>;
}

export interface ItemQuality {
  level: Level;
  ref: string;
  title: string;
  /** 0–100, weighted over the criteria that were assessed. */
  score: number;
  threshold: number;
  /** False when the score is below threshold or any blocker fired. */
  passed: boolean;
  /** Present when the item failed for a reason other than the score. */
  blockedBy: RuleFinding[];
  warnings: RuleFinding[];
  criteria: CriterionResult[];
  /** Content fingerprint at assessment time, so we can tell when it goes stale. */
  assessedHash: string;
  assessedAt: string;
  /** True when only deterministic rules ran — no model call has been made yet. */
  deterministicOnly: boolean;
  /** Findings the reviewer waived, kept visible rather than hidden. */
  waived: (RuleFinding & { reason: string })[];
  /** Set when the item passes only because a reviewer accepted it below threshold. */
  acceptedBelowThreshold?: { reason: string; at: string };
}

export interface BacklogQuality {
  items: ItemQuality[];
  /** Mean score across assessed items, weighted equally. */
  score: number;
  threshold: number;
  passed: number;
  failed: number;
  unassessed: number;
}

export interface RubricConfig {
  /** An item must reach this to be considered ready. */
  threshold: number;
  /** Per-criterion weight overrides, keyed by criterion id. 0 disables a criterion. */
  weights: Record<string, number>;
  /** Per-rule severity overrides. 'off' disables a rule. */
  rules: Record<string, Severity | 'off'>;
  /**
   * What a score below the threshold does at push time.
   *   label — send it anyway, tagged in Jira with what fell short (default)
   *   warn  — a modal confirmation first
   *   block — refuse
   * Structural blockers are never governed by this. A missing acceptance
   * criterion is a fact about the item, not a judgement about it, and no
   * setting lets one through.
   */
  enforcement: 'block' | 'warn' | 'label';
  /**
   * Whether an item that has never been through a model review counts as
   * failing. False by default: the deterministic rules are the gate, the model
   * pass is advisory, and an unreviewed item ships tagged reqforge-not-reviewed.
   * Set true for the strict reading, where nothing ships unreviewed.
   */
  requireReview: boolean;
}

export const DEFAULT_RUBRIC: RubricConfig = {
  threshold: 70,
  weights: {},
  rules: {},
  enforcement: 'label',
  requireReview: false
};
