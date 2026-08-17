import type { TypeOf, ZodTypeAny } from 'zod';

/**
 * Bridges zod to the LlmPort's parse contract. The error string is fed back to
 * the model verbatim on the repair attempt, so it needs to be readable: zod's
 * default issue list is exactly the right shape for that.
 *
 * Generic over the schema rather than over a value type, so that `.default()`
 * fields resolve to the post-parse output type (required) instead of the input
 * type (optional).
 */
/**
 * Reads the value at a path, and writes a replacement back.
 *
 * Only used to repair JSON-in-a-string, so it walks plain objects and arrays
 * and nothing else.
 */
function valueAt(root: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], root);
}

function setAt(root: unknown, path: (string | number)[], value: unknown): void {
  const parent = valueAt(root, path.slice(0, -1)) as Record<string | number, unknown>;
  if (parent) parent[path[path.length - 1]] = value;
}

/**
 * Repairs fields the model sent as a JSON string instead of a structure.
 *
 * Tool-calling backends do this intermittently — a model emits
 * `{"assessments": "[{...}]"}` rather than `{"assessments": [{...}]}`. The data
 * is right and only the encoding is wrong, so rejecting it costs a whole extra
 * request to be told the same thing again.
 *
 * Driven by the validation errors rather than applied blindly: only a field
 * zod expected to be an array or object, and received a string, is touched.
 * A justification that happens to contain JSON is left alone.
 */
function repairStringifiedFields(input: unknown, issues: readonly { code: string; expected?: unknown; received?: unknown; path: (string | number)[] }[]): boolean {
  let repaired = false;
  for (const issue of issues) {
    if (issue.code !== 'invalid_type') continue;
    if (issue.expected !== 'array' && issue.expected !== 'object') continue;
    if (issue.received !== 'string') continue;

    const current = valueAt(input, issue.path);
    if (typeof current !== 'string') continue;
    try {
      setAt(input, issue.path, JSON.parse(current));
      repaired = true;
    } catch {
      // Not JSON after all; leave it for the error message to report.
    }
  }
  return repaired;
}

export function zodParser<S extends ZodTypeAny>(schema: S) {
  return (raw: unknown): { ok: true; value: TypeOf<S> } | { ok: false; error: string } => {
    // Some backends hand back the tool input as a JSON string rather than an object.
    let input = raw;
    if (typeof raw === 'string') {
      try {
        input = JSON.parse(raw);
      } catch {
        return { ok: false, error: 'tool input was a string that is not valid JSON' };
      }
    }

    let result = schema.safeParse(input);

    // One repair pass for JSON-in-a-string fields, then re-validate. Cheaper
    // than a round trip, and it fails exactly as before if it does not help.
    if (!result.success && repairStringifiedFields(input, result.error.issues)) {
      result = schema.safeParse(input);
    }

    if (result.success) return { ok: true, value: result.data };

    const detail = result.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: detail };
  };
}
