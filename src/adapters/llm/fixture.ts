import type { LlmPort, StructuredRequest } from '../../core/ports';

/**
 * Replays recorded responses keyed by tool name. Two uses:
 *  - headless tests (CI has no Copilot entitlement),
 *  - a demo that must not depend on the network or on Copilot quota.
 *
 * Record fixtures by setting reqforge.llm.recordFixtures and running the real
 * pipeline once; the output channel writes the payloads to .reqforge/fixtures.
 */
export class FixtureLlmAdapter implements LlmPort {
  readonly kind = 'fixture' as const;

  constructor(private readonly fixtures: Record<string, unknown[]>) {}

  private cursor = new Map<string, number>();

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const names = Object.keys(this.fixtures);
    return names.length > 0
      ? { ok: true, detail: `fixtures loaded for: ${names.join(', ')}` }
      : { ok: false, detail: 'no fixtures loaded' };
  }

  async contextWindow(): Promise<number> {
    return 128_000;
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }

  async requestStructured<T>(req: StructuredRequest<T>): Promise<T> {
    const queue = this.fixtures[req.toolName];
    if (!queue || queue.length === 0) {
      throw new Error(`No fixture recorded for tool "${req.toolName}".`);
    }
    const i = this.cursor.get(req.toolName) ?? 0;
    // Replay the last fixture repeatedly rather than running out mid-demo.
    const raw = queue[Math.min(i, queue.length - 1)];
    this.cursor.set(req.toolName, i + 1);

    const parsed = req.parse(raw);
    if (!parsed.ok) {
      throw new Error(`Fixture for "${req.toolName}" does not match the current schema: ${parsed.error}`);
    }
    return parsed.value;
  }
}
