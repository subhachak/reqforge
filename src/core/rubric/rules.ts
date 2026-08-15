import type { EpicItem, StoryItem } from '../model';
import type { RubricConfig, RuleFinding, Severity } from './types';

/**
 * Deterministic checks. No model, no network, no judgement — every one of these
 * is a fact about the item. They run on every edit, and blockers fail an item
 * outright regardless of what the model thought of it: a well-written story
 * with no acceptance criteria is not a good story.
 */

interface Rule<T> {
  id: string;
  severity: Severity;
  field?: string;
  /** Returns a message when the rule is violated, or undefined when it passes. */
  check(item: T, ctx: RuleContext): string | undefined;
}

export interface RuleContext {
  allEpicRefs: Set<string>;
  siblingTitles: string[];
  /**
   * True when this backlog is a slice rather than a whole set — one epic
   * pulled out of Jira, say. A dependency that points outside a slice is
   * ordinary; the same dependency inside a complete decomposition is broken.
   * Rules that reason about the set as a whole have to know which they have.
   */
  partial: boolean;
}

/** Judgement words that make an acceptance criterion untestable. */
const VAGUE_WORDS = [
  'appropriate',
  'appropriately',
  'properly',
  'correctly',
  'as needed',
  'as required',
  'user-friendly',
  'intuitive',
  'seamless',
  'robust',
  'efficient',
  'fast',
  'quickly',
  'etc',
  'and so on',
  'tbd',
  'tbc'
];

const LAYER_WORDS = ['api', 'database', 'backend', 'front end', 'frontend', 'ui', 'schema', 'middleware'];

