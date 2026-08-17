import type { Backlog } from '../model';
import type { LlmCancellation, LlmPort, StructuredRequest } from '../ports';
import type { CriterionResult, ItemQuality, RubricConfig } from '../rubric/types';
import { assessBacklog } from '../rubric/assess';
import { evaluateBacklog, fixInstruction } from '../rubric/score';
import { applyRefinement, refineBacklogItem } from './refineLocal';
import type { Progress } from './decompose';

/**
 * Improve a backlog until it meets the rubric, or until a bound stops it.
 *
 * This is the one part of ReqForge that decides for itself what to do next:
 * it assesses, picks what failed, rewrites it, re-assesses, and repeats. The
 * rubric threshold is the goal and the score is the objective function, which
 * is only possible because the score is computed from named criteria rather
 * than invented by a model.
 *
 * Three properties matter more than the loop itself:
 *
 *  - **It never touches Jira.** Autonomy stops at the boundary where actions
 *    stop being reversible. Everything here edits the local backlog, and
 *    sending remains a human decision made against a diff.
 *  - **It is bounded four ways** — a goal, an iteration cap, a request budget,
 *    and a no-progress check. An unbounded loop against a monthly premium-request
 *    allowance is not a feature.
 *  - **It records what it did.** Every rewrite is reported with the score before
 *    and after, so the run is reviewable rather than a black box that improved
 *    a number.
 */

export interface ImproveOptions {
  /** Epic refs to work on, with their stories. Omit for the whole backlog. */
  only?: string[];
  /** Passes over the failing set. */
  maxIterations?: number;
  /** Hard ceiling on model requests, counted across assessment and rewriting. */
  maxRequests?: number;
  progress?: Progress;
  token?: LlmCancellation;
  /**
   * How to re-assess after each pass. Defaults to the single rubric pass.
   *
   * Injected rather than imported so this module stays profile-neutral: the
   * full profile hands in the reviewer panel, and without it a fix would be
   * graded by a different mechanism than the review that demanded it — and
   * would quietly drop the reviewer attribution on everything it touched.
   */
  assess?: Assessor;
}

/** Matches assessBacklog's shape, so the default needs no adapter. */
export type Assessor = (
  llm: LlmPort,
  backlog: Backlog,
  config: RubricConfig,
  opts: {
    only?: { epics?: string[]; stories?: string[] };
    cached?: Map<string, CriterionResult[]>;
    progress?: Progress;
    token?: LlmCancellation;
  }
) => Promise<Map<string, CriterionResult[]>>;

export interface ImproveStep {
  iteration: number;
  level: 'epic' | 'story';
  ref: string;
  title: string;
  scoreBefore: number;
  scoreAfter: number;
  /** Criterion names that gained a rating, for the report. */
  improved: string[];
  accepted: boolean;
}

export type StopReason = 'goal-met' | 'no-progress' | 'iteration-limit' | 'request-limit' | 'cancelled' | 'nothing-to-do';

export interface ImproveResult {
  steps: ImproveStep[];
  iterations: number;
  requests: number;
  stoppedBecause: StopReason;
  passedBefore: number;
  passedAfter: number;
  scoreBefore: number;
  scoreAfter: number;
  /** Assessments after the run, for the caller to persist. */
  assessments: Map<string, CriterionResult[]>;
}

const DEFAULTS = { maxIterations: 3, maxRequests: 40 };

/** Counts requests without the loop needing to know how the adapter batches. */
function counting(llm: LlmPort, onRequest: () => void): LlmPort {
  return {
    kind: llm.kind,
    probe: () => llm.probe(),
    contextWindow: () => llm.contextWindow(),
    countTokens: (t: string) => llm.countTokens(t),
    requestStructured: <T>(req: StructuredRequest<T>, token?: LlmCancellation) => {
      onRequest();
      return llm.requestStructured(req, token);
    }
  };
}

