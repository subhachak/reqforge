import type { FileSystemLike } from '../store';
import type { CriterionResult, Override } from './types';

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
  /**
   * Reviewer decisions, keyed by `level:ref` without a fingerprint so they
   * survive editing. Stored beside the assessments because they are the same
   * kind of thing: a record of a judgement, not part of the backlog itself.
   */
  overrides?: Record<string, Override>;
}

export function qualityPath(folder: string, slug: string): string {
  return `${folder}/${slug}.quality.json`;
}

export interface QualityRecord {
  assessments: Map<string, CriterionResult[]>;
  overrides: Map<string, Override>;
}

export async function loadQuality(fs: FileSystemLike, folder: string, slug: string): Promise<QualityRecord> {
  const empty: QualityRecord = { assessments: new Map(), overrides: new Map() };
  const text = await fs.read(qualityPath(folder, slug));
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text) as CacheFile;
    if (parsed?.version !== 1 || typeof parsed.entries !== 'object') return empty;
    return {
      assessments: new Map(Object.entries(parsed.entries)),
      overrides: new Map(Object.entries(parsed.overrides ?? {}))
    };
  } catch {
    // A corrupt cache is not worth failing over — reassessing costs a model call.
    return empty;
  }
}

export async function saveQuality(
  fs: FileSystemLike,
  folder: string,
  slug: string,
  record: QualityRecord
): Promise<void> {
  const file: CacheFile = {
    version: 1,
    entries: Object.fromEntries(record.assessments),
    overrides: Object.fromEntries(record.overrides)
  };
  await fs.write(qualityPath(folder, slug), JSON.stringify(file, null, 2));
}

/** Removes the sidecar, for when its backlog is deleted. */
export async function deleteQuality(fs: FileSystemLike, folder: string, slug: string): Promise<void> {
  await fs.remove(qualityPath(folder, slug));
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
