import type { AtlassianPort } from '../ports';
import { AtlassianError } from '../ports';
import type { Backlog, EpicItem, StoryItem } from '../model';
import { epicFingerprint, epicToMarkdown, stampLabel, storyFingerprint, storyToMarkdown } from '../model';
import type { Progress } from './decompose';

export type PushVerb = 'create' | 'update' | 'skip';

export interface PushAction {
  level: 'epic' | 'story';
  ref: string;
  title: string;
  verb: PushVerb;
  /** Set when the item already exists in Jira. */
  jiraKey?: string;
  /** Human-readable justification, shown in the dry-run preview. */
  reason: string;
  parentRef?: string;
}

export interface PushPlan {
  projectKey: string;
  actions: PushAction[];
  /** Mandatory project fields ReqForge does not populate. Non-empty means a create will 400. */
  blockingFields: string[];
}

/**
 * Builds the plan without writing anything. The plan is what the dry-run shows
 * and what the user confirms; execution never re-derives it.
 */
export async function planPush(atlassian: AtlassianPort, backlog: Backlog): Promise<PushPlan> {
  const { projectKey, epicIssueType, storyIssueType } = backlog.target;
  if (!projectKey) throw new AtlassianError('No Jira project key set. Configure reqforge.jira.projectKey.');

  const blockingFields: string[] = [];
  if (atlassian.capabilities().has('jira.createmeta')) {
    for (const type of [epicIssueType, storyIssueType]) {
      blockingFields.push(...(await atlassian.requiredFields(projectKey, type)).map((f) => `${type}: ${f}`));
    }
  }

  const actions: PushAction[] = [];

  for (const epic of backlog.epics) {
    const resolved = await resolveKey(atlassian, backlog, epic.sync.jiraKey, epic.ref, projectKey);
    actions.push(buildAction('epic', epic.ref, epic.title, resolved, epic.sync.pushedHash, epicFingerprint(epic)));

    for (const story of epic.stories) {
      const storyKey = await resolveKey(atlassian, backlog, story.sync.jiraKey, story.ref, projectKey);
      actions.push({
        ...buildAction('story', story.ref, story.title, storyKey, story.sync.pushedHash, storyFingerprint(story)),
        parentRef: epic.ref
      });
    }
  }

  return { projectKey, actions, blockingFields: [...new Set(blockingFields)] };
}

function buildAction(
  level: 'epic' | 'story',
  ref: string,
  title: string,
  jiraKey: string | undefined,
  pushedHash: string | undefined,
  currentHash: string
): PushAction {
  if (!jiraKey) {
    return { level, ref, title, verb: 'create', reason: 'not present in Jira' };
  }
  if (pushedHash === currentHash) {
    return { level, ref, title, jiraKey, verb: 'skip', reason: 'unchanged since last push' };
  }
  return { level, ref, title, jiraKey, verb: 'update', reason: pushedHash ? 'edited locally' : 'adopted existing issue' };
}

/**
 * Idempotency. An item is matched to an existing issue by, in order:
 *  1. the jiraKey already recorded in the backlog file,
 *  2. a search for the ReqForge stamp label.
 *
 * The second path is what stops a re-run after a crash — or a colleague running
 * the same command — from producing a duplicate backlog.
 */
async function resolveKey(
  atlassian: AtlassianPort,
  backlog: Backlog,
  recorded: string | undefined,
  ref: string,
  projectKey: string
): Promise<string | undefined> {
  if (recorded) return recorded;
  if (!atlassian.capabilities().has('jira.search')) return undefined;

  const label = stampLabel(backlog.source.pageId, ref);
  const found = await atlassian
    .searchIssues(`project = "${projectKey}" AND labels = "${label}" ORDER BY created ASC`, 1)
    .catch(() => []);
  return found[0]?.key;
}

export interface PushResult {
  created: number;
  updated: number;
  skipped: number;
  failures: { ref: string; error: string }[];
}

/**
 * Executes a plan. Epics first so stories have a parent to attach to.
 * Mutates `backlog` in place with the resulting keys — the caller is expected
 * to save the file afterwards, including on partial failure, so a re-run picks
 * up where this one stopped.
 */
