/**
 * Full-profile smoke tests: the agent layer, Teamwork Graph duplicate
 * detection, and the panel-findings sidecar.
 *
 * Split out of smoke.mjs so the shared suite imports no full-profile module and
 * can be copied verbatim into the exported restricted repo. This file is not
 * exported — the code it tests does not exist there.
 *
 *   node scripts/smoke.full.mjs
 */
import * as esbuild from 'esbuild';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'reqforge-smoke-full-'));
const entry = path.join(dir, 'entry.mjs');

writeFileSync(
  entry,
  `
export { ALL_CRITERIA, EPIC_CRITERIA, STORY_CRITERIA } from '${path.resolve('src/core/rubric/criteria.ts')}';
export { Orchestrator } from '${path.resolve('src/core/agents/orchestrator.ts')}';
export { BudgetExceededError } from '${path.resolve('src/core/agents/types.ts')}';
export { REVIEWERS, ownedAt, reviewerById } from '${path.resolve('src/core/agents/reviewers.ts')}';
export { runPanel } from '${path.resolve('src/core/agents/panel.ts')}';
export { findDuplicates } from '${path.resolve('src/core/pipeline/duplicates.ts')}';
export { loadPanelFindings, savePanelFindings, deletePanelFindings, pruneByKey, liveValues, panelPath } from '${path.resolve('src/core/findings.ts')}';
`
);

const out = path.join(dir, 'bundle.cjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  outfile: out,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});

const m = createRequire(import.meta.url)(out);

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
};

/** In-memory filesystem, matching the shared suite's. */
const memFs = () => {
  const files = new Map();
  return {
    read: async (p) => files.get(p),
    write: async (p, text) => void files.set(p, text),
    remove: async (p) => void files.delete(p),
    list: async () => [...files.keys()]
  };
};

/* ------------------------------------------------------------ agent layer */

