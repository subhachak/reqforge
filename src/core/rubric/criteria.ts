import type { CriterionDef } from './types';

/**
 * INVEST (Bill Wake, 2003) is the canonical rubric for user stories and is used
 * here verbatim for stories.
 *
 * There is no equally canonical rubric at epic level — INVEST is routinely
 * stretched to fit, but "Negotiable" and "Small" do not mean much for a
 * quarter-sized body of work. The epic criteria below keep the INVEST ideas
 * that do transfer (independent, valuable, testable) and add the three that
 * matter at that altitude: outcome-shaped rather than layer-shaped, explicitly
 * bounded, and traceable to the source document. The last is what a regulated
 * client actually audits.
 */

export const STORY_CRITERIA: CriterionDef[] = [
  {
    id: 'invest-independent',
    name: 'Independent',
    standard: 'INVEST',
    definition:
      'The story can be built and released without waiting for another story in this backlog to land first.',
    anchors: {
      good: 'Delivers end to end on its own, or its dependency is a one-line note rather than a blocking sequence.',
      bad: 'Cannot start until two other stories finish, or is one slice of a technical layer that is useless alone.'
    },
    weight: 1,
    appliesTo: ['story']
  },
  {
    id: 'invest-negotiable',
    name: 'Negotiable',
    standard: 'INVEST',
    definition:
      'The story states what is needed and why, leaving the team room to decide how. It is not a locked-down technical specification.',
    anchors: {
      good: 'Describes the need and the constraints; implementation is left to the team.',
      bad: 'Prescribes specific classes, table names, or library choices, so there is nothing left to discuss.'
    },
    weight: 1,
    appliesTo: ['story']
  },
  {
    id: 'invest-valuable',
    name: 'Valuable',
    standard: 'INVEST',
    definition:
      'The story delivers something a named user or the business would recognise as worth having. The "so that" clause states a real benefit rather than restating the want.',
    anchors: {
      good: 'A concrete role gains a concrete benefit that somebody would pay for.',
      bad: 'The role is "user", or the benefit restates the action ("so that the button works").'
    },
    weight: 1,
    appliesTo: ['story']
  },
  {
    id: 'invest-estimable',
    name: 'Estimable',
    standard: 'INVEST',
    definition: 'A delivery team could size this without further discovery. The unknowns are named rather than hidden.',
    anchors: {
      good: 'Scope and interfaces are clear enough to size; any unknowns appear as open questions.',
      bad: 'Depends on an undecided design or an unnamed external system, so any estimate would be a guess.'
    },
    weight: 1,
    appliesTo: ['story']
  },
  {
    id: 'invest-small',
    name: 'Small',
    standard: 'INVEST',
    definition: 'The story fits comfortably inside a single sprint for one pair.',
    anchors: {
      good: 'A few days of work with a clear finish line.',
      bad: 'Contains several deliverables joined by "and", or is plainly a multi-sprint programme.'
    },
    weight: 1,
    appliesTo: ['story']
  },
  {
    id: 'invest-testable',
    name: 'Testable',
    standard: 'INVEST',
    definition:
      'The acceptance criteria are objectively verifiable. A QA engineer could execute them without asking what was meant.',
    anchors: {
      good: 'Each criterion names a precondition, an action, and an observable result.',
      bad: 'Criteria rely on judgement words such as "appropriate", "properly", "user-friendly", or describe internal state nobody can observe.'
    },
    weight: 1.5,
    appliesTo: ['story']
  }
];

export const EPIC_CRITERIA: CriterionDef[] = [
  {
    id: 'epic-outcome-focused',
    name: 'Outcome-focused',
    standard: 'Outcome-oriented planning',
    definition:
      'The epic is defined by the change it delivers for a user or the business, not by the technical layer it touches.',
    anchors: {
      good: 'Named by what becomes true once it ships.',
      bad: 'Named for a component — "the API", "the database", "the front end" — so it delivers nothing alone.'
    },
    weight: 1.5,
    appliesTo: ['epic']
  },
  {
    id: 'epic-coherent',
    name: 'Coherent',
    standard: 'Single responsibility',
    definition: 'The epic has one purpose. Its scope does not contain a second body of work with a different owner or risk profile.',
    anchors: {
      good: 'Everything in scope serves the one stated outcome.',
      bad: 'Bundles, say, building a capability together with migrating every consumer onto it.'
    },
    weight: 1.5,
    appliesTo: ['epic']
  },
  {
    id: 'epic-independent',
    name: 'Independently deliverable',
    standard: 'INVEST (adapted)',
    definition: 'The epic can ship and provide value without every other epic landing first.',
    anchors: {
      good: 'Few dependencies, and none that block all value until the whole programme is done.',
      bad: 'Sits in the middle of a chain where nothing is usable until the last epic lands.'
    },
    weight: 1,
    appliesTo: ['epic']
  },
  {
    id: 'epic-bounded',
    name: 'Bounded',
    standard: 'Definition of Ready',
    definition: 'The epic states explicitly what it does not cover, so scope cannot quietly expand during refinement.',
    anchors: {
      good: 'A specific out-of-scope list naming the things a reader would otherwise assume were included.',
      bad: 'No exclusions, or exclusions so generic they rule nothing out.'
    },
    weight: 1,
    appliesTo: ['epic']
  },
  {
    id: 'epic-traceable',
    name: 'Traceable',
    standard: 'Requirements traceability',
    definition: 'Every part of the epic can be traced back to something the source document actually says.',
    anchors: {
      good: 'Supported by verbatim evidence from the source, and its scope does not exceed that evidence.',
      bad: 'Introduces compliance, security, or integration scope the source document never mentions.'
    },
    weight: 1,
    appliesTo: ['epic']
  },
  {
    id: 'epic-testable',
    name: 'Testable',
    standard: 'INVEST (adapted)',
    definition: 'The acceptance criteria describe observable outcomes at epic level, not internal implementation checkpoints.',
    anchors: {
      good: 'Each criterion could be demonstrated to a stakeholder.',
      bad: 'Criteria are vague, or describe internal state, or simply restate the scope list.'
    },
    weight: 1.5,
    appliesTo: ['epic']
  },
  {
    id: 'epic-right-sized',
    name: 'Right-sized',
    standard: 'Agile estimation practice',
    definition: 'The epic is large enough to hold several stories and small enough to deliver within a quarter.',
    anchors: {
      good: 'Decomposes naturally into roughly three to ten stories.',
      bad: 'Either a single story wearing a hat, or a programme of work spanning several quarters.'
    },
    weight: 1,
    appliesTo: ['epic']
  }
];

export const ALL_CRITERIA = [...EPIC_CRITERIA, ...STORY_CRITERIA];

export function criteriaFor(level: 'epic' | 'story'): CriterionDef[] {
  return level === 'epic' ? EPIC_CRITERIA : STORY_CRITERIA;
}

export function criterionById(id: string): CriterionDef | undefined {
  return ALL_CRITERIA.find((c) => c.id === id);
}