export async function improveBacklog(
  llm: LlmPort,
  backlog: Backlog,
  config: RubricConfig,
  assessments: Map<string, CriterionResult[]>,
  opts: ImproveOptions = {}
): Promise<ImproveResult> {
  const maxIterations = opts.maxIterations ?? DEFAULTS.maxIterations;
  const maxRequests = opts.maxRequests ?? DEFAULTS.maxRequests;

  let requests = 0;
  const budgeted = counting(llm, () => {
    requests++;
  });

  const inScope = (q: ItemQuality) => {
    if (!opts.only) return true;
    if (q.level === 'epic') return opts.only.includes(q.ref);
    return backlog.epics.some((e) => opts.only!.includes(e.ref) && e.stories.some((s) => s.ref === q.ref));
  };

  const scopeRefs = () => ({
    epics: (opts.only ?? backlog.epics.map((e) => e.ref)).slice(),
    stories: backlog.epics
      .filter((e) => !opts.only || opts.only.includes(e.ref))
      .flatMap((e) => e.stories.map((s) => s.ref))
  });

  let current = assessments;
  const assess = opts.assess ?? assessBacklog;
  const steps: ImproveStep[] = [];

  // Baseline. Everything in scope must have a current assessment before the
  // loop can tell what failed.
  opts.progress?.report('Assessing the backlog…');
  current = await assess(budgeted, backlog, config, {
    only: scopeRefs(),
    cached: current,
    progress: opts.progress,
    token: opts.token
  });

  const baseline = evaluateBacklog(backlog, config, current);
  const scoreBefore = baseline.score;
  const passedBefore = baseline.items.filter((i) => inScope(i) && i.passed).length;

  let stoppedBecause: StopReason = 'iteration-limit';
  let iterations = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterations = iteration;

    if (opts.token?.isCancellationRequested) {
      stoppedBecause = 'cancelled';
      break;
    }

    const quality = evaluateBacklog(backlog, config, current);
    const failing = quality.items.filter((i) => inScope(i) && !i.passed);

    if (failing.length === 0) {
      stoppedBecause = iteration === 1 && steps.length === 0 ? 'nothing-to-do' : 'goal-met';
      break;
    }

    // Worst first: the same budget buys more where the gap is largest.
    failing.sort((a, b) => a.score - b.score);

    let rewroteSomething = false;

    for (const item of failing) {
      if (requests >= maxRequests) {
        stoppedBecause = 'request-limit';
        break;
      }
      if (opts.token?.isCancellationRequested) {
        stoppedBecause = 'cancelled';
        break;
      }

      opts.progress?.report(`Pass ${iteration}: rewriting "${item.title}" (${item.score}/${item.threshold})…`);

      try {
        const result = await refineBacklogItem(
          budgeted,
          backlog,
          { level: item.level, ref: item.ref },
          fixInstruction(item),
          opts.token
        );
        if (!result.changed) continue;
        applyRefinement(backlog, result);
        rewroteSomething = true;
        steps.push({
          iteration,
          level: item.level,
          ref: item.ref,
          title: item.title,
          scoreBefore: item.score,
          scoreAfter: item.score, // filled in after re-assessment
          improved: [],
          accepted: true
        });
      } catch (err) {
        // One item failing to rewrite should not end the run; the rest may
        // still improve, and the reason is worth reporting.
        opts.progress?.report(`Could not rewrite "${item.title}": ${(err as Error).message}`);
      }
    }

    if (stoppedBecause === 'request-limit' || stoppedBecause === 'cancelled') break;

    if (!rewroteSomething) {
      stoppedBecause = 'no-progress';
      break;
    }

    // Rewriting changed the fingerprints, so those assessments are stale by
    // construction and the next pass re-scores exactly what moved.
    opts.progress?.report(`Pass ${iteration}: re-checking what changed…`);
    current = await assess(budgeted, backlog, config, {
      only: scopeRefs(),
      cached: current,
      progress: opts.progress,
      token: opts.token
    });

    const after = evaluateBacklog(backlog, config, current);
    let improvedAny = false;
    for (const step of steps.filter((s) => s.iteration === iteration)) {
      const now = after.items.find((i) => i.level === step.level && i.ref === step.ref);
      if (!now) continue;
      step.scoreAfter = now.score;
      if (now.score > step.scoreBefore) improvedAny = true;
      step.improved = now.criteria.filter((c) => c.rating >= 2).map((c) => c.id);
    }

    // A pass that rewrote things and moved nothing will not do better next
    // time; stopping here is the difference between three requests and thirty.
    if (!improvedAny) {
      stoppedBecause = 'no-progress';
      break;
    }
  }

  const final = evaluateBacklog(backlog, config, current);
  return {
    steps,
    iterations,
    requests,
    stoppedBecause,
    passedBefore,
    passedAfter: final.items.filter((i) => inScope(i) && i.passed).length,
    scoreBefore,
    scoreAfter: final.score,
    assessments: current
  };
}

/** One line explaining why the run ended, for the report. */
export function describeStop(reason: StopReason, config: RubricConfig): string {
  switch (reason) {
    case 'goal-met':
      return `Everything reached the threshold of ${config.threshold}.`;
    case 'nothing-to-do':
      return 'Everything already met the threshold, so nothing was rewritten.';
    case 'no-progress':
      return 'A pass rewrote items without improving any score, so it stopped rather than spending more requests.';
    case 'iteration-limit':
      return 'The pass limit was reached. Run it again to continue.';
    case 'request-limit':
      return 'The request budget was reached. Run it again to continue.';
    case 'cancelled':
      return 'Cancelled. Everything rewritten so far has been kept.';
  }
}
