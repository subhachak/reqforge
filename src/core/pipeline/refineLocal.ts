import type { LlmCancellation, LlmPort } from '../ports';
import type { Backlog, EpicItem, StoryItem } from '../model';
import { epicToMarkdown, storyToMarkdown } from '../model';
import { refineIssuePrompt } from '../prompts';
import { EpicProposalSchema, StoryProposalSchema, type EpicProposal, type StoryProposal } from '../schemas';
import { EPICS_SCHEMA, STORIES_SCHEMA } from '../toolSchemas';
import { zodParser } from './parse';

const SINGLE_EPIC_SCHEMA = (EPICS_SCHEMA.properties.epics as { items: Record<string, unknown> }).items;
const SINGLE_STORY_SCHEMA = (STORIES_SCHEMA.properties.stories as { items: Record<string, unknown> }).items;

export interface LocalRefineResult {
  level: 'epic' | 'story';
  ref: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  changed: boolean;
  /** The revised item, ready to splice back into the backlog once accepted. */
  revised: EpicItem | StoryItem;
}

/**
 * Refines an item that lives only in the backlog file — not yet in Jira.
 *
 * The Jira-backed `refineIssue` cannot serve this case: it fetches by issue
 * key, and an unpushed item has none. Product owners do most of their editing
 * before anything is pushed, so this is the path that actually gets used.
 *
 * Identity is preserved deliberately: `ref` and `sync` survive the round trip,
 * so refining an already-pushed item still updates it rather than orphaning it
 * and creating a duplicate.
 */
export async function refineBacklogItem(
  llm: LlmPort,
  backlog: Backlog,
  target: { level: 'epic' | 'story'; ref: string },
  instruction: string,
  token?: LlmCancellation
): Promise<LocalRefineResult> {
  if (target.level === 'epic') {
    const epic = backlog.epics.find((e) => e.ref === target.ref);
    if (!epic) throw new Error(`No epic "${target.ref}" in this backlog.`);

    const before = epicToMarkdown(epic);
    const revised = await llm.requestStructured<EpicProposal>(
      {
        messages: [
          {
            role: 'user',
            content: refineIssuePrompt(
              'epic',
              { key: epic.sync.jiraKey ?? epic.ref, summary: epic.title, description: before },
              instruction,
              contextFor(backlog, epic.ref)
            )
          }
        ],
        toolName: 'emit_epic',
        toolDescription: 'Record the refined epic.',
        inputSchema: SINGLE_EPIC_SCHEMA,
        parse: zodParser(EpicProposalSchema),
        justification: `ReqForge is refining the epic "${epic.title}".`
      },
      token
    );

    // Keep identity, children, and evidence. Evidence is a claim about what the
    // source document says, and a rewrite never sees the source document — so
    // anything the model returns for it is invented, and inventing traceability
    // is worse than having none.
    const merged: EpicItem = {
      ...revised,
      ref: epic.ref,
      sync: epic.sync,
      stories: epic.stories,
      sourceEvidence: epic.sourceEvidence
    };
    const after = epicToMarkdown(merged);
    return {
      level: 'epic',
      ref: epic.ref,
      beforeMarkdown: before,
      afterMarkdown: after,
      changed: normalize(before) !== normalize(after) || epic.title !== merged.title,
      revised: merged
    };
  }

  const parent = backlog.epics.find((e) => e.stories.some((s) => s.ref === target.ref));
  const story = parent?.stories.find((s) => s.ref === target.ref);
  if (!parent || !story) throw new Error(`No story "${target.ref}" in this backlog.`);

  const before = storyToMarkdown(story);
  const revised = await llm.requestStructured<StoryProposal>(
    {
      messages: [
        {
          role: 'user',
          content: refineIssuePrompt(
            'story',
            { key: story.sync.jiraKey ?? story.ref, summary: story.title, description: before },
            instruction,
            `This story belongs to the epic "${parent.title}": ${parent.outcome}`
          )
        }
      ],
      toolName: 'emit_story',
      toolDescription: 'Record the refined story.',
      inputSchema: SINGLE_STORY_SCHEMA,
      parse: zodParser(StoryProposalSchema),
      justification: `ReqForge is refining the story "${story.title}".`
    },
    token
  );

  const merged: StoryItem = { ...revised, ref: story.ref, epicRef: parent.ref, sync: story.sync };
  const after = storyToMarkdown(merged);
  return {
    level: 'story',
    ref: story.ref,
    beforeMarkdown: before,
    afterMarkdown: after,
    changed: normalize(before) !== normalize(after) || story.title !== merged.title,
    revised: merged
  };
}

/** Applies an accepted refinement back into the backlog, in place. */
export function applyRefinement(backlog: Backlog, result: LocalRefineResult): void {
  if (result.level === 'epic') {
    const i = backlog.epics.findIndex((e) => e.ref === result.ref);
    if (i >= 0) backlog.epics[i] = result.revised as EpicItem;
    return;
  }
  for (const epic of backlog.epics) {
    const i = epic.stories.findIndex((s) => s.ref === result.ref);
    if (i >= 0) {
      epic.stories[i] = result.revised as StoryItem;
      return;
    }
  }
}

/** Gives the model the surrounding backlog so it does not duplicate a sibling's scope. */
function contextFor(backlog: Backlog, excludeRef: string): string {
  const siblings = backlog.epics
    .filter((e) => e.ref !== excludeRef)
    .map((e) => `- ${e.title}: ${e.outcome}`)
    .join('\n');
  return [
    `${backlog.source.kind === 'jira' ? 'Source epic' : 'Source document'}: ${backlog.source.title}`,
    backlog.prd.summary ? `Summary: ${backlog.prd.summary}` : '',
    siblings ? `\nOther epics in this backlog — do not duplicate their scope:\n${siblings}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
