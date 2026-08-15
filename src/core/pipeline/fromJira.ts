import type { AtlassianPort, IssueDetail } from '../ports';
import { AtlassianError } from '../ports';
import type { Backlog, EpicItem, StoryItem } from '../model';
import { epicFingerprint, slugify, storyFingerprint } from '../model';
import { parseEpicMarkdown, parseStoryMarkdown } from './parseIssue';
import type { Progress } from './decompose';

/**
 * Builds a working backlog from an epic that already exists in Jira.
 *
 * This is deliberately not a second editor. An existing epic is turned into the
 * same `Backlog` shape the PRD path produces, so everything already built for
 * that path applies unchanged: the structured editor, the rubric, story
 * generation, undo, and a push that updates rather than creates.
 */

export interface FromJiraOptions {
  /** Pull the epic's children as stories. */
  includeChildren?: boolean;
  progress?: Progress;
}

export interface FromJiraResult {
  backlog: Backlog;
  slug: string;
  /** True when the issue's description had no ReqForge structure to read back. */
  unstructured: boolean;
}

export async function backlogFromJiraIssue(
  atlassian: AtlassianPort,
  key: string,
  target: { projectKey: string; epicIssueType: string; storyIssueType: string },
  opts: FromJiraOptions = {}
): Promise<FromJiraResult> {
  opts.progress?.report(`Fetching ${key}…`);
  const issue = await atlassian.getIssue(key);

  const looksLikeEpic = issue.issueType.toLowerCase().includes('epic');
  const epicRef = slugify(issue.key);

  let children: IssueDetail[] = [];
  if (looksLikeEpic && opts.includeChildren !== false && atlassian.capabilities().has('jira.children')) {
    opts.progress?.report(`Looking for stories under ${issue.key}…`);
    children = await atlassian
      .searchIssueDetails(`parent = "${issue.key}" ORDER BY created ASC`, 200)
      .catch((err) => {
        // Not every project models children as `parent`. A failure here should
        // cost the stories, not the whole operation.
        opts.progress?.report(`Could not read children of ${issue.key}: ${(err as Error).message}`);
        return [];
      });
  }

  const epicProposal = parseEpicMarkdown(issue.key, issue.summary, issue.description);
  const unstructured = epicProposal.acceptanceCriteria.length === 0 && !epicProposal.outcome;

  const stories: StoryItem[] = children.map((child) => {
    const parsed = parseStoryMarkdown(child.key, child.summary, child.description, epicRef);
    return {
      ...parsed,
      sync: {
        jiraKey: child.key,
        jiraUrl: child.url,
        // No pushedHash: we did not write this content, so it counts as
        // pending until the user sends it back. That is honest — the local
        // copy and Jira agree now, but nothing here proves it.
        pushedAt: undefined
      }
    };
  });

  const epic: EpicItem = {
    ...epicProposal,
    // Description is required by the schema; an empty one would fail to load.
    description: epicProposal.description || issue.summary,
    sync: { jiraKey: issue.key, jiraUrl: issue.url },
    stories
  };

  const backlog: Backlog = {
    version: 1,
    source: {
      kind: 'jira',
      pageId: issue.key,
      title: `${issue.key} — ${issue.summary}`,
      url: issue.url,
      ingestedAt: new Date().toISOString()
    },
    target: { ...target, projectKey: projectOf(issue.key) || target.projectKey },
    prd: {
      title: issue.summary,
      // The rubric and the story generator both read this; the epic's own
      // outcome is the closest thing an existing issue has to a summary.
      summary: epicProposal.outcome || issue.summary,
      goals: [],
      nonGoals: [],
      personas: [],
      constraints: [],
      openQuestions: epicProposal.openQuestions,
      risks: []
    },
    epics: [epic]
  };

  return { backlog, slug: slugify(issue.key), unstructured };
}

/** Marks everything as already matching Jira, for a backlog just read from it. */
export function markAsSynced(backlog: Backlog): void {
  const now = new Date().toISOString();
  for (const epic of backlog.epics) {
    if (epic.sync.jiraKey) epic.sync = { ...epic.sync, pushedHash: epicFingerprint(epic), pushedAt: now };
    for (const story of epic.stories) {
      if (story.sync.jiraKey) story.sync = { ...story.sync, pushedHash: storyFingerprint(story), pushedAt: now };
    }
  }
}

function projectOf(key: string): string {
  const m = key.match(/^([A-Z][A-Z0-9_]+)-\d+$/i);
  if (!m) throw new AtlassianError(`"${key}" is not a Jira issue key.`);
  return m[1].toUpperCase();
}