export async function executePush(
  atlassian: AtlassianPort,
  backlog: Backlog,
  plan: PushPlan,
  opts: { progress?: Progress } = {}
): Promise<PushResult> {
  const result: PushResult = { created: 0, updated: 0, skipped: 0, failures: [] };
  const byRef = new Map(plan.actions.map((a) => [`${a.level}:${a.ref}`, a]));

  for (const epic of backlog.epics) {
    const action = byRef.get(`epic:${epic.ref}`);
    if (action) {
      await applyOne(atlassian, backlog, action, epic, 'epic', undefined, result, opts.progress);
    }

    const parentKey = epic.sync.jiraKey;
    for (const story of epic.stories) {
      const storyAction = byRef.get(`story:${story.ref}`);
      if (!storyAction) continue;
      if (!parentKey && storyAction.verb === 'create') {
        result.failures.push({
          ref: story.ref,
          error: `parent epic ${epic.ref} has no Jira key, so the story cannot be linked`
        });
        continue;
      }
      await applyOne(atlassian, backlog, storyAction, story, 'story', parentKey, result, opts.progress);
    }
  }

  return result;
}

async function applyOne(
  atlassian: AtlassianPort,
  backlog: Backlog,
  action: PushAction,
  item: EpicItem | StoryItem,
  level: 'epic' | 'story',
  parentKey: string | undefined,
  result: PushResult,
  progress?: Progress
): Promise<void> {
  if (action.verb === 'skip') {
    result.skipped++;
    return;
  }

  const isEpic = level === 'epic';
  const markdown = isEpic ? epicToMarkdown(item as EpicItem) : storyToMarkdown(item as StoryItem);
  const hash = isEpic ? epicFingerprint(item as EpicItem) : storyFingerprint(item as StoryItem);
  const label = stampLabel(backlog.source.pageId, item.ref);
  const issueType = isEpic ? backlog.target.epicIssueType : backlog.target.storyIssueType;

  try {
    if (action.verb === 'create') {
      progress?.report(`Creating ${level}: ${item.title}`);
      const ref = await atlassian.createIssue({
        projectKey: backlog.target.projectKey,
        issueTypeName: issueType,
        summary: item.title,
        descriptionMarkdown: markdown,
        labels: ['reqforge', label],
        parentKey
      });
      item.sync = { jiraKey: ref.key, jiraUrl: ref.url, pushedHash: hash, pushedAt: new Date().toISOString() };
      result.created++;
    } else {
      progress?.report(`Updating ${action.jiraKey}: ${item.title}`);
      await atlassian.updateIssue(action.jiraKey!, {
        summary: item.title,
        descriptionMarkdown: markdown
      });
      item.sync = {
        ...item.sync,
        jiraKey: action.jiraKey,
        pushedHash: hash,
        pushedAt: new Date().toISOString()
      };
      result.updated++;
    }
  } catch (err) {
    result.failures.push({ ref: item.ref, error: (err as Error).message });
  }
}

/** Renders a plan as the markdown shown in the dry-run preview document. */
export function renderPlan(plan: PushPlan, backlog: Backlog): string {
  const lines: string[] = [
    `# Push preview — ${backlog.source.title}`,
    '',
    `Target project: **${plan.projectKey}**  `,
    `Source: [${backlog.source.title}](${backlog.source.url})`,
    ''
  ];

  if (plan.blockingFields.length > 0) {
    lines.push(
      '> **These required Jira fields are not populated by ReqForge.**',
      '> Creates will be rejected with a 400 until somebody sets a default or makes them optional:',
      ...plan.blockingFields.map((f) => `> - ${f}`),
      ''
    );
  }

  const counts = plan.actions.reduce<Record<PushVerb, number>>(
    (acc, a) => ({ ...acc, [a.verb]: acc[a.verb] + 1 }),
    { create: 0, update: 0, skip: 0 }
  );
  lines.push(`**${counts.create} to create · ${counts.update} to update · ${counts.skip} unchanged**`, '');

  for (const action of plan.actions) {
    if (action.level === 'story') continue;
    const badge = { create: 'NEW', update: 'UPDATE', skip: 'unchanged' }[action.verb];
    lines.push(`### [${badge}] ${action.title}`, `\`${action.ref}\`${action.jiraKey ? ` → ${action.jiraKey}` : ''} — ${action.reason}`, '');

    const stories = plan.actions.filter((a) => a.level === 'story' && a.parentRef === action.ref);
    for (const s of stories) {
      const sBadge = { create: 'NEW', update: 'UPDATE', skip: '·' }[s.verb];
      lines.push(`- [${sBadge}] ${s.title}${s.jiraKey ? ` (${s.jiraKey})` : ''}`);
    }
    if (stories.length) lines.push('');
  }

  return lines.join('\n');
}
