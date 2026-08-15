import type { FileSystemLike } from '../store';
import type { CriterionResult } from './types';

/**
 * Assessments live in a sidecar file, not in the backlog YAML.
 *
 * The backlog is meant to be read and hand-edited; burying machine-generated
 * ratings in it would work against that. Entries are keyed by
 * `level:ref:fingerprint`, so an edited item simply stops matching and its
 * assessment is ignored — no invalidation logic, and no way for a stale score
 * to be shown as current.
 */

interface CacheFile {
  version: 1;
  entries: Record<string, CriterionResult[]>;
}

export function qualityPath(folder: string, slug: string): string {
  return `${folder}/${slug}.quality.json`;
}

export async function loadAssessments(
  fs: FileSystemLike,
  folder: string,
  slug: string
): Promise<Map<string, CriterionResult[]>> {
  const text = await fs.read(qualityPath(folder, slug));
  if (!text) return new Map();
  try {
    const parsed = JSON.parse(text) as CacheFile;
    if (parsed?.version !== 1 || typeof parsed.entries !== 'object') return new Map();
    return new Map(Object.entries(parsed.entries));
  } catch {
    // A corrupt cache is not worth failing over — reassessing costs a model call.
    return new Map();
  }
}

export async function saveAssessments(
  fs: FileSystemLike,
  folder: string,
  slug: string,
  entries: Map<string, CriterionResult[]>
): Promise<void> {
  const file: CacheFile = { version: 1, entries: Object.fromEntries(entries) };
  await fs.write(qualityPath(folder, slug), JSON.stringify(file, null, 2));
}

/**
 * Drops entries whose fingerprint no longer appears in the backlog, so the file
 * does not grow forever as items are edited.
 */
export function pruneAssessments(
  entries: Map<string, CriterionResult[]>,
  liveKeys: Set<string>
): Map<string, CriterionResult[]> {
  return new Map([...entries].filter(([key]) => liveKeys.has(key)));
}