{
  /** A scripted LlmPort. `handler` sees the request and returns the tool input. */
  const fakeLlm = (handler) => ({
    kind: 'fixture',
    probe: async () => ({ ok: true, detail: 'fake' }),
    contextWindow: async () => 100000,
    countTokens: async (t) => Math.ceil(t.length / 4),
    requestStructured: async (req, token) => handler(req, token)
  });

  /* -- the partition, which everything else depends on --------------------- */

  const owned = m.REVIEWERS.flatMap((r) => r.owns);
  const allIds = m.ALL_CRITERIA.map((c) => c.id);
  check(
    'every rubric criterion is owned by a reviewer',
    allIds.every((id) => owned.includes(id)),
    allIds.filter((id) => !owned.includes(id)).join(', ')
  );
  check(
    'no criterion is owned by two reviewers',
    new Set(owned).size === owned.length,
    owned.filter((id, i) => owned.indexOf(id) !== i).join(', ')
  );
  check(
    'reviewers own no criterion that does not exist',
    owned.every((id) => allIds.includes(id)),
    owned.filter((id) => !allIds.includes(id)).join(', ')
  );
  check(
    'ownedAt splits a reviewer by level',
    m.ownedAt(m.reviewerById('product'), 'epic').every((id) => id.startsWith('epic-')) &&
      m.ownedAt(m.reviewerById('product'), 'story').every((id) => id.startsWith('invest-'))
  );
  check('every reviewer has a request cap', m.REVIEWERS.every((r) => r.maxRequests > 0));

  /* -- orchestrator: budgets are structural, not per-agent discipline ------ */

  {
    const llm = fakeLlm(async () => ({}));
    const orch = new m.Orchestrator(llm, { maxTotalRequests: 100, concurrency: 1 });

    const outcome = await orch.run('greedy', 2, async (leased) => {
      let n = 0;
      // An agent that ignores its budget must be stopped by the lease, not by
      // its own good behaviour.
      for (let i = 0; i < 10; i++) {
        await leased.requestStructured({ toolName: 't' });
        n++;
      }
      return n;
    });

    check('an agent cannot spend past its own budget', outcome.ok === false, outcome.error);
    check('the budget error names the agent', /greedy/.test(outcome.error ?? ''), outcome.error);
    check('requests are counted even on failure', outcome.requests === 2, String(outcome.requests));
    check('the orchestrator counts what was spent', orch.requestsUsed === 2, String(orch.requestsUsed));
  }

  {
    const orch = new m.Orchestrator(fakeLlm(async () => ({})), { maxTotalRequests: 3, concurrency: 1 });
    await orch.run('a', 10, async (l) => {
      for (let i = 0; i < 3; i++) await l.requestStructured({ toolName: 't' });
    });
    const second = await orch.run('b', 10, async (l) => l.requestStructured({ toolName: 't' }));
    check('the shared ceiling stops a later agent starting', second.ok === false, second.error);
    check('a skipped agent reports the ceiling, not a crash', /budget/i.test(second.error ?? ''), second.error);
    check('a skipped agent spends nothing', second.requests === 0);
  }

  {
    const orch = new m.Orchestrator(
      fakeLlm(async (req) => {
        if (req.toolName === 'boom') throw new Error('content filter');
        return { ok: true };
      }),
      { concurrency: 3 }
    );

    const outcomes = await orch.parallel([
      { agentId: 'one', maxRequests: 1, work: async (l) => l.requestStructured({ toolName: 'fine' }) },
      { agentId: 'two', maxRequests: 1, work: async (l) => l.requestStructured({ toolName: 'boom' }) },
      { agentId: 'three', maxRequests: 1, work: async (l) => l.requestStructured({ toolName: 'fine' }) }
    ]);

    check('one agent failing does not stop the others', outcomes.filter((o) => o.ok).length === 2);
    check('the failure is reported, not thrown', outcomes[1].ok === false && /content filter/.test(outcomes[1].error));
    check(
      'results come back in task order regardless of completion order',
      outcomes.map((o) => o.agentId).join(',') === 'one,two,three'
    );
  }

  {
    const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
    const orch = new m.Orchestrator(fakeLlm(async () => ({})), { token });
    const outcome = await orch.run('late', 5, async (l) => l.requestStructured({ toolName: 't' }));
    check('a cancelled run does not start an agent', outcome.ok === false && outcome.requests === 0, outcome.error);
    check('the orchestrator reports cancellation', orch.cancelled === true);
  }

  {
    // Concurrency has to be a real cap: Copilot rate-limits hard enough that an
    // unbounded fan-out makes a run slower rather than faster.
    let live = 0;
    let peak = 0;
    const orch = new m.Orchestrator(
      fakeLlm(async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return {};
      }),
      { concurrency: 2 }
    );
    await orch.parallel(
      ['a', 'b', 'c', 'd', 'e'].map((agentId) => ({
        agentId,
        maxRequests: 1,
        work: async (l) => l.requestStructured({ toolName: 't' })
      }))
    );
    check('concurrency is capped', peak <= 2, `peak ${peak}`);
  }

  /* -- the panel ----------------------------------------------------------- */

  const panelBacklog = {
    version: 1,
    source: { kind: 'confluence', pageId: '1', title: 'Payments PRD', url: 'u', ingestedAt: 'now' },
    target: { projectKey: 'PAY', epicIssueType: 'Epic', storyIssueType: 'Story' },
    prd: {
      title: 'Payments',
      summary: 'Take card payments',
      goals: ['Reduce checkout friction'],
      nonGoals: ['Refunds'],
      personas: [{ name: 'Shopper', needs: 'pay quickly' }],
      constraints: ['PCI DSS'],
      openQuestions: [],
      risks: []
    },
    epics: [
      {
        ref: 'card-payments',
        title: 'Card payments',
        outcome: 'Shoppers can pay by card',
        description: 'd',
        priority: 'must',
        inScope: [],
        outOfScope: [],
        successMeasures: [],
        acceptanceCriteria: ['Given a valid card, when paying, then the order completes'],
        nonFunctional: [],
        assumptions: [],
        links: [],
        dependsOn: [],
        sizing: '',
        openQuestions: [],
        sourceEvidence: [],
        container: false,
        sync: {},
        stories: [
          {
            ref: 'enter-card',
            epicRef: 'card-payments',
            title: 'Enter card details',
            narrative: { role: 'shopper', want: 'to enter my card', soThat: 'I can pay' },
            description: 'd',
            priority: 'must',
            acceptanceCriteria: ['Given a card form, when I submit, then payment is taken'],
            outOfScope: [],
            technicalNotes: '',
            assumptions: [],
            dependsOn: [],
            links: [],
            points: 0,
            openQuestions: [],
            sync: {}
          }
        ]
      }
    ]
  };

  {
    const seen = [];
    const llm = fakeLlm(async (req) => {
      seen.push(req.justification);
      if (req.toolName === 'emit_conflicts') return { conflicts: [] };

      // Which reviewer is calling is recoverable from the schema's enum, which
      // is exactly the criteria that reviewer owns.
      const ids = req.inputSchema.properties.reviews.items.properties.criteria.items.properties.id.enum;
      const refMatch = [...req.messages[0].content.matchAll(/<item ref="([^"]+)"/g)].map((x) => x[1]);
      return {
        reviews: refMatch.map((ref) => ({
          ref,
          criteria: ids.map((id) => ({ id, rating: 2, justification: `because of ${id}`, suggestion: 'do better' })),
          observations: [{ severity: 'warn', message: `note on ${ref}`, field: '' }]
        }))
      };
    });

    const result = await m.runPanel(llm, panelBacklog, { detectConflicts: false });

    check('the panel returns criteria for both levels', result.criteria.size === 2, String(result.criteria.size));
    check('no reviewer failed', result.partial === false, JSON.stringify(result.runs.filter((r) => !r.ok)));

    const epicKey = [...result.criteria.keys()].find((k) => k.startsWith('epic:'));
    const epicCriteria = result.criteria.get(epicKey);
    check(
      'every epic criterion was rated exactly once',
      epicCriteria.length === m.EPIC_CRITERIA.length,
      `${epicCriteria.length} vs ${m.EPIC_CRITERIA.length}`
    );
    check(
      'ratings are attributed to the reviewer that produced them',
      epicCriteria.every((c) => m.reviewerById(c.reviewerId) !== undefined),
      JSON.stringify(epicCriteria.map((c) => c.reviewerId))
    );
    check(
      'each criterion is attributed to its owner',
      epicCriteria.every((c) => m.reviewerById(c.reviewerId).owns.includes(c.id))
    );

    const storyKey = [...result.criteria.keys()].find((k) => k.startsWith('story:'));
    check(
      'every story criterion was rated exactly once',
      result.criteria.get(storyKey).length === m.STORY_CRITERIA.length
    );

    check('observations are collected', result.observations.length > 0);
    check(
      'observations carry their level and ref',
      result.observations.every((o) => (o.level === 'epic' || o.level === 'story') && o.ref)
    );
    check(
      'observations are attributed',
      result.observations.every((o) => m.reviewerById(o.reviewerId) !== undefined)
    );
    check('every reviewer consumed budget', result.runs.every((r) => r.requests > 0), JSON.stringify(result.runs));
  }

  {
    // A reviewer rating something it does not own must not overwrite the owner.
    const llm = fakeLlm(async (req) => {
      if (req.toolName === 'emit_conflicts') return { conflicts: [] };
      const refMatch = [...req.messages[0].content.matchAll(/<item ref="([^"]+)"/g)].map((x) => x[1]);
      return {
        reviews: refMatch.map((ref) => ({
          ref,
          criteria: [
            { id: 'epic-testable', rating: 0, justification: 'poaching', suggestion: 's' },
            { id: 'invest-small', rating: 0, justification: 'poaching', suggestion: 's' }
          ],
          observations: []
        }))
      };
    });

    const result = await m.runPanel(llm, panelBacklog, { detectConflicts: false });
    const epicKey = [...result.criteria.keys()].find((k) => k.startsWith('epic:'));
    const testRatings = (result.criteria.get(epicKey) ?? []).filter((c) => c.id === 'epic-testable');
    check(
      'a criterion rated by a non-owner is dropped',
      testRatings.length <= 1,
      `${testRatings.length} ratings for epic-testable`
    );
    check(
      'the surviving rating belongs to the owner',
      testRatings.every((c) => c.reviewerId === 'test'),
      JSON.stringify(testRatings.map((c) => c.reviewerId))
    );
  }

  {
    // One reviewer down: the run is partial and says which criteria went unrated.
    const llm = fakeLlm(async (req) => {
      if (req.toolName === 'emit_conflicts') return { conflicts: [] };
      if (/Test reviewer/.test(req.justification)) throw new Error('blocked by content filter');
      const ids = req.inputSchema.properties.reviews.items.properties.criteria.items.properties.id.enum;
      const refMatch = [...req.messages[0].content.matchAll(/<item ref="([^"]+)"/g)].map((x) => x[1]);
      return {
        reviews: refMatch.map((ref) => ({
          ref,
          criteria: ids.map((id) => ({ id, rating: 3, justification: 'j', suggestion: '' })),
          observations: []
        }))
      };
    });

    const result = await m.runPanel(llm, panelBacklog, { detectConflicts: false });
    check('a failed reviewer makes the run partial', result.partial === true);
    check('the other reviewers still produced ratings', result.criteria.size === 2);
    check(
      'the unrated criteria are named',
      result.unrated.includes('epic-testable') && result.unrated.includes('invest-testable'),
      result.unrated.join(',')
    );
    check(
      'the failure is attributed to the reviewer',
      result.runs.find((r) => r.reviewerId === 'test')?.ok === false
    );
  }

  {
    // Conflicts: only raised where two reviewers both asked for a change.
    let reconcilerSaw = null;
    const llm = fakeLlm(async (req) => {
      if (req.toolName === 'emit_conflicts') {
        reconcilerSaw = req.messages[0].content;
        return {
          conflicts: [
            {
              ref: 'card-payments',
              reviewerA: 'delivery',
              reviewerB: 'product',
              positionA: 'Split it',
              positionB: 'It is already minimal',
              tradeoff: 'Ship sooner or keep the outcome whole'
            },
            // A ref nobody reviewed must not survive.
            { ref: 'invented', reviewerA: 'a', reviewerB: 'b', positionA: 'x', positionB: 'y', tradeoff: 'z' }
          ]
        };
      }
      const ids = req.inputSchema.properties.reviews.items.properties.criteria.items.properties.id.enum;
      const refMatch = [...req.messages[0].content.matchAll(/<item ref="([^"]+)"/g)].map((x) => x[1]);
      return {
        reviews: refMatch.map((ref) => ({
          ref,
          criteria: ids.map((id) => ({ id, rating: 1, justification: 'j', suggestion: `change ${id}` })),
          observations: []
        }))
      };
    });

    const result = await m.runPanel(llm, panelBacklog, {});
    check('conflicts are detected', result.conflicts.length === 1, JSON.stringify(result.conflicts));
    check('a conflict names both sides', result.conflicts[0].between.join(',') === 'delivery,product');
    check('a conflict keeps both positions rather than picking one', result.conflicts[0].positions.length === 2);
    check('a conflict states the trade-off', result.conflicts[0].tradeoff.length > 0);
    check('a conflict about an unknown ref is dropped', !result.conflicts.some((c) => c.ref === 'invented'));
    check('the reconciler only sees contested items', /card-payments/.test(reconcilerSaw));
  }

  {
    // The panel overlaps reviewers only as far as the provider tolerates.
    const peakFor = async (kind) => {
      let live = 0;
      let peak = 0;
      const llm = {
        ...fakeLlm(async (req) => {
          if (req.toolName === 'emit_conflicts') return { conflicts: [] };
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
          const ids = req.inputSchema.properties.reviews.items.properties.criteria.items.properties.id.enum;
          const refs = [...req.messages[0].content.matchAll(/<item ref="([^"]+)"/g)].map((x) => x[1]);
          return {
            reviews: refs.map((ref) => ({
              ref,
              criteria: ids.map((id) => ({ id, rating: 3, justification: 'j', suggestion: '' })),
              observations: []
            }))
          };
        }),
        kind
      };
      await m.runPanel(llm, panelBacklog, { detectConflicts: false });
      return peak;
    };

    check('copilot keeps the fan-out narrow', (await peakFor('copilot')) <= 2);
    check('a provider with headroom fans out wider', (await peakFor('anthropic')) > 2);
  }

  {
    // A backlog where reviewers agree costs nothing extra.
    const llm = fakeLlm(async (req) => {
      if (req.toolName === 'emit_conflicts') throw new Error('the reconciler should not have run');
      const ids = req.inputSchema.properties.reviews.items.properties.criteria.items.properties.id.enum;
      const refMatch = [...req.messages[0].content.matchAll(/<item ref="([^"]+)"/g)].map((x) => x[1]);
      return {
        reviews: refMatch.map((ref) => ({
          ref,
          criteria: ids.map((id) => ({ id, rating: 3, justification: 'j', suggestion: '' })),
          observations: []
        }))
      };
    });
    const result = await m.runPanel(llm, panelBacklog, {});
    check('no suggestions means no reconciliation call', result.conflicts.length === 0);
  }

  /* -- the panel must not be able to reach Jira ---------------------------- */

  // Comments are stripped first: these files document the constraint by naming
  // the type they must not import, and a guard that punishes you for writing
  // that down teaches people to delete the explanation instead of the import.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const file of ['src/core/agents/panel.ts', 'src/core/agents/orchestrator.ts', 'src/core/agents/reviewers.ts']) {
    const code = stripComments(readFileSync(file, 'utf8'));
    check(
      `${file.split('/').pop()}: cannot reach Jira`,
      !/AtlassianPort|executePush|planPush|createIssue|updateIssue|semanticSearch/.test(code),
      'the panel is model-only by construction; retrieval belongs in the pipeline layer'
    );
  }

  /* -- duplicate detection over Teamwork Graph ----------------------------- */

  const dupBacklog = (epics) => ({ ...panelBacklog, epics });
  const anEpic = (over) => ({ ...panelBacklog.epics[0], stories: [], ...over });

  const fakePort = (caps, search) => ({
    kind: 'mcp',
    capabilities: () => new Set(caps),
    semanticSearch: search
  });

  {
    let searched = false;
    const report = await m.findDuplicates(
      fakePort(['jira.read'], async () => {
        searched = true;
        return [];
      }),
      fakeLlm(async () => ({ verdicts: [] })),
      dupBacklog([anEpic({})])
    );
    check('duplicate check reports unavailable without graph.search', report.available === false);
    check('unavailable says what to change', /transport/i.test(report.unavailableReason ?? ''));
    check('unavailable does not search', searched === false);
    check(
      'unavailable is distinguishable from a clean result',
      report.checked.length === 0 && report.candidates.length === 0
    );
  }

  {
    const queries = [];
    const port = fakePort(['graph.search'], async (q) => {
      queries.push(q);
      return [
        { id: 'PAY-99', title: 'Accept credit cards', product: 'jira', url: 'u', score: 0.9 },
        { id: 'PAY-1', title: 'Our own pushed epic', product: 'jira', url: 'u', score: 0.8 },
        { id: 'PAY-77', title: 'Payment reporting', product: 'jira', url: 'u', score: 0.4 },
        { id: 'PAY-55', title: 'Unrelated thing', product: 'jira', url: 'u', score: 0.2 }
      ];
    });

    const backlog = dupBacklog([
      anEpic({ ref: 'card-payments', sync: {} }),
      anEpic({ ref: 'already-pushed', sync: { jiraKey: 'PAY-1' } }),
      anEpic({ ref: 'grouping', container: true, sync: {} })
    ]);

    let promptSeen = '';
    const llm = fakeLlm(async (req) => {
      promptSeen = req.messages[0].content;
      return {
        verdicts: [
          { ref: 'card-payments', key: 'PAY-99', relationship: 'related', reason: 'same area' },
          { ref: 'card-payments', key: 'PAY-77', relationship: 'duplicate', reason: 'same work' },
          { ref: 'card-payments', key: 'PAY-55', relationship: 'unrelated', reason: 'no' },
          // A key the search never returned must not reach the PO.
          { ref: 'card-payments', key: 'PAY-000', relationship: 'duplicate', reason: 'invented' }
        ]
      };
    });

    const report = await m.findDuplicates(port, llm, backlog);

    check('only unpushed, non-container epics are checked', report.checked.join(',') === 'card-payments', report.checked.join(','));
    check('the query is more than the title', /Shoppers can pay by card/.test(queries[0]), queries[0]);
    check('our own pushed issues are filtered out', !/PAY-1\]/.test(promptSeen), promptSeen.slice(0, 200));
    check('unrelated verdicts are dropped', !report.candidates.some((c) => c.hit.id === 'PAY-55'));
    check('an invented key is dropped', !report.candidates.some((c) => c.hit.id === 'PAY-000'));
    check('surviving candidates are kept', report.candidates.length === 2, String(report.candidates.length));
    check(
      'duplicates are ranked above related',
      report.candidates[0].relationship === 'duplicate',
      report.candidates.map((c) => c.relationship).join(',')
    );
    check('a candidate carries the reason', report.candidates[0].reason === 'same work');
    check('a candidate carries the found issue', report.candidates[0].hit.title === 'Payment reporting');
  }

  {
    // Nothing found: no model call at all, and the result says it looked.
    const report = await m.findDuplicates(
      fakePort(['graph.search'], async () => []),
      fakeLlm(async () => {
        throw new Error('the model should not have been called');
      }),
      dupBacklog([anEpic({})])
    );
    check('a clean check makes no model call', report.available === true && report.candidates.length === 0);
    check('a clean check still records what it looked at', report.checked.length === 1);
  }

  {
    // A search that throws must not lose the run.
    let calls = 0;
    const report = await m.findDuplicates(
      fakePort(['graph.search'], async () => {
        calls++;
        if (calls === 1) throw new Error('rate limited');
        return [{ id: 'PAY-42', title: 'Existing', product: 'jira', url: 'u' }];
      }),
      fakeLlm(async () => ({
        verdicts: [{ ref: 'second', key: 'PAY-42', relationship: 'overlaps', reason: 'partly' }]
      })),
      dupBacklog([anEpic({ ref: 'first' }), anEpic({ ref: 'second' })])
    );
    check('one failed lookup does not lose the others', report.candidates.length === 1, JSON.stringify(report.candidates));
    check('both items are still reported as checked', report.checked.length === 2);
  }

  /* -- panel findings persist and go stale with their item ---------------- */

  {
    const fs = memFs();
    const obs = { reviewerId: 'test', level: 'epic', ref: 'a', severity: 'warn', message: 'no empty state' };
    const con = { level: 'epic', ref: 'a', between: ['delivery', 'product'], positions: ['x', 'y'], tradeoff: 'z' };

    await m.savePanelFindings(fs, 'folder', 'slug', {
      observations: new Map([['epic:a:hash1', [obs]]]),
      conflicts: new Map([['epic:a:hash1', [con]]])
    });

    const loaded = await m.loadPanelFindings(fs, 'folder', 'slug');
    check('panel findings round trip', loaded.observations.get('epic:a:hash1')[0].message === 'no empty state');
    check('conflicts round trip', loaded.conflicts.get('epic:a:hash1')[0].tradeoff === 'z');
    check('panel findings live beside the backlog', m.panelPath('folder', 'slug') === 'folder/slug.panel.json');

    // The staleness guarantee: an edited item's fingerprint changes, so its
    // findings stop matching and vanish along with its ratings.
    const live = new Set(['epic:a:hash2']);
    check('editing an item drops its observations', m.pruneByKey(loaded.observations, live).size === 0);
    check('editing an item drops its conflicts', m.pruneByKey(loaded.conflicts, live).size === 0);
    check(
      'findings survive while the fingerprint holds',
      m.pruneByKey(loaded.observations, new Set(['epic:a:hash1'])).size === 1
    );
    check(
      'only live findings are sent to the webview',
      m.liveValues(loaded.observations, live).length === 0 &&
        m.liveValues(loaded.observations, new Set(['epic:a:hash1'])).length === 1
    );

    await m.deletePanelFindings(fs, 'folder', 'slug');
    const gone = await m.loadPanelFindings(fs, 'folder', 'slug');
    check('deleting removes the findings file', gone.observations.size === 0 && gone.conflicts.size === 0);

    await fs.write(m.panelPath('folder', 'slug'), '{ not json');
    const corrupt = await m.loadPanelFindings(fs, 'folder', 'slug');
    check('a corrupt findings file does not stop the backlog opening', corrupt.observations.size === 0);
  }

  // ...and prove the guard actually bites, rather than passing because the
  // regex never matches anything.
  check(
    'the Jira guard would catch a real import',
    /AtlassianPort/.test(stripComments("import type { AtlassianPort } from '../ports';\n/* AtlassianPort */"))
  );
  check(
    'the Jira guard ignores a mention in prose',
    !/AtlassianPort/.test(stripComments('/**\n * Never imports AtlassianPort.\n */\nconst x = 1;'))
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
