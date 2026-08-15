import type { Backlog, EpicItem } from '../core/model';
import type { PushPlan, PushResult } from '../core/pipeline/push';
import type { BacklogQuality, CriterionDef } from '../core/rubric/index';
import type { ImproveResult } from '../core/pipeline/improve';

/**
 * The webview/host contract. Shared by both bundles, so a change breaks the
 * build rather than producing a silently ignored message at runtime.
 *
 * The host is the single source of truth. The webview posts an intent and
 * re-renders whatever state comes back; it never persists anything.
 */

export type View = 'setup' | 'home' | 'backlog';

/**
 * Settings mirrored into the panel. The API token is deliberately absent —
 * only whether one exists. Secrets live in the OS keychain and must never
 * cross into a webview, where any script on the page could read them.
 */
export interface SetupState {
  baseUrl: string;
  email: string;
  projectKey: string;
  epicIssueType: string;
  storyIssueType: string;
  modelFamily: string;
  hasToken: boolean;
  /** Everything the tool needs before it can do anything useful. */
  complete: boolean;
  /** Populated by an explicit test, not on every render — each costs a round trip. */
  atlassian: { state: 'unknown' | 'ok' | 'failed'; detail: string };
  model: { state: 'unknown' | 'ok' | 'failed'; detail: string };
}

export interface RecentBacklog {
  slug: string;
  title: string;
  epics: number;
  stories: number;
  unpushed: number;
  projectKey: string;
}

export interface PanelState {
  view: View;
  setup: SetupState;
  recent: RecentBacklog[];

  backlog: Backlog | undefined;
  slug: string | undefined;

  busy: boolean;
  busyLabel: string;
  plan: PushPlan | undefined;
  notice: { kind: 'info' | 'warn' | 'error'; message: string; hint?: string } | undefined;
  pendingRefine:
    | { level: 'epic' | 'story'; ref: string; title: string; beforeMarkdown: string; afterMarkdown: string; changed: boolean }
    | undefined;
  jiraBrowseBase: string;
  undoLabel: string | undefined;
  redoLabel: string | undefined;

  /** Recomputed on every render; deterministic rules are free. */
  quality: BacklogQuality | undefined;
  /** Criterion definitions, so the webview can show names and standards without duplicating them. */
  criteria: CriterionDef[];
  /** Report from the last improve run, awaiting dismissal. */
  improveReport: (ImproveResult & { stopExplanation: string }) | undefined;
  /** Where the rubric came from, and any problem loading it. */
  rubric: {
    threshold: number;
    enforcement: 'block' | 'warn' | 'label';
    requireReview: boolean;
    source: 'default' | 'file';
    problem?: string;
  };
}

export type HostMessage = { type: 'state'; state: PanelState } | { type: 'pushed'; result: PushResult };

/** Fields a user can change in the settings form. The token has its own message. */
export type SettingsPatch = Partial<
  Pick<SetupState, 'baseUrl' | 'email' | 'projectKey' | 'epicIssueType' | 'storyIssueType' | 'modelFamily'>
>;

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'navigate'; view: View }
  /* setup */
  | { type: 'saveSettings'; patch: SettingsPatch }
  | { type: 'setToken' }
  | { type: 'clearToken' }
  | { type: 'testConnection' }
  /* home */
  | { type: 'decompose' }
  | { type: 'openBacklog'; slug: string }
  | { type: 'deleteBacklog'; slug: string }
  /* pull an existing epic in as a backlog */
  | { type: 'fetchJiraIssue'; key: string }
  /* backlog */
  /** `slug` identifies the backlog these epics were edited against. The host
   *  discards the message if a different backlog is now loaded. */
  | { type: 'edit'; slug: string | undefined; epics: EpicItem[] }
  | { type: 'generateStories'; epicRefs: string[] }
  | { type: 'refine'; level: 'epic' | 'story'; ref: string; instruction: string }
  | { type: 'acceptRefine' }
  | { type: 'discardRefine' }
  | { type: 'addEpic' }
  | { type: 'addStory'; epicRef: string }
  | { type: 'deleteItem'; level: 'epic' | 'story'; ref: string }
  | { type: 'previewPush'; only: string[] }
  | { type: 'push'; only: string[] }
  | { type: 'undo' }
  | { type: 'redo' }
  /* quality */
  | { type: 'deepReview'; only?: string[] }
  | { type: 'fixItem'; level: 'epic' | 'story'; ref: string }
  | { type: 'createRubricFile' }
  | { type: 'improve'; only?: string[] }
  | { type: 'dismissImproveReport' }
  | { type: 'waiveFinding'; level: 'epic' | 'story'; ref: string; ruleId: string }
  | { type: 'unwaiveFinding'; level: 'epic' | 'story'; ref: string; ruleId: string }
  | { type: 'acceptBelowThreshold'; level: 'epic' | 'story'; ref: string }
  | { type: 'revokeAcceptance'; level: 'epic' | 'story'; ref: string }
  /* chrome */
  | { type: 'dismissNotice' }
  | { type: 'dismissPlan' }
  | { type: 'openExternal'; url: string };
