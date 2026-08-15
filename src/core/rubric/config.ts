import { parse } from 'yaml';
import { z } from 'zod';
import type { FileSystemLike } from '../store';
import { DEFAULT_RUBRIC, type RubricConfig } from './types';

/**
 * The rubric is data, not code, because every organisation has its own
 * Definition of Ready. A client drops `.reqforge/rubric.yaml` in the repo,
 * overrides what they care about, and their standard becomes reviewable in a
 * pull request like anything else.
 */

const SeveritySchema = z.enum(['blocker', 'warn', 'info', 'off']);

const FileSchema = z.object({
  threshold: z.number().min(0).max(100).optional(),
  enforcement: z.enum(['block', 'warn']).optional(),
  weights: z.record(z.string(), z.number().min(0)).optional(),
  rules: z.record(z.string(), SeveritySchema).optional()
});

export const RUBRIC_FILENAME = 'rubric.yaml';

export interface LoadedRubric {
  config: RubricConfig;
  /** Where it came from, for the settings screen. */
  source: 'default' | 'file';
  /** Set when a file exists but could not be used; the default is applied instead. */
  problem?: string;
}

export async function loadRubric(fs: FileSystemLike, folder: string): Promise<LoadedRubric> {
  const text = await fs.read(`${folder}/${RUBRIC_FILENAME}`);
  if (!text) return { config: DEFAULT_RUBRIC, source: 'default' };

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    return { config: DEFAULT_RUBRIC, source: 'default', problem: `rubric.yaml is not valid YAML: ${(err as Error).message}` };
  }

  const parsed = FileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { config: DEFAULT_RUBRIC, source: 'default', problem: `rubric.yaml is not valid: ${detail}` };
  }

  return {
    config: {
      threshold: parsed.data.threshold ?? DEFAULT_RUBRIC.threshold,
      enforcement: parsed.data.enforcement ?? DEFAULT_RUBRIC.enforcement,
      weights: parsed.data.weights ?? {},
      rules: (parsed.data.rules ?? {}) as RubricConfig['rules']
    },
    source: 'file'
  };
}

/** Written when a user asks for a starting point they can edit. */
export function sampleRubricYaml(ruleIds: string[], criterionIds: string[]): string {
  return `# ReqForge quality rubric.
# Delete anything you do not want to change — defaults apply to the rest.

# An item must reach this score (0-100) to count as ready.
threshold: ${DEFAULT_RUBRIC.threshold}

# block = items below the threshold cannot be sent to Jira.
# warn  = they can be sent after a confirmation.
enforcement: ${DEFAULT_RUBRIC.enforcement}

# Criterion weights. 0 removes a criterion entirely without capping the score.
weights: {}
#  invest-testable: 2
#  epic-traceable: 0

# Rule severities: blocker | warn | info | off
rules: {}
${ruleIds.map((r) => `#  ${r}: warn`).join('\n')}

# Available criteria:
${criterionIds.map((c) => `#  ${c}`).join('\n')}
`;
}
