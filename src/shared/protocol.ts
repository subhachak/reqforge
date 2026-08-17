import type { Conflict, Observation, ReviewerRun } from '../core/findings';
import type { Backlog, EpicItem } from '../core/model';
import type { DuplicateCandidate } from '../core/findings';
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
  /** Which backend the model calls go to. Only 'copilot' exists in the restricted build. */
  llmProvider: string;
  /** How Atlassian is reached. Only 'rest' exists in the restricted build. */
  transport: string;
  /** MCP server command or URL. Empty, and irrelevant, on the REST transport. */
  mcpEndpoint: string;
  /** True once an Anthropic key is in the keychain. Never the key itself. */
  hasAnthropicKey: boolean;
  /**
   * Which build this is. Shown in settings because "am I running the full
   * version?" was only answerable from an output channel that does not exist
   * until the extension activates — so the first place anyone looks could not
   * answer the first question they have.
   */
  profile: string;
  /** What this build actually supports, so the form offers no dead options. */
  availableTransports: string[];
  availableLlmProviders: string[];
  storageFolder: string;
  /**
   * The resolved folder backlogs are actually written to. Shown in settings
   * because a workspace silently takes precedence over a configured storage
   * folder, and files written in one mode look lost in the other.
   */
  storageLocation: string;
  hasToken: boolean;
  hasWorkspace: boolean;
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
  /**
   * The review panel, when this build has one.
   *
   * Empty on the restricted profile, where a single pass does the whole rubric.
   * The webview shows attribution only when it is present, so both builds
   * render from the same code without a profile check in the UI.
   */
  reviewers: { id: string; name: string; purpose: string }[];
  /**
   * Findings the rubric has no number for. Already filtered to items at their
   * current fingerprint, so an edited item's observations disappear with its
   * ratings rather than lingering as stale advice.
   */
  observations: Observation[];
  /** Places two reviewers disagreed. A decision for the PO, not a defect. */
  conflicts: Conflict[];
  /** Set for the run just completed, so a partial panel can say who was missing. */
  lastPanelRun: ReviewerRun[] | undefined;
  /**
   * Whether checking for existing work is worth offering at all. Keyed off the
   * configured transport rather than the reviewer panel: they arrive in the
   * same build but answer different questions, and a REST user seeing a button
   * that always reports "unavailable" is worse than not seeing it.
   */
  canCheckExisting: boolean;
  /**
   * Existing Jira work that may already cover a proposed epic. Only ever
   * advisory — nothing is skipped on the strength of it.
   */
  duplicates: { available: boolean; unavailableReason?: string; candidates: DuplicateCandidate[] } | undefined;
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
  Pick<
    SetupState,
    | 'baseUrl'
    | 'email'
    | 'projectKey'
    | 'epicIssueType'
    | 'storyIssueType'
    | 'modelFamily'
    | 'llmProvider'
    | 'transport'
    | 'mcpEndpoint'
  >
>;

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'navigate'; view: View }
  /* setup */
  | { type: 'saveSettings'; patch: SettingsPatch }
  | { type: 'setToken' }
  | { type: 'setAnthropicKey' }
  | { type: 'clearToken' }
  | { type: 'browseStorageFolder' }
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
  /** Check proposed epics against work that already exists in the tenant. */
  | { type: 'checkExisting'; only?: string[] }
  | { type: 'dismissDuplicates' }
  | { type: 'waiveFinding'; level: 'epic' | 'story'; ref: string; ruleId: string }
  | { type: 'unwaiveFinding'; level: 'epic' | 'story'; ref: string; ruleId: string }
  | { type: 'acceptBelowThreshold'; level: 'epic' | 'story'; ref: string }
  | { type: 'revokeAcceptance'; level: 'epic' | 'story'; ref: string }
  /* chrome */
  | { type: 'dismissNotice' }
  | { type: 'dismissPlan' }
  | { type: 'openExternal'; url: string };
