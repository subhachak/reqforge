import type { AtlassianPort, LlmCancellation, LlmPort } from '../ports';
import type { Backlog, EpicItem } from '../model';
import { slugify } from '../model';
import {
  critiqueEpicsPrompt,
  extractSkeletonPrompt,
  proposeEpicsPrompt,
  proposeStoriesPrompt,
  reviseEpicsPrompt
} from '../prompts';
import {
  CritiqueSchema,
  EpicsEnvelopeSchema,
  PrdSkeletonSchema,
  StoriesEnvelopeSchema,
  type Critique,
  type EpicProposal,
  type PrdSkeleton,
  type StoryProposal
} from '../schemas';
import { CRITIQUE_SCHEMA, EPICS_SCHEMA, PRD_SKELETON_SCHEMA, STORIES_SCHEMA } from '../toolSchemas';
import { zodParser } from './parse';

export interface Progress {
  report(message: string): void;
}

export interface DecomposeOptions {
  pageIdOrUrl: string;
  projectKey: string;
  epicIssueType: string;
  storyIssueType: string;
  /** Run the critic + revise pass. Costs two extra model calls; materially improves output. */
  critique: boolean;
  progress?: Progress;
  token?: LlmCancellation;
}

/**
 * PRD -> epics. Deliberately staged rather than one big call: each stage is
 * separately retryable, separately inspectable, and the intermediate skeleton
 * is itself useful output (the open questions are often the best deliverable).
 */
export async function decomposePrd(
  atlassian: AtlassianPort,
  llm: LlmPort,
  opts: DecomposeOptions
): Promise<{ backlog: Backlog; slug: string; critique?: Critique }> {
  const report = (m: string) => opts.progress?.report(m);

  report('Fetching Confluence page…');
  const page = await atlassian.getConfluencePage(opts.pageIdOrUrl);
  if (!page.markdown.trim()) {
    throw new Error(`Confluence page "${page.title}" appears to be empty after conversion.`);
  }

  const markdown = await fitToContext(llm, page.markdown);

  report('Extracting requirements structure…');
  const skeleton = await llm.requestStructured<PrdSkeleton>(
    {
      messages: [{ role: 'user', content: extractSkeletonPrompt(page.title, markdown) }],
      toolName: 'emit_prd_structure',
      toolDescription: 'Record the extracted structure of the requirements document.',
      inputSchema: PRD_SKELETON_SCHEMA,
      parse: zodParser(PrdSkeletonSchema),
      justification: 'ReqForge is extracting the structure of your requirements document.'
    },
    opts.token
  );

  report('Proposing epics…');
  let epics = (
    await llm.requestStructured<{ epics: EpicProposal[] }>(
      {
        messages: [{ role: 'user', content: proposeEpicsPrompt(skeleton, markdown) }],
        toolName: 'emit_epics',
        toolDescription: 'Record the proposed epic breakdown.',
        inputSchema: EPICS_SCHEMA,
        parse: zodParser(EpicsEnvelopeSchema),
        justification: 'ReqForge is decomposing your requirements document into epics.'
      },
      opts.token
    )
  ).epics;

  let critique: Critique | undefined;
  if (opts.critique) {
    report('Reviewing the breakdown…');
    critique = await llm.requestStructured<Critique>(
      {
        messages: [{ role: 'user', content: critiqueEpicsPrompt(JSON.stringify(epics, null, 2)) }],
        toolName: 'emit_review_findings',
        toolDescription: 'Record problems found in the proposed epic breakdown.',
        inputSchema: CRITIQUE_SCHEMA,
        parse: zodParser(CritiqueSchema),
        justification: 'ReqForge is reviewing the proposed epic breakdown for quality.'
      },
      opts.token
    );

    const actionable = critique.findings.filter((f) => f.severity !== 'minor');
    if (actionable.length > 0) {
      report(`Applying ${actionable.length} review finding(s)…`);
      epics = (
        await llm.requestStructured<{ epics: EpicProposal[] }>(
          {
            messages: [
              {
                role: 'user',
                content: reviseEpicsPrompt(JSON.stringify(epics, null, 2), JSON.stringify(critique, null, 2))
              }
            ],
            toolName: 'emit_epics',
            toolDescription: 'Record the corrected epic breakdown.',
            inputSchema: EPICS_SCHEMA,
            parse: zodParser(EpicsEnvelopeSchema),
            justification: 'ReqForge is applying review findings to the epic breakdown.'
          },
          opts.token
        )
      ).epics;
    }
  }

  const backlog: Backlog = {
    version: 1,
    source: {
      kind: 'confluence',
      pageId: page.id,
      title: page.title,
      url: page.webUrl,
      pageVersion: page.version,
      ingestedAt: new Date().toISOString()
    },
    target: {
      projectKey: opts.projectKey,
      epicIssueType: opts.epicIssueType,
      storyIssueType: opts.storyIssueType
    },
    prd: skeleton,
    epics: dedupeRefs(epics).map<EpicItem>((e) => ({ ...e, sync: {}, stories: [] }))
  };

  return { backlog, slug: slugify(page.title), critique };
}

