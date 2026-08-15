import type { Backlog, EpicItem, StoryItem } from '../core/model';
import type { PushPlan, PushResult } from '../core/pipeline/push';

/**
 * The webview/host contract. Shared by both bundles, so a change breaks the
 * build rather than producing a silently ignored message at runtime.
 *
 * The host is the single source of truth. The webview never persists anything;
 * it posts an intent and re-renders whatever state comes back. Backlogs are
 * small (tens of items), so full-state round trips are simpler and safer than
 * incremental patching, and cost nothing at this size.
 */

export interface PanelState {
  backlog: Backlog | undefined;
  /** Backlogs available to switch between. */
  available: { slug: string; title: string }[];
  slug: string | undefined;
  /** True while a model call or Jira write is running. */
  busy: boolean;
  busyLabel: string;
  /** Populated after a push preview. */
  plan: PushPlan | undefined;
  /** Transient banner. */
  notice: { kind: 'info' | 'warn' | 'error'; message: string; hint?: string } | undefined;
  /** Result of the most recent refine, awaiting accept or discard. */
  pendingRefine:
    | {
        level: 'epic' | 'story';
        ref: string;
        title: string;
        beforeMarkdown: string;
        afterMarkdown: string;
        changed: boolean;
      }
    | undefined;
  jiraBrowseBase: string;
  canPush: boolean;
  /** What Undo would reverse, e.g. "delete epic". Absent when there is nothing to undo. */
  undoLabel: string | undefined;
  redoLabel: string | undefined;
}

export type HostMessage =
  | { type: 'state'; state: PanelState }
  | { type: 'pushed'; result: PushResult };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'selectBacklog'; slug: string }
  | { type: 'decompose' }
  /** Full replacement of the epic list after an inline edit. */
  | { type: 'edit'; epics: EpicItem[] }
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
  | { type: 'dismissNotice' }
  | { type: 'dismissPlan' }
  | { type: 'openExternal'; url: string }
  | { type: 'revealFile' };

/** Convenience for the webview, which receives plain JSON. */
export type AnyItem = EpicItem | StoryItem;
