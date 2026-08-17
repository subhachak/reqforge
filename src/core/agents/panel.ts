import { z } from 'zod';
import type { Backlog, EpicItem, StoryItem } from '../model';
import { epicFingerprint, epicToMarkdown, storyFingerprint, storyToMarkdown } from '../model';
import type { LlmCancellation, LlmPort } from '../ports';
import type { Progress } from '../pipeline/decompose';
import { zodParser } from '../pipeline/parse';
import { criterionById } from '../rubric/criteria';
import { cacheKey } from '../rubric/score';
import { MAX_RATING, type Level, type Severity } from '../rubric/types';
import { Orchestrator } from './orchestrator';
import { ownedAt, REVIEWERS } from './reviewers';
import type { AttributedCriterion, Conflict, Observation, PanelResult, ReviewerRun } from '../findings';
import type { ReviewerDef } from './types';

/**
 * Runs the reviewer panel over a backlog.
 *
 * Deliberately model-only: this module never imports AtlassianPort and cannot
 * reach Jira. Retrieval-backed steps (duplicate detection, evidence lookup)
 * wrap the panel from the pipeline layer instead, so a reviewer can never
 * surprise anyone by writing to a live project. A smoke test enforces it.
 */

const SEVERITIES = ['blocker', 'warn', 'info'] as const;

const ReviewSchema = z.object({
  reviews: z
    .array(
      z.object({
        ref: z.string().min(1),
        criteria: z
          .array(
            z.object({
              id: z.string().min(1),
              rating: z.number().int().min(0).max(MAX_RATING),
              justification: z.string().min(1),
              suggestion: z.string().default('')
            })
          )
          .default([]),
        observations: z
          .array(
            z.object({
              severity: z.enum(SEVERITIES).default('warn'),
              message: z.string().min(1),
              field: z.string().default('')
            })
          )
          .default([])
      })
    )
    .min(1)
});

const ConflictSchema = z.object({
  conflicts: z
    .array(
      z.object({
        ref: z.string().min(1),
        reviewerA: z.string().min(1),
        reviewerB: z.string().min(1),
        positionA: z.string().min(1),
        positionB: z.string().min(1),
        tradeoff: z.string().min(1)
      })
    )
    .default([])
});

function reviewToolSchema(reviewer: ReviewerDef, level: Level, ids: string[]) {
  const observations = reviewer.observes
    ? {
        observations: {
          type: 'array',
          description:
            'Findings that matter but that none of your criteria has a number for. Leave empty unless you have something specific. Never restate a criterion rating here.',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: [...SEVERITIES] },
              message: { type: 'string', description: 'One specific, actionable sentence.' },
              field: { type: 'string', description: 'The field this concerns, or an empty string.' }
            },
            required: ['severity', 'message', 'field']
          }
        }
      }
    : {};

  return {
    type: 'object',
    properties: {
      reviews: {
        type: 'array',
        description: `One entry per ${level} supplied, in the same order.`,
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: `The ref of the ${level} being reviewed.` },
            criteria: {
              type: 'array',
              description: `Exactly one entry for each of: ${ids.join(', ')}. Rate no others.`,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', enum: ids },
                  rating: {
                    type: 'number',
                    description: '0 absent, 1 poor, 2 acceptable, 3 good. Use the anchors given for each criterion.'
                  },
                  justification: {
                    type: 'string',
                    description:
                      'One sentence citing the specific wording that earned this rating. Never restate the criterion definition.'
                  },
                  suggestion: {
                    type: 'string',
                    description: 'A concrete rewrite or split that would raise the rating. Empty when the rating is 3.'
                  }
                },
                required: ['id', 'rating', 'justification', 'suggestion']
              }
            },
            ...observations
          },
          required: ['ref', 'criteria', ...(reviewer.observes ? ['observations'] : [])]
        }
      }
    },
    required: ['reviews']
  };
}

