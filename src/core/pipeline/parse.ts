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

    const result = schema.safeParse(input);
    if (result.success) return { ok: true, value: result.data };

    const detail = result.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: detail };
  };
}
