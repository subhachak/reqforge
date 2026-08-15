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

  return isEpic(issue)
    ? epicBacklog(atlassian, issue, target, opts)
    : storyBacklog(atlassian, issue, target, opts);
}

function isEpic(issue: IssueDetail): boolean {
  return issue.issueType.toLowerCase().includes('epic');
}

/** An epic, with its children pulled in as stories. */
async function epicBacklog(
  atlassian: AtlassianPort,
  issue: IssueDetail,
  target: { projectKey: string; epicIssueType: string; storyIssueType: string },
  opts: FromJiraOptions
): Promise<FromJiraResult> {
  const epicRef = slugify(issue.key);

  let children: IssueDetail[] = [];
  if (opts.includeChildren !== false && atlassian.capabilities().has('jira.children')) {
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

  const epic = epicItemFrom(issue, children.map((c) => storyItemFrom(c, epicRef)));
  return {
    backlog: assemble(issue, [epic], target, epic),
    slug: slugify(issue.key),
    unstructured: isUnstructured(epic)
  };
}

/**
 * A story on its own.
 *
 * It is placed under its real parent epic where it has one, so that editing it
 * keeps its context and a push updates the right things. A story with no parent
 * goes under a container: a local grouping that is never created in Jira,
 * because somebody who fetched one story did not ask for a new epic.
 */
async function storyBacklog(
  atlassian: AtlassianPort,
  issue: IssueDetail,
  target: { projectKey: string; epicIssueType: string; storyIssueType: string },
  opts: FromJiraOptions
): Promise<FromJiraResult> {
  let parent: IssueDetail | undefined;
  if (issue.parentKey) {
    opts.progress?.report(`Fetching parent ${issue.parentKey}…`);
    parent = await atlassian.getIssue(issue.parentKey).catch(() => undefined);
  }

  const epicRef = parent ? slugify(parent.key) : `${slugify(issue.key)}-parent`;
  const story = storyItemFrom(issue, epicRef);

  const epic: EpicItem = parent
    ? epicItemFrom(parent, [story])
    : {
        ref: epicRef,
        title: 'Standalone stories',
        outcome: '',
        priority: 'Should',
        description: `${issue.key} has no parent epic in Jira. This grouping exists only here and is never created there.`,
        inScope: [],
        outOfScope: [],
        successMeasures: [],
        nonFunctional: [],
        assumptions: [],
        acceptanceCriteria: [],
        dependsOn: [],
        links: [],
        sizing: 'M',
        openQuestions: [],
        sourceEvidence: [],
        container: true,
        sync: {},
        stories: [story]
      };

  return {
    backlog: assemble(issue, [epic], target, epic),
    slug: slugify(issue.key),
    unstructured: !story.narrative.asA && story.acceptanceCriteria.every((ac) => !ac.then.trim())
  };
}

function epicItemFrom(issue: IssueDetail, stories: StoryItem[]): EpicItem {
  const parsed = parseEpicMarkdown(issue.key, issue.summary, issue.description);
  return {
    ...parsed,
    sync: { jiraKey: issue.key, jiraUrl: issue.url },
    stories
  };
}

function storyItemFrom(issue: IssueDetail, epicRef: string): StoryItem {
  return {
    ...parseStoryMarkdown(issue.key, issue.summary, issue.description, epicRef),
    sync: {
      jiraKey: issue.key,
      jiraUrl: issue.url
      // No pushedHash: we did not write this content, so it counts as pending
      // until sent. The local copy and Jira agree now, but nothing proves it.
    }
  };
}

function isUnstructured(epic: EpicItem): boolean {
  return !epic.outcome && epic.acceptanceCriteria.length === 0;
}

function assemble(
  issue: IssueDetail,
  epics: EpicItem[],
  target: { projectKey: string; epicIssueType: string; storyIssueType: string },
  primary: EpicItem
): Backlog {
  return {
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
      summary: primary.outcome || issue.summary,
      goals: [],
      nonGoals: [],
      personas: [],
      constraints: [],
      openQuestions: primary.openQuestions,
      risks: []
    },
    epics
  };
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