function vagueIn(text: string): string[] {
  const lower = text.toLowerCase();
  return VAGUE_WORDS.filter((w) => new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}\\b`).test(lower));
}

const EPIC_RULES: Rule<EpicItem>[] = [
  {
    id: 'has-title',
    severity: 'blocker',
    field: 'title',
    check: (e) => (e.title.trim() ? undefined : 'This epic has no title.')
  },
  {
    id: 'has-outcome',
    severity: 'blocker',
    field: 'outcome',
    check: (e) => (e.outcome.trim() ? undefined : 'No outcome stated — what becomes true once this ships?')
  },
  {
    id: 'has-acceptance-criteria',
    severity: 'blocker',
    field: 'acceptanceCriteria',
    check: (e) => (e.acceptanceCriteria.length > 0 ? undefined : 'No acceptance criteria.')
  },
  {
    id: 'complete-acceptance-criteria',
    severity: 'blocker',
    field: 'acceptanceCriteria',
    check: (e) => {
      const bad = e.acceptanceCriteria.filter((ac) => !ac.given.trim() || !ac.when.trim() || !ac.then.trim()).length;
      return bad ? `${bad} acceptance criterion(s) are missing a given, when, or then.` : undefined;
    }
  },
  {
    id: 'dependencies-resolve',
    severity: 'blocker',
    check: (e, ctx) => {
      // Only meaningful for a complete set. In a slice, see external-dependency.
      if (ctx.partial) return undefined;
      const dangling = e.dependsOn.filter((d) => !ctx.allEpicRefs.has(d));
      return dangling.length ? `Depends on epics that do not exist: ${dangling.join(', ')}.` : undefined;
    }
  },
  {
    id: 'external-dependency',
    severity: 'info',
    check: (e, ctx) => {
      if (!ctx.partial) return undefined;
      const outside = e.dependsOn.filter((d) => !ctx.allEpicRefs.has(d));
      return outside.length
        ? `Depends on ${outside.join(', ')}, which ${outside.length === 1 ? 'is' : 'are'} not in this backlog. Check separately that the work exists.`
        : undefined;
    }
  },
  {
    id: 'no-self-dependency',
    severity: 'blocker',
    check: (e) => (e.dependsOn.includes(e.ref) ? 'This epic depends on itself.' : undefined)
  },
  {
    id: 'has-evidence',
    severity: 'warn',
    field: 'sourceEvidence',
    check: (e, ctx) => {
      // Traceability is to a source document. An epic read back out of Jira
      // has none, so demanding evidence of it is noise on every import.
      if (ctx.partial) return undefined;
      return e.sourceEvidence.length > 0
        ? undefined
        : 'No evidence from the source document — this scope cannot be traced.';
    }
  },
  {
    id: 'has-success-measures',
    severity: 'warn',
    field: 'successMeasures',
    check: (e) =>
      (e.successMeasures ?? []).length > 0
        ? undefined
        : 'No success measures — nothing here says how you would know the outcome happened.'
  },
  {
    id: 'unmeasurable-success',
    severity: 'info',
    field: 'successMeasures',
    check: (e) => {
      const vague = (e.successMeasures ?? []).filter((mm) => !/\d/.test(mm));
      return vague.length
        ? `${vague.length} success measure(s) contain no number, so nobody can tell whether they were met.`
        : undefined;
    }
  },
  {
    id: 'has-out-of-scope',
    severity: 'warn',
    field: 'outOfScope',
    check: (e) => (e.outOfScope.length > 0 ? undefined : 'Nothing marked out of scope, so scope can drift silently.')
  },
  {
    id: 'sizing-xl',
    severity: 'warn',
    check: (e) => (e.sizing === 'XL' ? 'Sized XL — this is usually two epics.' : undefined)
  },
  {
    id: 'too-many-stories',
    severity: 'warn',
    check: (e) => (e.stories.length > 12 ? `${e.stories.length} stories — consider splitting the epic.` : undefined)
  },
  {
    id: 'no-stories',
    severity: 'warn',
    check: (e) => (e.stories.length === 0 ? 'No stories yet.' : undefined)
  },
  {
    id: 'layer-shaped',
    severity: 'warn',
    field: 'title',
    check: (e) => {
      const words = e.title.toLowerCase().split(/\W+/).filter(Boolean);
      // Only flag when the title is essentially just a component name.
      return words.length <= 4 && words.some((w) => LAYER_WORDS.includes(w))
        ? 'Title looks like a technical layer rather than an outcome.'
        : undefined;
    }
  },
  {
    id: 'vague-acceptance-criteria',
    severity: 'warn',
    field: 'acceptanceCriteria',
    check: (e) => {
      const hits = [...new Set(e.acceptanceCriteria.flatMap((ac) => vagueIn(`${ac.given} ${ac.when} ${ac.then}`)))];
      return hits.length ? `Acceptance criteria use words that cannot be tested: ${hits.join(', ')}.` : undefined;
    }
  },
  {
    id: 'insecure-link',
    severity: 'warn',
    field: 'links',
    check: (item: { links?: { url: string }[] }) => {
      const bad = (item.links ?? []).filter((l) => !/^https:\/\//i.test(l.url.trim()));
      return bad.length ? `${bad.length} link(s) are not https, so they may not open.` : undefined;
    }
  },
  {
    id: 'unresolved-questions',
    severity: 'info',
    field: 'openQuestions',
    check: (e) => (e.openQuestions.length ? `${e.openQuestions.length} open question(s) still unanswered.` : undefined)
  },
  {
    id: 'duplicate-title',
    severity: 'warn',
    field: 'title',
    check: (e, ctx) => {
      const mine = new Set(e.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
      if (mine.size === 0) return undefined;
      for (const other of ctx.siblingTitles) {
        const theirs = new Set(other.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
        const overlap = [...mine].filter((w) => theirs.has(w)).length;
        if (overlap / mine.size > 0.7) return `Very similar to another epic: "${other}".`;
      }
      return undefined;
    }
  }
];

const STORY_RULES: Rule<StoryItem>[] = [
  {
    id: 'has-title',
    severity: 'blocker',
    field: 'title',
    check: (s) => (s.title.trim() ? undefined : 'This story has no title.')
  },
  {
    id: 'has-narrative',
    severity: 'blocker',
    field: 'narrative',
    check: (s) => {
      const missing = (['asA', 'iWant', 'soThat'] as const).filter((k) => !s.narrative[k].trim());
      return missing.length ? `User story is incomplete — missing ${missing.join(', ')}.` : undefined;
    }
  },
  {
    id: 'has-acceptance-criteria',
    severity: 'blocker',
    field: 'acceptanceCriteria',
    check: (s) => (s.acceptanceCriteria.length > 0 ? undefined : 'No acceptance criteria.')
  },
  {
    id: 'complete-acceptance-criteria',
    severity: 'blocker',
    field: 'acceptanceCriteria',
    check: (s) => {
      const bad = s.acceptanceCriteria.filter((ac) => !ac.given.trim() || !ac.when.trim() || !ac.then.trim()).length;
      return bad ? `${bad} acceptance criterion(s) are missing a given, when, or then.` : undefined;
    }
  },
  {
    id: 'generic-persona',
    severity: 'warn',
    field: 'narrative',
    check: (s) =>
      /^(a |an |the )?(user|users|system|customer|someone|admin)$/i.test(s.narrative.asA.trim())
        ? `"${s.narrative.asA.trim()}" is not a specific role — name the persona from the requirements.`
        : undefined
  },
  {
    id: 'benefit-restates-want',
    severity: 'warn',
    field: 'narrative',
    check: (s) => {
      const want = new Set(s.narrative.iWant.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
      const benefit = s.narrative.soThat.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      if (want.size === 0 || benefit.length === 0) return undefined;
      const overlap = benefit.filter((w) => want.has(w)).length / benefit.length;
      return overlap > 0.6 ? 'The "so that" restates the "I want" rather than giving a benefit.' : undefined;
    }
  },
  {
    id: 'too-large',
    severity: 'warn',
    check: (s) => (s.points >= 13 ? `${s.points} points — too large to be one story.` : undefined)
  },
  {
    id: 'story-dependency-chain',
    severity: 'info',
    field: 'dependsOn',
    check: (s) =>
      (s.dependsOn ?? []).length > 2
        ? `Depends on ${s.dependsOn.length} other stories, which is rarely independently deliverable.`
        : undefined
  },
  {
    id: 'vague-acceptance-criteria',
    severity: 'warn',
    field: 'acceptanceCriteria',
    check: (s) => {
      const hits = [...new Set(s.acceptanceCriteria.flatMap((ac) => vagueIn(`${ac.given} ${ac.when} ${ac.then}`)))];
      return hits.length ? `Acceptance criteria use words that cannot be tested: ${hits.join(', ')}.` : undefined;
    }
  },
  {
    id: 'conjoined-criteria',
    severity: 'info',
    field: 'acceptanceCriteria',
    check: (s) => {
      const n = s.acceptanceCriteria.filter((ac) => / and .* and /i.test(ac.then)).length;
      return n ? `${n} criterion(s) chain several outcomes with "and" — split them.` : undefined;
    }
  },
  {
    id: 'insecure-link',
    severity: 'warn',
    field: 'links',
    check: (item: { links?: { url: string }[] }) => {
      const bad = (item.links ?? []).filter((l) => !/^https:\/\//i.test(l.url.trim()));
      return bad.length ? `${bad.length} link(s) are not https, so they may not open.` : undefined;
    }
  },
  {
    id: 'unresolved-questions',
    severity: 'info',
    field: 'openQuestions',
    check: (s) => (s.openQuestions.length ? `${s.openQuestions.length} open question(s) still unanswered.` : undefined)
  }
];

function run<T>(rules: Rule<T>[], item: T, ctx: RuleContext, config: RubricConfig): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const rule of rules) {
    const override = config.rules[rule.id];
    if (override === 'off') continue;
    const message = rule.check(item, ctx);
    if (message) {
      out.push({ ruleId: rule.id, severity: override ?? rule.severity, message, field: rule.field });
    }
  }
  return out;
}

export function checkEpic(epic: EpicItem, ctx: RuleContext, config: RubricConfig): RuleFinding[] {
  return run(EPIC_RULES, epic, ctx, config);
}

export function checkStory(story: StoryItem, ctx: RuleContext, config: RubricConfig): RuleFinding[] {
  return run(STORY_RULES, story, ctx, config);
}

/** Every rule id, for documenting what a rubric file may override. */
export const RULE_IDS = [...new Set([...EPIC_RULES, ...STORY_RULES].map((r) => r.id))].sort();
