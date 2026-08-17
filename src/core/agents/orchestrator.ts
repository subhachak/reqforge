import type { LlmCancellation, LlmPort, StructuredRequest } from '../ports';
import { BudgetExceededError } from './types';

/**
 * Coordination, in code.
 *
 * There is real coordination work here — fan out, collect, enforce budgets,
 * survive one agent failing, stay cancellable — but none of it is a judgement
 * call, so none of it is a prompt. A model in this seat would re-derive a fixed
 * sequence on every run, cost a request per decision, and make "why was that
 * reviewer skipped?" unanswerable. Where judgement *is* required — choosing
 * what to spend a remaining budget on — a model is invoked as one step of this
 * orchestrator, not as its replacement.
 *
 * Every agent talks to the model through a lease this class hands out, so
 * accounting, attribution and cancellation are structural rather than something
 * each agent has to remember.
 */

export interface OrchestratorEvent {
  type: 'agent-start' | 'agent-done' | 'agent-failed' | 'request';
  agentId: string;
  detail?: string;
  /** Requests consumed by this agent so far. */
  requests?: number;
}

export interface OrchestratorOptions {
  /** Ceiling across every agent in the run, on top of each agent's own cap. */
  maxTotalRequests?: number;
  /**
   * How many agents may call the model at once. Copilot rate-limits hard
   * enough that fanning out four reviewers at once makes a run slower, not
   * faster; providers with real headroom can raise this.
   */
  concurrency?: number;
  onEvent?: (event: OrchestratorEvent) => void;
  token?: LlmCancellation;
}

const DEFAULTS = { maxTotalRequests: 60, concurrency: 2 };

export interface AgentOutcome<T> {
  agentId: string;
  ok: boolean;
  value?: T;
  error?: string;
  requests: number;
  ms: number;
}

/**
 * A metered view of the LlmPort, scoped to one agent.
 *
 * An agent cannot opt out of its budget: the only way it can reach a model is
 * through this, and this counts. That is the whole reason agents are not handed
 * the raw port.
 */
class Lease implements LlmPort {
  readonly kind: LlmPort['kind'];
  requests = 0;

  constructor(
    private readonly inner: LlmPort,
    private readonly agentId: string,
    private readonly limit: number,
    private readonly onSpend: (agentId: string) => void
  ) {
    this.kind = inner.kind;
  }

  probe() {
    return this.inner.probe();
  }
  contextWindow() {
    return this.inner.contextWindow();
  }
  countTokens(text: string) {
    return this.inner.countTokens(text);
  }

  async requestStructured<T>(req: StructuredRequest<T>, token?: LlmCancellation): Promise<T> {
    if (this.requests >= this.limit) throw new BudgetExceededError(this.agentId, this.limit);
    this.requests++;
    this.onSpend(this.agentId);
    return this.inner.requestStructured<T>(req, token);
  }
}

export class Orchestrator {
  private readonly opts: Required<Omit<OrchestratorOptions, 'onEvent' | 'token'>> &
    Pick<OrchestratorOptions, 'onEvent' | 'token'>;
  private totalRequests = 0;

  constructor(
    private readonly llm: LlmPort,
    options: OrchestratorOptions = {}
  ) {
    this.opts = {
      maxTotalRequests: options.maxTotalRequests ?? DEFAULTS.maxTotalRequests,
      concurrency: options.concurrency ?? DEFAULTS.concurrency,
      onEvent: options.onEvent,
      token: options.token
    };
  }

  get requestsUsed(): number {
    return this.totalRequests;
  }

  get requestsRemaining(): number {
    return Math.max(0, this.opts.maxTotalRequests - this.totalRequests);
  }

  get cancelled(): boolean {
    return this.opts.token?.isCancellationRequested === true;
  }

  /**
   * Runs one agent under its own budget.
   *
   * Never throws for an agent-level failure. A reviewer that hits a content
   * filter, or a server that drops one connection, must not lose the other
   * three reviewers' work — a partial panel is a usable result and a failed run
   * is not.
   */
  async run<T>(
    agentId: string,
    maxRequests: number,
    work: (llm: LlmPort) => Promise<T>
  ): Promise<AgentOutcome<T>> {
    const started = Date.now();

    if (this.cancelled) {
      return { agentId, ok: false, error: 'Cancelled before starting.', requests: 0, ms: 0 };
    }
    // The shared ceiling is checked here rather than inside the lease so an
    // agent that cannot afford to start is reported as skipped, not as failed
    // halfway through with partial output.
    if (this.requestsRemaining === 0) {
      return { agentId, ok: false, error: 'The run reached its overall request budget.', requests: 0, ms: 0 };
    }

    const allowance = Math.min(maxRequests, this.requestsRemaining);
    const lease = new Lease(this.llm, agentId, allowance, (id) => {
      this.totalRequests++;
      this.opts.onEvent?.({ type: 'request', agentId: id, requests: this.totalRequests });
    });

    this.opts.onEvent?.({ type: 'agent-start', agentId });
    try {
      const value = await work(lease);
      const outcome = { agentId, ok: true, value, requests: lease.requests, ms: Date.now() - started };
      this.opts.onEvent?.({ type: 'agent-done', agentId, requests: lease.requests });
      return outcome;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.opts.onEvent?.({ type: 'agent-failed', agentId, detail: error, requests: lease.requests });
      return { agentId, ok: false, error, requests: lease.requests, ms: Date.now() - started };
    }
  }

  /**
   * Runs agents concurrently, bounded by `concurrency`.
   *
   * Results come back in the order the tasks were given regardless of the order
   * they finish, so a run is reproducible to read even though it is not
   * reproducible to execute.
   */
  async parallel<T>(
    tasks: { agentId: string; maxRequests: number; work: (llm: LlmPort) => Promise<T> }[]
  ): Promise<AgentOutcome<T>[]> {
    const results: AgentOutcome<T>[] = new Array(tasks.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= tasks.length) return;
        const task = tasks[index];
        results[index] = await this.run(task.agentId, task.maxRequests, task.work);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.opts.concurrency, tasks.length) }, () => worker())
    );
    return results;
  }
}
