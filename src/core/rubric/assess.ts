import type { Backlog, EpicItem, StoryItem } from '../model';
import { epicFingerprint, epicToMarkdown, storyFingerprint, storyToMarkdown } from '../model';
import type { LlmCancellation, LlmPort } from '../ports';
import { zodParser } from '../pipeline/parse';
import type { Progress } from '../pipeline/decompose';
import { z } from 'zod';
import { criteriaFor } from './criteria';
import { cacheKey } from './score';
import { MAX_RATING, type CriterionResult, type Level, type RubricConfig } from './types';

/**
 * The model-graded half of the rubric.
 *
 * It is never asked for a score. It rates each named criterion 0–3 against a
 * supplied definition and anchors, and justifies every rating. Scoring happens
 * in score.ts from those ratings. This keeps the number reproducible, lets a
 * client reweight criteria without re-running anything, and gives a reviewer
 * something to argue with other than a bare number.
 *
 * Assessments are batched — under Copilot there is no prompt caching, so one
 * call per story would burn quota for no benefit.
 */

const AssessmentSchema = z.object({
  assessments: z
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
          .min(1)
      })
    )
    .min(1)
});

function assessmentToolSchema(level: Level) {
  const ids = criteriaFor(level).map((c) => c.id);
  return {
    type: 'object',
    properties: {
      assessments: {
        type: 'array',
        description: `One entry per ${level} supplied, in the same order.`,
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: `The ref of the ${level} being assessed.` },
            criteria: {
              type: 'array',
              description: `Exactly one entry for each of: ${ids.join(', ')}.`,
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
                      'One sentence citing the specific text that earned this rating. Never restate the criterion definition.'
                  },
                  suggestion: {
                    type: 'string',
                    description:
                      'A concrete rewrite or split that would raise the rating. Empty string when the rating is 3.'
                  }
                },
                required: ['id', 'rating', 'justification', 'suggestion']
              }
            }
          },
          required: ['ref', 'criteria']
        }
      }
    },
    required: ['assessments']
  };
}

function rubricPrompt(level: Level, items: { ref: string; markdown: string; title: string }[], context: string): string {
  const defs = criteriaFor(level)
    .map(
      (c) =>
        `### ${c.id} — ${c.name} (${c.standard})\n${c.definition}\nRate 3 when: ${c.anchors.good}\nRate 0 when: ${c.anchors.bad}`
    )
    .join('\n\n');

  return [
    'You are assisting a software engineering team with backlog quality review in Jira.',
    `You assess ${level === 'story' ? 'user stories' : 'epics'} against a fixed rubric and rate each criterion.`,
    '',
    'Rules:',
    '- Rate every criterion listed below, for every item supplied. Do not skip any.',
    '- Judge only what is written. Do not assume unstated detail is present, and do not penalise an item for scope that deliberately belongs elsewhere.',
    '- Justify each rating by citing the specific wording that earned it. A justification that could apply to any item is not acceptable.',
    '- Be willing to give 3. An item that satisfies the criterion should score 3 even if it could be prettier.',
    '- Be willing to give 0 or 1. Inflated ratings make the rubric useless.',
    '- suggestion must be a concrete rewrite or split, never generic advice such as "add more detail".',
    '',
    '## Criteria',
    '',
    defs,
    '',
    context ? `## Context\n${context}\n` : '',
    `## ${level === 'story' ? 'Stories' : 'Epics'} to assess`,
    '',
    items.map((i) => `<item ref="${i.ref}">\n# ${i.title}\n\n${i.markdown}\n</item>`).join('\n\n'),
    '',
    'Call the emit tool with one assessment per item.'
  ]
    .filter(Boolean)
    .join('\n');
}

export interface AssessOptions {
  /** Assess only these refs. Omit for everything. */
  only?: { epics?: string[]; stories?: string[] };
  /** Skip items whose cached assessment still matches their fingerprint. */
  cached?: Map<string, CriterionResult[]>;
  batchSize?: number;
  progress?: Progress;
  token?: LlmCancellation;
}

/**
 * Assesses a backlog and returns results keyed by `cacheKey`, so a caller can
 * merge them straight into the store and have them invalidate on edit.
 */
