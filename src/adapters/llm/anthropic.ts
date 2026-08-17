import Anthropic from '@anthropic-ai/sdk';
import { LlmUnavailableError, type LlmCancellation, type LlmPort, type StructuredRequest } from '../../core/ports';
import { repairPrompt, withCachedPrefix } from '../../core/prompts';

/**
 * Anthropic-backed LLM adapter, for the full profile.
 *
 * Same contract as the Copilot adapter — one forced tool call per request — so
 * every pipeline is unchanged. What it adds is what Copilot's API cannot
 * express: prompt caching on the shared prefix, which is what makes the
 * reviewer panel affordable to fan out, and real parallelism, which is why the
 * orchestrator's concurrency cap exists to be raised.
 */

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Caching has a per-block minimum below which the write costs more than the
 * read saves. Well under the documented floor for the smallest models, so a
 * short prefix is inlined instead.
 */
const MIN_CACHEABLE_CHARS = 4000;

const RETRY_DELAYS_MS = [1000, 3000, 7000];

/** Failures worth retrying: transport, overload, rate limit. Not a 400. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 408 || (typeof status === 'number' && status >= 500)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|overloaded/i.test(message);
}

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** Injected by tests to avoid a network round trip. */
  fetch?: typeof globalThis.fetch;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  onCall?: (info: { n: number; tool: string; inputTokens: number }) => void;
}

export class AnthropicLlmAdapter implements LlmPort {
  readonly kind = 'anthropic' as const;

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private calls = 0;

  constructor(private readonly opts: AnthropicOptions) {
    if (!opts.apiKey) {
      throw new LlmUnavailableError(
        'No Anthropic API key is stored.',
        'Run "ReqForge: Set Anthropic API Key", or switch reqforge.llm.provider back to "copilot".'
      );
    }
    this.model = opts.model || DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      // Retries are handled here so `onRetry` can explain the pause; the SDK
      // retrying underneath would make the UI look hung for the same seconds.
      maxRetries: 0
    });
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      // One-token round trip: cheap, and it exercises auth rather than assuming it.
      await this.client.messages.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      });
      return { ok: true, detail: `anthropic/${this.model}` };
    } catch (err) {
      return { ok: false, detail: describe(err) };
    }
  }

  async contextWindow(): Promise<number> {
    return 200_000;
  }

  /**
   * Uses the count-tokens endpoint, which is exact for this model rather than
   * an approximation. It is a network call but not a billed completion.
   */
  async countTokens(text: string): Promise<number> {
    try {
      const res = await this.client.messages.countTokens({
        model: this.model,
        messages: [{ role: 'user', content: text }]
      });
      return res.input_tokens;
    } catch {
      // Chunking decisions must not fail because a count failed. Four
      // characters per token is a deliberate under-estimate of capacity.
      return Math.ceil(text.length / 4);
    }
  }

  async requestStructured<T>(req: StructuredRequest<T>, token?: LlmCancellation): Promise<T> {
    const first = await this.callOnce<T>(req, req.messages, token);
    if (first.ok) return first.value;

    // One repair attempt, same as the Copilot path: past that the fault is
    // usually the schema rather than the model.
    const repaired = [
      ...req.messages,
      { role: 'assistant' as const, content: `(rejected tool call: ${first.error})` },
      { role: 'user' as const, content: repairPrompt(first.error) }
    ];
    const second = await this.callOnce<T>(req, repaired, token);
    if (second.ok) return second.value;

    throw new LlmUnavailableError(
      `The model returned data that did not match the expected schema, twice. Last error: ${second.error}`,
      'This usually means the source document is too unusual for the current prompt. Try a smaller section of the PRD.'
    );
  }

  private async callOnce<T>(
    req: StructuredRequest<T>,
    messages: { role: 'user' | 'assistant'; content: string }[],
    token: LlmCancellation | undefined
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    if (token?.isCancellationRequested) {
      throw new LlmUnavailableError('Cancelled.', 'The request was cancelled before it was sent.');
    }

    /*
     * The shared prefix becomes a system block marked cacheable. It has to sit
     * ahead of everything that varies, which is why it is a separate field
     * rather than something spliced into the first message: a prefix that is
     * "mostly the same" caches nothing at all.
     *
     * Below the minimum it is inlined into the first message instead, so the
     * model sees identical text either way and only the billing differs.
     */
    const prefix = req.cachedPrefix ?? '';
    const cacheable = prefix.length >= MIN_CACHEABLE_CHARS;

    const system = cacheable
      ? [{ type: 'text' as const, text: prefix, cache_control: { type: 'ephemeral' as const } }]
      : undefined;

    // Above the minimum the prefix travels as a cache block; below it, the same
    // text is inlined by the shared helper. Identical prompt, different billing.
    const body = cacheable ? messages : withCachedPrefix(messages, prefix);

    this.calls++;
    this.opts.onCall?.({
      n: this.calls,
      tool: req.toolName,
      inputTokens: Math.ceil((prefix.length + body.reduce((n, m) => n + m.content.length, 0)) / 4)
    });

    let response: Anthropic.Message;
    try {
      response = await this.withRetry(req.toolName, () =>
        this.client.messages.create(
          {
            model: this.model,
            max_tokens: this.maxTokens,
            ...(system ? { system } : {}),
            messages: body,
            tools: [
              {
                name: req.toolName,
                description: req.toolDescription,
                input_schema: req.inputSchema as Anthropic.Tool.InputSchema
              }
            ],
            // The structured-output guarantee: the model must call this tool.
            tool_choice: { type: 'tool', name: req.toolName }
          },
          token ? { signal: toAbortSignal(token) } : undefined
        )
      );
    } catch (err) {
      throw translate(err);
    }

    const call = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === req.toolName
    );
    if (!call) {
      const prose = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .slice(0, 300);
      return {
        ok: false,
        error: `the model did not call ${req.toolName}${prose ? `; it said: ${prose}` : ''}`
      };
    }

    const parsed = req.parse(call.input);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error };
  }

  private async withRetry<T>(tool: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!isTransient(err) || attempt === RETRY_DELAYS_MS.length) throw err;
        const delay = RETRY_DELAYS_MS[attempt];
        this.opts.onRetry?.(attempt + 1, delay, `${tool}: ${describe(err)}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}

function describe(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  return status ? `${status} ${message}` : message;
}

function translate(err: unknown): LlmUnavailableError {
  const status = (err as { status?: number })?.status;
  if (status === 401) {
    return new LlmUnavailableError(
      'Anthropic rejected the API key.',
      'Run "ReqForge: Set Anthropic API Key" with a current key.',
      err
    );
  }
  if (status === 429) {
    return new LlmUnavailableError(
      'Anthropic rate limit reached.',
      'Wait a moment and try again, or lower the panel concurrency.',
      err
    );
  }
  if (status === 400) {
    return new LlmUnavailableError(
      `Anthropic rejected the request: ${describe(err)}`,
      'This usually means the prompt exceeded the context window. Try a smaller section of the PRD.',
      err
    );
  }
  return new LlmUnavailableError(`The Anthropic request failed: ${describe(err)}`, 'Check the network connection.', err);
}

/** Bridges VS Code's cancellation shape onto the SDK's AbortSignal. */
function toAbortSignal(token: LlmCancellation): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
