import { ALL_CRITERIA } from '../rubric/criteria';
import type { ReviewerDef } from './types';

/**
 * The panel.
 *
 * Between them these four own every rubric criterion exactly once. The split is
 * by *question asked*, not by job title: "is this the right work" and "can a
 * team build it" are genuinely different judgements that a single pass blurs
 * together, and the evidence reviewer is the only one whose remit is to be
 * suspicious of the other three.
 */

export const REVIEWERS: ReviewerDef[] = [
  {
    id: 'product',
    name: 'Product',
    purpose: 'Is this the right work, and is it bounded?',
    owns: ['epic-outcome-focused', 'epic-coherent', 'epic-bounded', 'invest-valuable', 'invest-negotiable'],
    lens: [
      'You care whether each item describes a change worth making, stated as an outcome rather than as a component.',
      'You are suspicious of items named after systems, layers, or teams, and of scope that quietly expands because nothing was ruled out.',
      'You do not care how hard something is to build — another reviewer covers that. Do not lower a rating for implementation difficulty.'
    ].join(' '),
    observes: true,
    maxRequests: 8
  },
  {
    id: 'delivery',
    name: 'Delivery',
    purpose: 'Can a team actually build and ship this?',
    owns: ['epic-independent', 'epic-right-sized', 'invest-independent', 'invest-estimable', 'invest-small'],
    lens: [
      'You care whether a delivery team could pick this up, size it, and finish it without waiting on the rest of the backlog.',
      'You look for hidden sequencing: work that claims independence but cannot start until something else lands.',
      'You do not judge whether the work is worth doing — another reviewer covers that. Do not lower a rating for weak business value.'
    ].join(' '),
    observes: true,
    maxRequests: 8
  },
  {
    id: 'test',
    name: 'Test',
    purpose: 'Could someone verify this without asking what was meant?',
    owns: ['epic-testable', 'invest-testable'],
    lens: [
      'You read every acceptance criterion as the person who will have to execute it.',
      'You flag judgement words ("appropriate", "properly", "seamless"), criteria that describe internal state nobody can observe, and criteria that only restate the scope.',
      'You also look for the cases nobody wrote down: empty states, failure paths, permissions, and what happens on the second attempt.',
      'Missing negative cases are an observation, not a lower rating, unless the criteria that do exist are themselves unverifiable.'
    ].join(' '),
    observes: true,
    maxRequests: 6
  },
  {
    id: 'evidence',
    name: 'Evidence',
    purpose: 'Is every claim supported by the source, and what did the source ask for that nobody covered?',
    owns: ['epic-traceable'],
    lens: [
      'Your remit is to be suspicious. You compare each item against the source material and flag scope that the source never asked for — invented compliance obligations, integrations, or security requirements are the usual offenders.',
      'You work in the other direction too: name requirements the source states or plainly implies that no item in this backlog covers. Non-functional requirements are where this goes wrong most often — performance, availability, accessibility, data residency, auditability, and retention are routinely dropped during decomposition.',
      'A gap you find is an observation against the item it should have belonged to, or against the epic when nothing fits.',
      'Do not invent requirements of your own. If the source does not support it, it is not a gap.'
    ].join(' '),
    observes: true,
    maxRequests: 6
  }
];

export function reviewerById(id: string): ReviewerDef | undefined {
  return REVIEWERS.find((r) => r.id === id);
}

/** Criteria this reviewer owns that apply at the given level. */
export function ownedAt(reviewer: ReviewerDef, level: 'epic' | 'story'): string[] {
  return reviewer.owns.filter((id) => ALL_CRITERIA.find((c) => c.id === id)?.appliesTo.includes(level));
}