export async function assessBacklog(
  llm: LlmPort,
  backlog: Backlog,
  config: RubricConfig,
  opts: AssessOptions = {}
): Promise<Map<string, CriterionResult[]>> {
  const results = new Map<string, CriterionResult[]>(opts.cached ?? []);
  const batchSize = opts.batchSize ?? 4;
  const context = [
    `${backlog.source.kind === 'jira' ? 'Source epic' : 'Source document'}: ${backlog.source.title}`,
    backlog.prd.summary ? `Summary: ${backlog.prd.summary}` : '',
    backlog.prd.personas.length
      ? `Known personas: ${backlog.prd.personas.map((p) => p.name).join(', ')}`
      : 'No personas are recorded for this backlog, so do not penalise a story for using a plausible role.'
  ]
    .filter(Boolean)
    .join('\n');

  /* ------------------------------------------------------------------ epics */

  const epics = backlog.epics.filter(
    (e) =>
      (!opts.only?.epics || opts.only.epics.includes(e.ref)) &&
      !results.has(cacheKey('epic', e.ref, epicFingerprint(e)))
  );

  for (let i = 0; i < epics.length; i += batchSize) {
    const batch = epics.slice(i, i + batchSize);
    opts.progress?.report(`Assessing epics ${i + 1}–${i + batch.length} of ${epics.length}…`);
    await assessBatch(llm, 'epic', batch.map(toEpicInput), context, opts.token, (ref, criteria) => {
      const epic = batch.find((e) => e.ref === ref);
      if (epic) results.set(cacheKey('epic', epic.ref, epicFingerprint(epic)), criteria);
    });
  }

  /* ---------------------------------------------------------------- stories */

  const stories = backlog.epics.flatMap((e) =>
    e.stories
      .filter(
        (s) =>
          (!opts.only?.stories || opts.only.stories.includes(s.ref)) &&
          !results.has(cacheKey('story', s.ref, storyFingerprint(s)))
      )
      .map((s) => ({ story: s, epic: e }))
  );

  for (let i = 0; i < stories.length; i += batchSize) {
    const batch = stories.slice(i, i + batchSize);
    opts.progress?.report(`Assessing stories ${i + 1}–${i + batch.length} of ${stories.length}…`);
    const epicContext = `${context}\nThese stories belong to the epic "${batch[0].epic.title}": ${batch[0].epic.outcome}`;
    await assessBatch(
      llm,
      'story',
      batch.map(({ story }) => toStoryInput(story)),
      epicContext,
      opts.token,
      (ref, criteria) => {
        const hit = batch.find(({ story }) => story.ref === ref);
        if (hit) results.set(cacheKey('story', hit.story.ref, storyFingerprint(hit.story)), criteria);
      }
    );
  }

  return results;
}

async function assessBatch(
  llm: LlmPort,
  level: Level,
  items: { ref: string; title: string; markdown: string }[],
  context: string,
  token: LlmCancellation | undefined,
  onResult: (ref: string, criteria: CriterionResult[]) => void
): Promise<void> {
  if (items.length === 0) return;

  const parsed = await llm.requestStructured<z.infer<typeof AssessmentSchema>>(
    {
      messages: [{ role: 'user', content: rubricPrompt(level, items, context) }],
      toolName: 'emit_quality_assessment',
      toolDescription: `Record a rubric assessment for each ${level}.`,
      inputSchema: assessmentToolSchema(level),
      parse: zodParser(AssessmentSchema),
      justification: `ReqForge is assessing ${items.length} ${level}(s) against the quality rubric.`
    },
    token
  );

  const valid = new Set(criteriaFor(level).map((c) => c.id));
  for (const assessment of parsed.assessments) {
    // Drop criteria the model invented; keep the rest rather than failing the batch.
    const criteria = assessment.criteria
      .filter((c) => valid.has(c.id))
      .map<CriterionResult>((c) => ({
        id: c.id,
        rating: c.rating as CriterionResult['rating'],
        justification: c.justification,
        suggestion: c.suggestion
      }));
    if (criteria.length > 0) onResult(assessment.ref, criteria);
  }
}

function toEpicInput(epic: EpicItem) {
  return { ref: epic.ref, title: epic.title, markdown: epicToMarkdown(epic) };
}

function toStoryInput(story: StoryItem) {
  return { ref: story.ref, title: story.title, markdown: storyToMarkdown(story) };
}
