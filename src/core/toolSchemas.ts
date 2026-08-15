/**
 * Hand-written JSON Schema for the emit-tools.
 *
 * Deliberately not generated from the zod schemas: generated output carries
 * $refs and definitions that some model backends handle poorly, and the
 * descriptions here are prompt engineering, not documentation. The zod schemas
 * remain the validation authority — these two must be kept in step.
 */

const acceptanceCriteria = {
  type: 'array',
  description: 'Gherkin-style acceptance criteria. Each must be independently testable.',
  items: {
    type: 'object',
    properties: {
      given: { type: 'string', description: 'Precondition or starting state.' },
      when: { type: 'string', description: 'The action taken.' },
      then: { type: 'string', description: 'The observable, verifiable outcome.' }
    },
    required: ['given', 'when', 'then']
  }
} as const;

export const PRD_SKELETON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', description: 'Two or three sentences, no marketing language.' },
    goals: { type: 'array', items: { type: 'string' } },
    nonGoals: { type: 'array', items: { type: 'string' } },
    personas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, needs: { type: 'string' } },
        required: ['name', 'needs']
      }
    },
    constraints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Technical, regulatory, timeline, or budget constraints stated in the document.'
    },
    openQuestions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Questions a delivery team would have to ask before starting. Include anything the document leaves ambiguous. This is the highest-value field — be thorough.'
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Internal contradictions, unsupported assertions, or scope that looks undeliverable.'
    }
  },
  required: ['title', 'summary', 'goals', 'openQuestions']
} as const;

export const EPICS_SCHEMA = {
  type: 'object',
  properties: {
    epics: {
      type: 'array',
      description: 'Between 3 and 8 epics. Fewer, larger epics beat many thin ones.',
      items: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Stable lowercase kebab-case identifier, e.g. "tenant-onboarding". Unique within this set.'
          },
          title: { type: 'string', description: 'Under 80 characters, no ticket-speak prefixes.' },
          outcome: {
            type: 'string',
            description: 'The user- or business-facing change that exists once this epic ships. Not a list of tasks.'
          },
          description: { type: 'string', description: 'Two to four paragraphs of markdown.' },
          priority: {
            type: 'string',
            enum: ['Must', 'Should', 'Could'],
            description: 'MoSCoW. Use the source document\'s own priority where it states one.'
          },
          successMeasures: {
            type: 'array',
            items: { type: 'string' },
            description:
              'How anyone would know the outcome happened. Measurable, with a number and a timeframe where the document gives one, e.g. "call volume down 40% against the pre-launch baseline". Not a restatement of the outcome.'
          },
          nonFunctional: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Performance, availability, accessibility, security, data residency and similar constraints that apply to this epic. Quote the document\'s figures rather than inventing thresholds.'
          },
          assumptions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Things being taken as true in order to proceed. Different from an open question: an assumption is a decision, a question is unresolved. Do not duplicate between the two.'
          },
          inScope: { type: 'array', items: { type: 'string' } },
          outOfScope: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit exclusions. Prevents scope drift during refinement.'
          },
          acceptanceCriteria,
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'refs of other epics in this set that must land first. Use sparingly.'
          },
          sizing: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
          openQuestions: { type: 'array', items: { type: 'string' } },
          sourceEvidence: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Short verbatim quotes from the source document that justify this epic. If you cannot quote the source, do not propose the epic.'
          }
        },
        required: ['ref', 'title', 'outcome', 'description', 'priority', 'acceptanceCriteria', 'successMeasures', 'sizing']
      }
    }
  },
  required: ['epics']
} as const;

export const STORIES_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      description: 'Between 3 and 10 stories per epic. Each must be independently deliverable.',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Stable lowercase kebab-case identifier, unique across the backlog.' },
          epicRef: { type: 'string', description: 'The ref of the parent epic.' },
          title: { type: 'string' },
          narrative: {
            type: 'object',
            properties: {
              asA: { type: 'string', description: 'A concrete role from the PRD personas, not "user".' },
              iWant: { type: 'string' },
              soThat: { type: 'string', description: 'The benefit, not a restatement of the want.' }
            },
            required: ['asA', 'iWant', 'soThat']
          },
          description: { type: 'string' },
          priority: {
            type: 'string',
            enum: ['Must', 'Should', 'Could'],
            description: 'MoSCoW. Inherit the epic\'s priority unless this story is plainly less or more urgent.'
          },
          acceptanceCriteria,
          assumptions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Things being taken as true in order to proceed. Not the same as an open question.'
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description:
              'refs of other stories that must land first. Leave empty wherever you can — a story that depends on nothing is worth more than one that does.'
          },
          points: { type: 'number', enum: [1, 2, 3, 5, 8, 13] },
          openQuestions: { type: 'array', items: { type: 'string' } }
        },
        required: ['ref', 'epicRef', 'title', 'narrative', 'priority', 'acceptanceCriteria', 'points']
      }
    }
  },
  required: ['stories']
} as const;

export const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The ref of the item this finding applies to.' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          issue: { type: 'string' },
          suggestion: { type: 'string', description: 'A concrete rewrite or split, not general advice.' }
        },
        required: ['ref', 'severity', 'issue', 'suggestion']
      }
    }
  },
  required: ['findings']
} as const;