/**
 * The half of the prompt every reviewer sees identically.
 *
 * Split out so it can be sent as a cacheable prefix: caching pays only on an
 * exact shared prefix, and four reviewers reading the same source is the
 * clearest instance of that in this system. Adapters without caching prepend
 * it, so the model sees the same prompt either way.
 */
function sharedPrefix(context: string, source: string): string {
  return [context ? `## Context\n${context}` : '', source ? `## Source material\n\n${source}` : '']
    .filter(Boolean)
    .join('\n\n');
}

function reviewPrompt(
  reviewer: ReviewerDef,
  level: Level,
  ids: string[],
  items: { ref: string; title: string; markdown: string }[]
): string {
  const defs = ids
    .map((id) => criterionById(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map(
      (c) =>
        `### ${c.id} — ${c.name} (${c.standard})\n${c.definition}\nRate 3 when: ${c.anchors.good}\nRate 0 when: ${c.anchors.bad}`
    )
    .join('\n\n');

  return [
    'You are assisting a software engineering team with backlog quality review in Jira.',
    `You are the ${reviewer.name} reviewer on a panel. Other reviewers cover the criteria you do not own; do not compensate for them.`,
    '',
    `Your remit: ${reviewer.purpose}`,
    reviewer.lens,
    '',
    'Rules:',
    `- Rate every criterion listed below, for every ${level} supplied. Rate nothing else.`,
    '- Judge only what is written. Do not assume unstated detail is present.',
    '- Justify each rating by citing the specific wording that earned it. A justification that could apply to any item is not acceptable.',
    '- Be willing to give 3, and be willing to give 0. Inflated ratings make the rubric useless.',
    '- suggestion must be a concrete rewrite or split, never generic advice such as "add more detail".',
    reviewer.observes
      ? '- Raise an observation only for something real and specific that your criteria cannot express. An empty list is a perfectly good answer.'
      : '',
    '',
    '## Your criteria',
    '',
    defs,
    '',
    `## ${level === 'story' ? 'Stories' : 'Epics'} to review`,
    '',
    items.map((i) => `<item ref="${i.ref}">\n# ${i.title}\n\n${i.markdown}\n</item>`).join('\n\n'),
    '',
    'Call the emit tool with one review per item.'
  ]
    .filter(Boolean)
    .join('\n');
}

export interface PanelOptions {
  /** Review only these refs. Omit for everything. */
  only?: { epics?: string[]; stories?: string[] };
  /** Skip items already reviewed at their current fingerprint. */
  cached?: Map<string, AttributedCriterion[]>;
  batchSize?: number;
  /** Skip the reconciliation pass. Saves one request; loses the conflicts. */
  detectConflicts?: boolean;
  progress?: Progress;
  token?: LlmCancellation;
  onEvent?: ConstructorParameters<typeof Orchestrator>[1] extends { onEvent?: infer E } ? E : never;
  maxTotalRequests?: number;
  concurrency?: number;
}

/**
 * What every reviewer is told about the source.
 *
 * The backlog keeps a distilled skeleton rather than the raw document, which is
 * the right trade for file size but means the evidence reviewer is checking
 * against the extraction, not the original. That is a real limitation and worth
 * naming: it can catch scope the skeleton never mentions, and it cannot catch
 * something the extraction step dropped.
 *
 * Withholding this from the other reviewers is tempting and wrong — "is this
 * outcome-shaped" is not answerable without knowing what was asked for.
 */
function sourceBlock(backlog: Backlog): string {
  const prd = backlog.prd;
  const section = (label: string, lines: string[]) =>
    lines.length > 0 ? `${label}:\n${lines.map((l) => `- ${l}`).join('\n')}` : '';

  return [
    section('Goals', prd.goals),
    section('Explicit non-goals', prd.nonGoals),
    section('Constraints', prd.constraints),
    section('Risks', prd.risks),
    section(
      'Personas',
      prd.personas.map((p) => `${p.name} — ${p.needs}`)
    ),
    section('Open questions from the source', prd.openQuestions)
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runPanel(llm: LlmPort, backlog: Backlog, opts: PanelOptions = {}): Promise<PanelResult> {
  const orchestrator = new Orchestrator(llm, {
    maxTotalRequests: opts.maxTotalRequests,
    // Copilot rate-limits hard enough that fanning four reviewers out at once
    // makes a run slower, not faster; a provider with real headroom does not,
    // and the panel is the one place in this system with genuinely independent
    // work to overlap.
    concurrency: opts.concurrency ?? (llm.kind === 'anthropic' ? 4 : 2),
    onEvent: opts.onEvent,
    token: opts.token
  });

  const batchSize = opts.batchSize ?? 4;
  const context = [
    `${backlog.source.kind === 'jira' ? 'Source epic' : 'Source document'}: ${backlog.source.title}`,
    backlog.prd.summary ? `Summary: ${backlog.prd.summary}` : '',
    backlog.prd.personas.length
      ? `Known personas: ${backlog.prd.personas.map((p) => p.name).join(', ')}`
      : 'No personas are recorded, so do not penalise a story for using a plausible role.'
  ]
    .filter(Boolean)
    .join('\n');

  const source = sourceBlock(backlog);

  const wantEpic = (e: EpicItem) => !opts.only?.epics || opts.only.epics.includes(e.ref);
  const wantStory = (s: StoryItem) => !opts.only?.stories || opts.only.stories.includes(s.ref);

  const epics = backlog.epics.filter((e) => !e.container && wantEpic(e));
  const stories = backlog.epics.flatMap((e) => e.stories.filter(wantStory).map((s) => ({ story: s, epic: e })));

  const criteria = new Map<string, AttributedCriterion[]>();
  const observations: Observation[] = [];

  // Merging rather than replacing: two reviewers write to the same item key
  // from different tasks, and the second must not erase the first.
  const addCriteria = (key: string, next: AttributedCriterion[]) => {
    const existing = criteria.get(key);
    if (existing) existing.push(...next);
    else criteria.set(key, [...next]);
  };

  const outcomes = await orchestrator.parallel(
    REVIEWERS.map((reviewer) => ({
      agentId: reviewer.id,
      maxRequests: reviewer.maxRequests,
      work: async (leased: LlmPort) => {
        let rated = 0;

        const epicIds = ownedAt(reviewer, 'epic');
        if (epicIds.length > 0) {
          for (let i = 0; i < epics.length; i += batchSize) {
            const batch = epics.slice(i, i + batchSize).filter((e) => {
              const key = cacheKey('epic', e.ref, epicFingerprint(e));
              return !opts.cached?.get(key)?.some((c) => c.reviewerId === reviewer.id);
            });
            if (batch.length === 0) continue;
            opts.progress?.report(`${reviewer.name}: epics ${i + 1}–${i + batch.length} of ${epics.length}…`);

            const reviews = await callReviewer(
              leased,
              reviewer,
              'epic',
              epicIds,
              batch.map((e) => ({ ref: e.ref, title: e.title, markdown: epicToMarkdown(e) })),
              sharedPrefix(context, source),
              opts.token
            );

            for (const review of reviews) {
              const epic = batch.find((e) => e.ref === review.ref);
              if (!epic) continue;
              addCriteria(cacheKey('epic', epic.ref, epicFingerprint(epic)), review.criteria);
              observations.push(...review.observations.map((o) => ({ ...o, level: 'epic' as const, ref: epic.ref })));
              rated++;
            }
          }
        }

        const storyIds = ownedAt(reviewer, 'story');
        if (storyIds.length > 0) {
          for (let i = 0; i < stories.length; i += batchSize) {
            const batch = stories.slice(i, i + batchSize).filter(({ story }) => {
              const key = cacheKey('story', story.ref, storyFingerprint(story));
              return !opts.cached?.get(key)?.some((c) => c.reviewerId === reviewer.id);
            });
            if (batch.length === 0) continue;
            opts.progress?.report(`${reviewer.name}: stories ${i + 1}–${i + batch.length} of ${stories.length}…`);

            const epicContext = `${context}\nThese stories belong to the epic "${batch[0].epic.title}": ${batch[0].epic.outcome}`;
            const reviews = await callReviewer(
              leased,
              reviewer,
              'story',
              storyIds,
              batch.map(({ story }) => ({ ref: story.ref, title: story.title, markdown: storyToMarkdown(story) })),
              sharedPrefix(epicContext, source),
              opts.token
            );

            for (const review of reviews) {
              const hit = batch.find(({ story }) => story.ref === review.ref);
              if (!hit) continue;
              addCriteria(cacheKey('story', hit.story.ref, storyFingerprint(hit.story)), review.criteria);
              observations.push(
                ...review.observations.map((o) => ({ ...o, level: 'story' as const, ref: hit.story.ref }))
              );
              rated++;
            }
          }
        }

        return rated;
      }
    }))
  );

  const runs: ReviewerRun[] = outcomes.map((o) => ({
    reviewerId: o.agentId,
    ok: o.ok,
    requests: o.requests,
    ms: o.ms,
    error: o.error,
    itemsRated: o.value ?? 0
  }));

  const failed = new Set(runs.filter((r) => !r.ok).map((r) => r.reviewerId));
  const unrated = REVIEWERS.filter((r) => failed.has(r.id)).flatMap((r) => r.owns);

  const conflicts =
    opts.detectConflicts === false || orchestrator.requestsRemaining === 0 || orchestrator.cancelled
      ? []
      : await detectConflicts(orchestrator, backlog, criteria, opts.token);

  return { criteria, observations, conflicts, runs, partial: failed.size > 0, unrated };
}

async function callReviewer(
  llm: LlmPort,
  reviewer: ReviewerDef,
  level: Level,
  ids: string[],
  items: { ref: string; title: string; markdown: string }[],
  prefix: string,
  token: LlmCancellation | undefined
): Promise<{ ref: string; criteria: AttributedCriterion[]; observations: Omit<Observation, 'level' | 'ref'>[] }[]> {
  const parsed = await llm.requestStructured<z.infer<typeof ReviewSchema>>(
    {
      cachedPrefix: prefix,
      messages: [{ role: 'user', content: reviewPrompt(reviewer, level, ids, items) }],
      toolName: 'emit_review',
      toolDescription: `Record the ${reviewer.name} reviewer's findings for each ${level}.`,
      inputSchema: reviewToolSchema(reviewer, level, ids),
      parse: zodParser(ReviewSchema),
      justification: `ReqForge's ${reviewer.name} reviewer is assessing ${items.length} ${level}(s).`
    },
    token
  );

  const owned = new Set(ids);
  const at = new Date().toISOString();

  return parsed.reviews.map((review) => ({
    ref: review.ref,
    // A reviewer rating a criterion it does not own is dropped rather than
    // allowed to overwrite the owner's rating — the partition is the guarantee
    // that makes the score reproducible.
    criteria: review.criteria
      .filter((c) => owned.has(c.id))
      .map<AttributedCriterion>((c) => ({
        id: c.id,
        rating: c.rating as AttributedCriterion['rating'],
        justification: c.justification,
        suggestion: c.suggestion,
        reviewerId: reviewer.id
      })),
    observations: review.observations.map((o) => ({
      reviewerId: reviewer.id,
      severity: o.severity as Severity,
      message: o.message,
      field: o.field || undefined,
      at
    }))
  }));
}

/** Items where two reviewers both asked for a change — the only place a conflict can live. */
function contestedItems(criteria: Map<string, AttributedCriterion[]>): {
  key: string;
  level: Level;
  ref: string;
  suggestions: AttributedCriterion[];
}[] {
  const out: { key: string; level: Level; ref: string; suggestions: AttributedCriterion[] }[] = [];
  for (const [key, list] of criteria) {
    const suggestions = list.filter((c) => c.suggestion.trim().length > 0);
    if (new Set(suggestions.map((s) => s.reviewerId)).size < 2) continue;
    const [level, ref] = key.split(':');
    out.push({ key, level: level as Level, ref, suggestions });
  }
  return out;
}

/**
 * One extra call, and the only place a model is asked to reason across
 * reviewers.
 *
 * This is genuinely not a code problem: deciding whether "split this epic" and
 * "this is already the minimum coherent outcome" contradict each other requires
 * reading both. It is bounded to the items where two reviewers actually asked
 * for changes, so a clean backlog costs nothing.
 */
async function detectConflicts(
  orchestrator: Orchestrator,
  backlog: Backlog,
  criteria: Map<string, AttributedCriterion[]>,
  token: LlmCancellation | undefined
): Promise<Conflict[]> {
  const contested = contestedItems(criteria).slice(0, 12);
  if (contested.length === 0) return [];

  const titleOf = (level: Level, ref: string): string => {
    if (level === 'epic') return backlog.epics.find((e) => e.ref === ref)?.title ?? ref;
    return backlog.epics.flatMap((e) => e.stories).find((s) => s.ref === ref)?.title ?? ref;
  };

  const blocks = contested
    .map(({ level, ref, suggestions }) =>
      [
        `<item ref="${ref}" level="${level}">`,
        `# ${titleOf(level, ref)}`,
        ...suggestions.map((s) => `- [${s.reviewerId}] on ${s.id}: ${s.suggestion}`),
        '</item>'
      ].join('\n')
    )
    .join('\n\n');

  const outcome = await orchestrator.run('reconciler', 1, async (llm) =>
    llm.requestStructured<z.infer<typeof ConflictSchema>>(
      {
        messages: [
          {
            role: 'user',
            content: [
              'You are assisting a software engineering team with backlog review in Jira.',
              'Several specialist reviewers have each suggested changes to the same items. Your only job is to find places where two suggestions genuinely pull in opposite directions, so a product owner can decide between them.',
              '',
              'Rules:',
              '- Report a conflict only when following one suggestion would undo or prevent the other. Two suggestions about different parts of the same item are not a conflict.',
              '- Do not resolve the conflict or pick a side. State each position fairly, in that reviewer\'s own terms.',
              '- tradeoff states, in one sentence, what the product owner actually has to decide.',
              '- Most items have no conflict. An empty list is the expected answer.',
              '',
              '## Suggestions',
              '',
              blocks,
              '',
              'Call the emit tool.'
            ].join('\n')
          }
        ],
        toolName: 'emit_conflicts',
        toolDescription: 'Record genuine contradictions between reviewers.',
        inputSchema: {
          type: 'object',
          properties: {
            conflicts: {
              type: 'array',
              description: 'Only genuine contradictions. Empty when the reviewers agree.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  reviewerA: { type: 'string' },
                  reviewerB: { type: 'string' },
                  positionA: { type: 'string', description: "The first reviewer's position, in one sentence." },
                  positionB: { type: 'string', description: "The second reviewer's position, in one sentence." },
                  tradeoff: { type: 'string', description: 'What the product owner has to decide.' }
                },
                required: ['ref', 'reviewerA', 'reviewerB', 'positionA', 'positionB', 'tradeoff']
              }
            }
          },
          required: ['conflicts']
        },
        parse: zodParser(ConflictSchema),
        justification: `ReqForge is checking ${contested.length} item(s) where reviewers disagreed.`
      },
      token
    )
  );

  if (!outcome.ok || !outcome.value) return [];

  const known = new Map(contested.map((c) => [c.ref, c.level]));
  return outcome.value.conflicts
    .filter((c) => known.has(c.ref))
    .map<Conflict>((c) => ({
      level: known.get(c.ref)!,
      ref: c.ref,
      between: [c.reviewerA, c.reviewerB],
      positions: [c.positionA, c.positionB],
      tradeoff: c.tradeoff
    }));
}
