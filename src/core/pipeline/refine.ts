import type { AtlassianPort, LlmCancellation, LlmPort } from '../ports';
import { epicToMarkdown, storyToMarkdown } from '../model';
import { refineIssuePrompt } from '../prompts';
import { EpicProposalSchema, StoryProposalSchema, type EpicProposal, type StoryProposal } from '../schemas';
import { EPICS_SCHEMA, STORIES_SCHEMA } from '../toolSchemas';
import { zodParser } from './parse';

/** Single-item variants of the batch schemas, for refining one issue at a time. */
const SINGLE_EPIC_SCHEMA = (EPICS_SCHEMA.properties.epics as { items: Record<string, unknown> }).items;
const SINGLE_STORY_SCHEMA = (STORIES_SCHEMA.properties.stories as { items: Record<string, unknown> }).items;

export interface RefineResult {
  key: string;
  before: { summary: string; description: string };
  after: { summary: string; description: string };
  /** True when the model returned something materially different. */
  changed: boolean;
}

/**
 * Fetches an existing Jira issue, asks the model to revise it against a
 * free-text instruction, and returns both versions so the caller can show a
 * diff. Nothing is written here — applying the result is a separate, explicit
 * step.
 */
export async function refineIssue(
  atlassian: AtlassianPort,
  llm: LlmPort,
  args: {
    key: string;
    instruction: string;
    /** Optional extra context, e.g. the source PRD section. */
    context?: string;
    /** Overrides the type inferred from the issue itself. */
    treatAs?: 'epic' | 'story';
    token?: LlmCancellation;
  }
): Promise<RefineResult> {
  const issue = await atlassian.getIssue(args.key);
  const kind = args.treatAs ?? (issue.issueType.toLowerCase().includes('epic') ? 'epic' : 'story');

  const prompt = refineIssuePrompt(
    kind,
    { key: issue.key, summary: issue.summary, description: issue.description },
    args.instruction,
    args.context
  );

  if (kind === 'epic') {
    const revised = await llm.requestStructured<EpicProposal>(
      {
        messages: [{ role: 'user', content: prompt }],
        toolName: 'emit_epic',
        toolDescription: 'Record the refined epic.',
        inputSchema: SINGLE_EPIC_SCHEMA,
        parse: zodParser(EpicProposalSchema),
        justification: `ReqForge is refining ${issue.key}.`
      },
      args.token
    );
    return compare(issue, revised.title, epicToMarkdown(revised));
  }

  const revised = await llm.requestStructured<StoryProposal>(
    {
      messages: [{ role: 'user', content: prompt }],
      toolName: 'emit_story',
      toolDescription: 'Record the refined story.',
      inputSchema: SINGLE_STORY_SCHEMA,
      parse: zodParser(StoryProposalSchema),
      justification: `ReqForge is refining ${issue.key}.`
    },
    args.token
  );
  return compare(issue, revised.title, storyToMarkdown(revised));
}

function compare(
  issue: { key: string; summary: string; description: string },
  summary: string,
  description: string
): RefineResult {
  const before = { summary: issue.summary, description: issue.description };
  const after = { summary, description };
  return {
    key: issue.key,
    before,
    after,
    changed: before.summary !== after.summary || normalize(before.description) !== normalize(after.description)
  };
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
