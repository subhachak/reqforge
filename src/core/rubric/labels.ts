import { ALL_CRITERIA, criterionById } from './criteria';
import type { ItemQuality } from './types';

/**
 * Quality signals carried into Jira.
 *
 * Two channels, because Jira labels cannot hold a sentence: labels are the
 * filterable, dashboard-able signal, and a short note appended to the
 * description is the human explanation. Neither blocks the push — an item that
 * merely scores badly still ships, it just arrives honest about it.
 */

const PREFIX = 'reqforge';

/** Jira labels reject whitespace, so everything is lower-kebab. */
function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Short name for a criterion, e.g. invest-testable -> testable. */
function criterionSlug(id: string): string {
  return slug(id.replace(/^(invest|epic)-/, ''));
}

/** How many weak-criterion labels to attach before it becomes noise. */
const MAX_CRITERION_LABELS = 3;

/**
 * The complete vocabulary this tool may apply, so an update can clear the ones
 * that no longer hold without having to read the issue's current labels first.
 */
export function qualityLabelVocabulary(): string[] {
  // Derived, not listed. A hand-written list drifts the moment a criterion is
  // renamed, and the symptom is a stale label nobody clears.
  const fromCriteria = [...new Set(ALL_CRITERIA.map((c) => `${PREFIX}-needs-${criterionSlug(c.id)}`))];
  return [
    `${PREFIX}-quality-ok`,
    `${PREFIX}-quality-below-threshold`,
    `${PREFIX}-not-reviewed`,
    `${PREFIX}-quality-accepted`,
    ...fromCriteria
  ];
}

export function qualityLabels(item: ItemQuality): string[] {
  const labels: string[] = [];

  if (item.deterministicOnly) {
    labels.push(`${PREFIX}-not-reviewed`);
    return labels;
  }

  if (item.acceptedBelowThreshold) labels.push(`${PREFIX}-quality-accepted`);

  if (item.score < item.threshold) {
    labels.push(`${PREFIX}-quality-below-threshold`);
    // Name the specific weaknesses, worst first, so a filter can find "every
    // story whose acceptance criteria are untestable" rather than just "bad".
    const weak = item.criteria
      .filter((c) => c.rating <= 1)
      .sort((a, b) => a.rating - b.rating)
      .slice(0, MAX_CRITERION_LABELS);
    for (const c of weak) labels.push(`${PREFIX}-needs-${criterionSlug(c.id)}`);
  } else {
    labels.push(`${PREFIX}-quality-ok`);
  }

  return labels;
}

/** Labels from the vocabulary that do not currently apply, for removal on update. */
export function staleQualityLabels(item: ItemQuality): string[] {
  const current = new Set(qualityLabels(item));
  return qualityLabelVocabulary().filter((l) => !current.has(l));
}

/**
 * A short note appended to the Jira description. Deliberately terse — it exists
 * so somebody reading the ticket in Jira knows the backlog tool had reservations,
 * not to reproduce the whole assessment.
 */
export function qualityNote(item: ItemQuality): string {
  if (item.deterministicOnly) {
    return `_Quality: not reviewed. Automatic checks passed; no rubric assessment has been run._`;
  }

  if (item.score >= item.threshold && !item.acceptedBelowThreshold) {
    return `_Quality: ${item.score}/100 (threshold ${item.threshold})._`;
  }

  const weak = item.criteria
    .filter((c) => c.rating <= 1)
    .sort((a, b) => a.rating - b.rating)
    .slice(0, MAX_CRITERION_LABELS)
    .map((c) => `${criterionById(c.id)?.name ?? c.id} ${c.rating}/3`);

  const parts = [`_Quality: ${item.score}/100, below the threshold of ${item.threshold}`];
  if (weak.length) parts.push(`Weakest: ${weak.join(', ')}`);
  if (item.warnings.length) parts.push(`${item.warnings.length} open finding(s)`);
  if (item.acceptedBelowThreshold) parts.push(`Accepted by a reviewer: "${item.acceptedBelowThreshold.reason}"`);
  return `${parts.join('. ')}._`;
}
