import { z } from 'zod';

/**
 * These schemas do double duty: they validate model output, and they are the
 * source of the JSON Schema we hand to the model as a forced tool call.
 */

export const AcceptanceCriterionSchema = z.object({
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1)
});

export const EpicProposalSchema = z.object({
  /** Stable slug derived by the model; used for idempotency before a Jira key exists. */
  ref: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'ref must be lowercase kebab-case'),
  title: z.string().min(1).max(255),
  outcome: z.string().min(1).describe('The user- or business-facing outcome this epic delivers.'),
  description: z.string().min(1),
  inScope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
  dependsOn: z.array(z.string()).default([]).describe('refs of other epics this one depends on'),
  sizing: z.enum(['S', 'M', 'L', 'XL']).default('M'),
  openQuestions: z.array(z.string()).default([]),
  sourceEvidence: z
    .array(z.string())
    .default([])
    .describe('Short verbatim quotes from the PRD supporting this epic.')
});

export const StoryProposalSchema = z.object({
  ref: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'ref must be lowercase kebab-case'),
  epicRef: z.string().min(1),
  title: z.string().min(1).max(255),
  narrative: z.object({
    asA: z.string().min(1),
    iWant: z.string().min(1),
    soThat: z.string().min(1)
  }),
  description: z.string().default(''),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  points: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8), z.literal(13)]).default(3),
  openQuestions: z.array(z.string()).default([])
});

export const PrdSkeletonSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  goals: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  personas: z.array(z.object({ name: z.string(), needs: z.string() })).default([]),
  constraints: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  /** Things the PRD asserts without evidence, or that contradict each other. */
  risks: z.array(z.string()).default([])
});

export const EpicsEnvelopeSchema = z.object({ epics: z.array(EpicProposalSchema).min(1) });
export const StoriesEnvelopeSchema = z.object({ stories: z.array(StoryProposalSchema).min(1) });

/* ------------------------------------------------------- persisted backlog */

/**
 * The on-disk shape. Backlog files are meant to be hand-edited, so the load
 * path validates through these schemas rather than casting: an omitted
 * `inScope:` becomes `[]` instead of an undefined that explodes later during
 * rendering, and a genuinely malformed file reports which field is wrong.
 */
export const SyncStateSchema = z
  .object({
    jiraKey: z.string().optional(),
    jiraUrl: z.string().optional(),
    pushedHash: z.string().optional(),
    pushedAt: z.string().optional()
  })
  .default({});

export const StoryItemSchema = StoryProposalSchema.extend({ sync: SyncStateSchema });

export const EpicItemSchema = EpicProposalSchema.extend({
  sync: SyncStateSchema,
  stories: z.array(StoryItemSchema).default([])
});

export const BacklogSchema = z.object({
  version: z.literal(1),
  source: z.object({
    kind: z.literal('confluence'),
    pageId: z.string(),
    title: z.string(),
    url: z.string(),
    pageVersion: z.number().optional(),
    ingestedAt: z.string()
  }),
  target: z.object({
    projectKey: z.string(),
    epicIssueType: z.string().default('Epic'),
    storyIssueType: z.string().default('Story')
  }),
  prd: PrdSkeletonSchema,
  epics: z.array(EpicItemSchema).default([])
});

export const CritiqueSchema = z.object({
  findings: z
    .array(
      z.object({
        ref: z.string(),
        severity: z.enum(['blocker', 'major', 'minor']),
        issue: z.string(),
        suggestion: z.string()
      })
    )
    .default([])
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type EpicProposal = z.infer<typeof EpicProposalSchema>;
export type StoryProposal = z.infer<typeof StoryProposalSchema>;
export type PrdSkeleton = z.infer<typeof PrdSkeletonSchema>;
export type Critique = z.infer<typeof CritiqueSchema>;
