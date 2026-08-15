import type { Backlog, EpicItem, StoryItem } from '../model';
import { epicFingerprint, storyFingerprint } from '../model';
import { criteriaFor, criterionById } from './criteria';
import { checkEpic, checkStory, type RuleContext } from './rules';
import {
  MAX_RATING,
  type BacklogQuality,
  type CriterionResult,
  type ItemQuality,
  type Level,
  type Override,
  type RubricConfig,
  type RuleFinding
} from './types';

/**
 * Turns criterion ratings and rule findings into a score and a verdict.
 *
 * The score is a weighted percentage of the maximum achievable rating across
 * the criteria that apply at this level. Weights come from the criterion
 * definitions and may be overridden per client; a weight of 0 removes the
 * criterion from both numerator and denominator, so disabling one does not
 * silently cap the score.
 */
export function scoreCriteria(level: Level, results: CriterionResult[], config: RubricConfig): number {
  const applicable = criteriaFor(level);
  let earned = 0;
  let possible = 0;

  for (const def of applicable) {
    const weight = config.weights[def.id] ?? def.weight;
    if (weight <= 0) continue;
    const result = results.find((r) => r.id === def.id);
    if (!result) continue; // not assessed — excluded rather than counted as zero
    earned += result.rating * weight;
    possible += MAX_RATING * weight;
  }

  if (possible === 0) return 0;
  return Math.round((earned / possible) * 100);
}

export function buildItemQuality(args: {
  level: Level;
  ref: string;
  title: string;
  fingerprint: string;
  findings: RuleFinding[];
  criteria: CriterionResult[];
  config: RubricConfig;
  override?: Override;
}): ItemQuality {
  const { level, ref, title, fingerprint, findings, criteria, config, override } = args;

  // Waived findings are removed from the verdict but kept on the item, so an
  // exception is visible to the next reader rather than looking like a pass.
  const waivedIds = new Set(override?.waivedRules ?? []);
  const waived = findings
    .filter((f) => waivedIds.has(f.ruleId))
    .map((f) => ({ ...f, reason: override?.reasons[f.ruleId] ?? '' }));
  const active = findings.filter((f) => !waivedIds.has(f.ruleId));

  const blockedBy = active.filter((f) => f.severity === 'blocker');
  const warnings = active.filter((f) => f.severity !== 'blocker');
  const deterministicOnly = criteria.length === 0;
  const score = deterministicOnly ? 0 : scoreCriteria(level, criteria, config);

  const accepted = override?.acceptedBelowThreshold;
  const reviewSatisfied = !deterministicOnly || !config.requireReview;
  const scoreSatisfied = deterministicOnly ? true : score >= config.threshold;

  return {
    level,
    ref,
    title,
    score,
    threshold: config.threshold,
    // A blocker fails the item outright — no score can buy it off. Beyond that,
    // an item passes when it is reviewed (if reviews are required), scores at
    // or above the threshold, or a reviewer has explicitly accepted it below.
    passed: blockedBy.length === 0 && (Boolean(accepted) || (reviewSatisfied && scoreSatisfied)),
    blockedBy,
    warnings,
    criteria,
    assessedHash: fingerprint,
    assessedAt: new Date().toISOString(),
    deterministicOnly,
    waived,
    acceptedBelowThreshold: accepted
  };
}

/**
 * Evaluates the whole backlog. Deterministic rules always run; model criteria
 * are used only where a cached assessment exists and still matches the item's
 * content fingerprint. Editing an item invalidates its assessment rather than
 * silently keeping a stale score.
 */
export function evaluateBacklog(
  backlog: Backlog,
  config: RubricConfig,
  cached: Map<string, CriterionResult[]> = new Map(),
  overrides: Map<string, Override> = new Map()
): BacklogQuality {
  const ctx: RuleContext = {
    allEpicRefs: new Set(backlog.epics.map((e) => e.ref)),
    siblingTitles: [],
    // A backlog read out of Jira is one epic, not the whole picture.
    partial: backlog.source.kind === 'jira'
  };

  const items: ItemQuality[] = [];

  for (const epic of backlog.epics) {
    const fingerprint = epicFingerprint(epic);
    items.push(
      buildItemQuality({
        level: 'epic',
        ref: epic.ref,
        title: epic.title,
        fingerprint,
        findings: checkEpic(epic, { ...ctx, siblingTitles: siblingsOf(backlog, epic) }, config),
        criteria: cached.get(cacheKey('epic', epic.ref, fingerprint)) ?? [],
        config,
        override: overrides.get(overrideKey('epic', epic.ref))
      })
    );

    for (const story of epic.stories) {
      const storyPrint = storyFingerprint(story);
      items.push(
        buildItemQuality({
          level: 'story',
          ref: story.ref,
          title: story.title,
          fingerprint: storyPrint,
          findings: checkStory(story, ctx, config),
          criteria: cached.get(cacheKey('story', story.ref, storyPrint)) ?? [],
          config,
          override: overrides.get(overrideKey('story', story.ref))
        })
      );
    }
  }

  const assessed = items.filter((i) => !i.deterministicOnly);
  return {
    items,
    score: assessed.length ? Math.round(assessed.reduce((n, i) => n + i.score, 0) / assessed.length) : 0,
    threshold: config.threshold,
    passed: items.filter((i) => i.passed).length,
    failed: items.filter((i) => !i.passed && !i.deterministicOnly).length,
    unassessed: items.filter((i) => i.deterministicOnly).length
  };
}

/** Keyed by fingerprint so an edit invalidates the assessment automatically. */
export function cacheKey(level: Level, ref: string, fingerprint: string): string {
  return `${level}:${ref}:${fingerprint}`;
}

/**
 * Overrides are keyed without the fingerprint, so a reviewer's decision
 * survives ordinary editing. Re-waiving the same rule after every typo would
 * make the mechanism unusable; the waiver stays visible on the item so it can
 * be revisited deliberately.
 */
export function overrideKey(level: Level, ref: string): string {
  return `${level}:${ref}`;
}

function siblingsOf(backlog: Backlog, epic: EpicItem): string[] {
  return backlog.epics.filter((e) => e.ref !== epic.ref).map((e) => e.title);
}

/** Human-readable one-liner for a criterion result, used in tooltips and reports. */
export function describeCriterion(result: CriterionResult): string {
  const def = criterionById(result.id);
  const name = def?.name ?? result.id;
  return `${name}: ${result.rating}/${MAX_RATING} — ${result.justification}`;
}

/** Everything a "fix this" instruction needs, assembled from the worst findings first. */
export function fixInstruction(quality: ItemQuality): string {
  const parts: string[] = [];
  for (const b of quality.blockedBy) parts.push(b.message);
  for (const c of quality.criteria.filter((c) => c.rating <= 1 && c.suggestion)) {
    const def = criterionById(c.id);
    parts.push(`${def?.name ?? c.id}: ${c.suggestion}`);
  }
  for (const w of quality.warnings.filter((w) => w.severity === 'warn')) parts.push(w.message);
  return parts.length
    ? `Address the following quality problems, changing nothing else:\n${parts.map((p) => `- ${p}`).join('\n')}`
    : 'Improve the clarity and testability of this item without changing its scope.';
}

export type { StoryItem };
