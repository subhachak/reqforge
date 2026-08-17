import type { FileSystemLike } from '../store';
import type { Conflict, Observation } from './types';

/**
 * Panel output that has nowhere else to live.
 *
 * Criterion ratings go in the quality sidecar because they feed the score.
 * Observations and conflicts do not feed the score — they are things a reviewer
 * noticed that the rubric has no number for — so they get their own file rather
 * than being smuggled into a record whose shape means "this is what the score
 * was computed from".
 *
 * A separate file also keeps the dependency direction honest: the rubric knows
 * nothing about agents, and it stays that way.
 *
 * Both are keyed by `level:ref:fingerprint`, exactly like assessments, so an
 * edited item stops matching and its findings vanish with its ratings. A
 * conflict about wording that has since been rewritten is worse than no
 * conflict at all.
 */

interface PanelFile {
  version: 1;
  observations: Record<string, Observation[]>;
  conflicts: Record<string, Conflict[]>;
}

export interface PanelRecord {
  observations: Map<string, Observation[]>;
  conflicts: Map<string, Conflict[]>;
}

export function panelPath(folder: string, slug: string): string {
  return `${folder}/${slug}.panel.json`;
}

export async function loadPanelFindings(
  fs: FileSystemLike,
  folder: string,
  slug: string
): Promise<PanelRecord> {
  const empty: PanelRecord = { observations: new Map(), conflicts: new Map() };
  const text = await fs.read(panelPath(folder, slug));
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text) as PanelFile;
    if (parsed?.version !== 1) return empty;
    return {
      observations: new Map(Object.entries(parsed.observations ?? {})),
      conflicts: new Map(Object.entries(parsed.conflicts ?? {}))
    };
  } catch {
    // Same reasoning as the quality cache: re-running the panel costs model
    // calls, but failing to open a backlog costs the user their work.
    return empty;
  }
}

export async function savePanelFindings(
  fs: FileSystemLike,
  folder: string,
  slug: string,
  record: PanelRecord
): Promise<void> {
  const file: PanelFile = {
    version: 1,
    observations: Object.fromEntries(record.observations),
    conflicts: Object.fromEntries(record.conflicts)
  };
  await fs.write(panelPath(folder, slug), JSON.stringify(file, null, 2));
}

export async function deletePanelFindings(fs: FileSystemLike, folder: string, slug: string): Promise<void> {
  await fs.remove(panelPath(folder, slug));
}

/** Drops entries whose fingerprint is no longer in the backlog. */
export function pruneByKey<T>(entries: Map<string, T[]>, liveKeys: Set<string>): Map<string, T[]> {
  return new Map([...entries].filter(([key]) => liveKeys.has(key)));
}

/** Flattens the live entries for sending to the webview, which filters by ref. */
export function liveValues<T>(entries: Map<string, T[]>, liveKeys: Set<string>): T[] {
  return [...entries].filter(([key]) => liveKeys.has(key)).flatMap(([, values]) => values);
}