/** Epic -> stories. Batched so we do not re-send the whole context per epic. */
export async function decomposeEpics(
  llm: LlmPort,
  backlog: Backlog,
  epicRefs: string[],
  opts: { batchSize?: number; progress?: Progress; token?: LlmCancellation } = {}
): Promise<Backlog> {
  const batchSize = opts.batchSize ?? 3;
  const targets = backlog.epics.filter((e) => epicRefs.includes(e.ref));
  if (targets.length === 0) throw new Error('No matching epics found in this backlog.');

  const known = new Set(backlog.epics.flatMap((e) => e.stories.map((s) => s.ref)));

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    opts.progress?.report(
      `Generating stories for ${batch.map((e) => e.title).join(', ')} (${i + batch.length}/${targets.length})…`
    );

    const result = await llm.requestStructured<{ stories: StoryProposal[] }>(
      {
        messages: [{ role: 'user', content: proposeStoriesPrompt(batch, backlog.prd) }],
        toolName: 'emit_stories',
        toolDescription: 'Record the proposed stories for the given epics.',
        inputSchema: STORIES_SCHEMA,
        parse: zodParser(StoriesEnvelopeSchema),
        justification: 'ReqForge is breaking your epics into implementable stories.'
      },
      opts.token
    );

    for (const story of result.stories) {
      const epic = backlog.epics.find((e) => e.ref === story.epicRef);
      if (!epic) continue; // model invented an epic ref; drop rather than orphan it
      const ref = uniqueRef(story.ref, known);
      known.add(ref);
      const existing = epic.stories.findIndex((s) => s.ref === ref);
      const item = { ...story, ref, sync: existing >= 0 ? epic.stories[existing].sync : {} };
      if (existing >= 0) epic.stories[existing] = item;
      else epic.stories.push(item);
    }
  }

  return backlog;
}

/**
 * Trims the document to fit the model's window. Head-and-tail rather than a
 * plain truncation: PRDs put the summary at the top and the requirements
 * tables at the bottom, and losing either produces a bad breakdown.
 */
async function fitToContext(llm: LlmPort, markdown: string): Promise<string> {
  const budget = await llm.contextWindow();
  // Reserve room for prompt scaffolding and the emitted structure.
  const docBudget = Math.floor(budget * 0.6);
  const tokens = await llm.countTokens(markdown);
  if (tokens <= docBudget) return markdown;

  const ratio = docBudget / tokens;
  const keep = Math.floor(markdown.length * ratio);
  const head = markdown.slice(0, Math.floor(keep * 0.65));
  const tail = markdown.slice(markdown.length - Math.floor(keep * 0.35));
  return `${head}\n\n[... ${Math.round((1 - ratio) * 100)}% of the document omitted to fit the model context window ...]\n\n${tail}`;
}

function dedupeRefs(epics: EpicProposal[]): EpicProposal[] {
  const seen = new Set<string>();
  return epics.map((e) => {
    const ref = uniqueRef(e.ref, seen);
    seen.add(ref);
    return { ...e, ref };
  });
}

function uniqueRef(ref: string, taken: Set<string>): string {
  if (!taken.has(ref)) return ref;
  let n = 2;
  while (taken.has(`${ref}-${n}`)) n++;
  return `${ref}-${n}`;
}
