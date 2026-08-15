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

/**
 * A link out to something that is not a requirement: a design, a spec, a
 * decision record.
 *
 * Typed rather than a bare url field per tool. A `figmaUrl` field would need a
 * schema change through eight files the first time somebody wants to attach a
 * Miro board, and a `type` costs nothing while letting the editor and the
 * rubric treat a design differently from a reference.
 */
export const ItemLinkSchema = z.object({
  type: z.enum(['design', 'spec', 'reference']).default('reference'),
  label: z.string().default(''),
  url: z.string()
});

/** MoSCoW, because that is what requirements documents already use. */
export const PrioritySchema = z.enum(['Must', 'Should', 'Could']).default('Should');

export const EpicProposalSchema = z.object({
  /** Stable slug derived by the model; used for idempotency before a Jira key exists. */
  ref: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'ref must be lowercase kebab-case'),
  title: z.string().min(1).max(255),
  /**
   * Not required to be non-empty, for the same reason as a story's narrative:
   * an epic read back from a hand-written Jira issue has neither, and refusing
   * to load the file is the wrong response. `has-outcome` is a rubric blocker,
   * which reports it somewhere the user can act on.
   */
  outcome: z.string().default(''),
  description: z.string().default(''),
  priority: PrioritySchema,
  inScope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  /** How anyone would know the outcome actually happened. Measurable, not aspirational. */
  successMeasures: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
  /** Performance, availability, accessibility, security — the half that gets lost. */
  nonFunctional: z.array(z.string()).default([]),
  /** Decisions taken in order to proceed. Distinct from an unresolved question. */
  assumptions: z.array(z.string()).default([]),
  links: z.array(ItemLinkSchema).default([]),
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
  /**
   * Not required to be non-empty. A story pulled from a hand-written Jira
   * issue has no narrative, and refusing to load the file is the wrong
   * response — the `has-narrative` rubric rule is a blocker, which reports the
   * same problem somewhere the user can act on it.
   */
  narrative: z.object({
    asA: z.string().default(''),
    iWant: z.string().default(''),
    soThat: z.string().default('')
  }),
  description: z.string().default(''),
  priority: PrioritySchema,
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  /** Decisions taken in order to proceed. Distinct from an unresolved question. */
  assumptions: z.array(z.string()).default([]),
  /**
   * refs of other stories this one needs first. INVEST scores Independence, so
   * there has to be somewhere to record the dependency being judged.
   */
  dependsOn: z.array(z.string()).default([]),
  links: z.array(ItemLinkSchema).default([]),
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
  stories: z.array(StoryItemSchema).default([]),
  /**
   * A local grouping that does not exist in Jira and must never be created
   * there. Used when a standalone story is pulled in and has no parent epic to
   * sit under. Skipped by the planner and by the rubric.
   */
  container: z.boolean().default(false)
});

export const BacklogSchema = z.object({
  version: z.literal(1),
  source: z.object({
    kind: z.enum(['confluence', 'jira']),
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
export type Priority = z.infer<typeof PrioritySchema>;
export type ItemLink = z.infer<typeof ItemLinkSchema>;
export type Critique = z.infer<typeof CritiqueSchema>;
