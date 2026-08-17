/**
 * Dependency-free smoke test for the pure-logic pieces: storage->markdown,
 * markdown->ADF, ADF->markdown, page-id extraction, and the push planner's
 * idempotency decisions. Runs without VS Code and without network.
 *
 *   node scripts/smoke.mjs
 */
import * as esbuild from 'esbuild';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'reqforge-smoke-'));
const entry = path.join(dir, 'entry.mjs');

writeFileSync(
  entry,
  `
export { storageToMarkdown } from '${path.resolve('src/adapters/atlassian/storageFormat.ts')}';
export { markdownToAdf, adfToMarkdown } from '${path.resolve('src/adapters/atlassian/adf.ts')}';
export { extractPageId } from '${path.resolve('src/adapters/atlassian/rest.ts')}';
export { epicToMarkdown, storyToMarkdown, stampLabel, epicFingerprint, storyFingerprint, syncStatus, isPending } from '${path.resolve('src/core/model.ts')}';
export { serializeBacklog, deserializeBacklog, BacklogStore, backlogPath } from '${path.resolve('src/core/store.ts')}';
export { loadQuality, saveQuality, deleteQuality, qualityPath } from '${path.resolve('src/core/rubric/store.ts')}';
export { evaluateBacklog, scoreCriteria, fixInstruction, cacheKey, overrideKey } from '${path.resolve('src/core/rubric/score.ts')}';
export { DEFAULT_RUBRIC } from '${path.resolve('src/core/rubric/types.ts')}';
export { RULE_IDS } from '${path.resolve('src/core/rubric/rules.ts')}';
export { qualityLabels, qualityNote, staleQualityLabels, qualityLabelVocabulary } from '${path.resolve('src/core/rubric/labels.ts')}';
export { parseEpicMarkdown, parseStoryMarkdown } from '${path.resolve('src/core/pipeline/parseIssue.ts')}';
export { backlogFromJiraIssue, markAsSynced } from '${path.resolve('src/core/pipeline/fromJira.ts')}';
export { ALL_CRITERIA } from '${path.resolve('src/core/rubric/criteria.ts')}';
export { planPush } from '${path.resolve('src/core/pipeline/push.ts')}';
export { improveBacklog, describeStop } from '${path.resolve('src/core/pipeline/improve.ts')}';

export { STORY_CRITERIA, EPIC_CRITERIA } from '${path.resolve('src/core/rubric/criteria.ts')}';
export { Orchestrator } from '${path.resolve('src/core/agents/orchestrator.ts')}';
export { BudgetExceededError } from '${path.resolve('src/core/agents/types.ts')}';
export { REVIEWERS, ownedAt, reviewerById } from '${path.resolve('src/core/agents/reviewers.ts')}';
export { runPanel } from '${path.resolve('src/core/agents/panel.ts')}';
export { findDuplicates } from '${path.resolve('src/core/pipeline/duplicates.ts')}';
export { loadPanelFindings, savePanelFindings, deletePanelFindings, pruneByKey, liveValues, panelPath } from '${path.resolve('src/core/agents/store.ts')}';
`
);

// CJS, matching how the extension itself is bundled: some deps (yaml) are CJS
// and cannot be dynamically required from an ESM bundle.
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

/* ------------------------------------------------ confluence storage format */

const storage = `
<h1>Payments Revamp</h1>
<p>We need to <strong>reduce</strong> checkout friction.</p>
<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Deadline is Q3.</p></ac:rich-text-body></ac:structured-macro>
<h2>Requirements</h2>
<ul><li>Support Apple Pay</li><li>Support saved cards</li></ul>
<table><tbody>
<tr><th>Field</th><th>Rule</th></tr>
<tr><td>Amount</td><td>Must be positive</td></tr>
</tbody></table>
<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[POST /v1/charge]]></ac:plain-text-body></ac:structured-macro>
<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:status>complete</ac:status><ac:task-body>Legal review</ac:task-body></ac:task></ac:task-list>
`;

const md = m.storageToMarkdown(storage);
check('storage: heading survives', md.includes('# Payments Revamp'), md.slice(0, 200));
check('storage: bold survives', md.includes('**reduce**'));
check('storage: info macro body survives', md.includes('Deadline is Q3'));
check('storage: list survives', md.includes('- Support Apple Pay'));
check('storage: table becomes a markdown table', md.includes('| Field | Rule |'), md);
check('storage: code macro survives', md.includes('POST /v1/charge'));
check('storage: task body survives', md.includes('Legal review'));
check('storage: no raw ac: tags leak through', !md.includes('<ac:'), md);

/* --------------------------------------------------------- markdown <-> ADF */

const source = [
  '*Outcome:* Faster checkout',
  '',
  '## In scope',
  '- Apple Pay',
  '- Saved cards',
  '',
  '## Acceptance criteria',
  '- **Given** a saved card **when** the user checks out **then** no re-entry is required',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  'See [the spec](https://example.com/spec).',
  '',
  '---',
  '_Generated by ReqForge._'
].join('\n');

const adf = m.markdownToAdf(source);
check('adf: is a doc', adf.type === 'doc' && adf.version === 1);
check('adf: has heading nodes', adf.content.some((n) => n.type === 'heading'));
check('adf: has bullet list', adf.content.some((n) => n.type === 'bulletList'));
check('adf: has code block', adf.content.some((n) => n.type === 'codeBlock'));
check('adf: has rule', adf.content.some((n) => n.type === 'rule'));

const codeBlock = adf.content.find((n) => n.type === 'codeBlock');
check('adf: code block keeps language', codeBlock?.attrs?.language === 'ts', JSON.stringify(codeBlock));
check('adf: code block keeps content', codeBlock?.content?.[0]?.text === 'const x = 1;');

const flat = JSON.stringify(adf);
check('adf: link mark emitted', flat.includes('"type":"link"') && flat.includes('https://example.com/spec'));
check('adf: strong mark emitted', flat.includes('"type":"strong"'));
check('adf: no empty text nodes', !flat.includes('"text":""'), 'empty text nodes are rejected by Jira');

const roundTrip = m.adfToMarkdown(adf);
check('adf round trip: keeps heading', roundTrip.includes('## In scope'));
check('adf round trip: keeps list item', roundTrip.includes('- Apple Pay'));
check('adf round trip: keeps link', roundTrip.includes('[the spec](https://example.com/spec)'));

check('adf: empty input still produces a valid doc', m.markdownToAdf('').content.length > 0);

/* ------------------------------------------------------------ page id parse */

check('pageId: bare id', m.extractPageId('123456') === '123456');
check(
  'pageId: modern url',
  m.extractPageId('https://acme.atlassian.net/wiki/spaces/PROD/pages/98765/My+PRD') === '98765'
);
check('pageId: legacy url', m.extractPageId('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=555') === '555');
let threw = false;
try {
  m.extractPageId('not-a-page');
} catch {
  threw = true;
}
check('pageId: rejects nonsense with a clear error', threw);

/* ------------------------------------------------------- model + serialization */

const epic = {
  ref: 'apple-pay',
  title: 'Apple Pay at checkout',
  outcome: 'Shoppers can pay without typing card details',
  description: 'Body text.',
  inScope: ['iOS Safari'],
  outOfScope: ['Android'],
  acceptanceCriteria: [{ given: 'a device with Apple Pay', when: 'the user checks out', then: 'the sheet appears' }],
  dependsOn: [],
  sizing: 'M',
  openQuestions: ['Which PSP?'],
  sourceEvidence: ['reduce checkout friction']
};

const epicMd = m.epicToMarkdown(epic);
check('epic markdown: has outcome', epicMd.includes('Faster'.length ? 'Outcome:' : ''));
check('epic markdown: has AC section', epicMd.includes('## Acceptance criteria'));
check('epic markdown: has out of scope', epicMd.includes('## Out of scope'));
check('epic markdown: converts cleanly to ADF', m.markdownToAdf(epicMd).content.length > 5);

check('stamp label is JQL-safe', /^[A-Za-z0-9_-]+$/.test(m.stampLabel('12345', 'apple-pay')));
check('stamp label is stable', m.stampLabel('12345', 'apple-pay') === m.stampLabel('12345', 'apple-pay'));
check(
  'fingerprint changes when content changes',
  m.epicFingerprint(epic) !== m.epicFingerprint({ ...epic, title: 'Different' })
);
check('fingerprint is stable across identical objects', m.epicFingerprint(epic) === m.epicFingerprint({ ...epic }));

const backlog = {
  version: 1,
  source: { kind: 'confluence', pageId: '1', title: 'T', url: 'u', ingestedAt: 'now' },
  target: { projectKey: 'ACME', epicIssueType: 'Epic', storyIssueType: 'Story' },
  prd: { title: 'T', summary: 's', goals: [], nonGoals: [], personas: [], constraints: [], openQuestions: [], risks: [] },
  epics: [{ ...epic, sync: {}, stories: [] }]
};

const yaml = m.serializeBacklog(backlog);
const back = m.deserializeBacklog(yaml);
check('backlog round trips through yaml', back.epics[0].ref === 'apple-pay' && back.target.projectKey === 'ACME');
check('backlog yaml carries the editing header', yaml.startsWith('# ReqForge backlog'));

let versionRejected = false;
try {
  m.deserializeBacklog('version: 99\n');
} catch {
  versionRejected = true;
}
check('backlog rejects an unknown schema version', versionRejected);

/* ------------------------------------------- hand-edited files must survive */

// Regression: a hand-edited backlog that omits optional lists used to load as
// undefined and then throw "Cannot read properties of undefined (reading
// 'length')" from inside epicToMarkdown, at push time.
const handEdited = `
version: 1
source: {kind: confluence, pageId: "1", title: T, url: u, ingestedAt: now}
target: {projectKey: ACME}
prd: {title: T, summary: s}
epics:
  - ref: minimal
    title: An epic with every optional field removed
    outcome: Something useful happens
    description: Body.
    stories:
      - ref: minimal-story
        epicRef: minimal
        title: A story with no optional fields
        narrative: {asA: user, iWant: a thing, soThat: a benefit}
        acceptanceCriteria:
          - {given: g, when: w, then: t}
`;

let loaded;
try {
  loaded = m.deserializeBacklog(handEdited);
  check('hand-edited backlog loads', true);
} catch (err) {
  check('hand-edited backlog loads', false, err.message);
}

if (loaded) {
  const e = loaded.epics[0];
  check('missing lists default to []', Array.isArray(e.inScope) && Array.isArray(e.acceptanceCriteria));
  check('missing sync defaults to {}', e.sync && typeof e.sync === 'object' && !e.sync.jiraKey);
  check('missing issue types default', loaded.target.epicIssueType === 'Epic' && loaded.target.storyIssueType === 'Story');
  check('missing prd lists default to []', Array.isArray(loaded.prd.goals) && Array.isArray(loaded.prd.openQuestions));
  try {
    const rendered = m.epicToMarkdown(e);
    check('minimal epic renders without throwing', rendered.includes('Something useful happens'));
    check('minimal epic renders to valid ADF', m.markdownToAdf(rendered).content.length > 0);
  } catch (err) {
    check('minimal epic renders without throwing', false, err.message);
  }
}

// A genuinely broken file must say which field is wrong, not throw a TypeError.
let msg = '';
try {
  m.deserializeBacklog('version: 1\nsource: {kind: confluence, pageId: "1", title: T, url: u, ingestedAt: n}\ntarget: {projectKey: A}\nprd: {title: T, summary: s}\nepics: [{ref: "Bad Ref!", title: x, outcome: y, description: z}]\n');
} catch (err) {
  msg = err.message;
}
check('invalid field is reported with its path', msg.includes('epics.0.ref'), msg);

/* ------------------------------------------------------------------ rubric */

const goodStory = {
  ref: 'good-story',
  epicRef: 'good',
  title: 'Show saved cards at checkout',
  narrative: {
    asA: 'returning shopper',
    iWant: 'to see the cards I have saved',
    soThat: 'I can complete payment without finding my wallet'
  },
  description:
    'Render the saved-card list on the checkout page above the new-card form. Cards come from the ' +
    'payment provider tokens already held against the account; nothing new is stored here. Reviewers ' +
    'should check the ordering, the masked display, and what is shown when the provider is unreachable.',
  priority: 'Must',
  acceptanceCriteria: [
    { given: 'a shopper with two saved cards', when: 'the checkout page loads', then: 'both cards are listed, most recently used first' },
    { given: 'a shopper with no saved cards', when: 'the checkout page loads', then: 'the new-card form is shown with no empty list' },
    { given: 'the payment provider is unavailable', when: 'the checkout page loads', then: 'an error is shown and the new-card form still works' }
  ],
  outOfScope: ['Editing or deleting a saved card, which belongs to the account settings story'],
  technicalNotes: ['Reads tokens from the payment provider; no card data is stored by us'],
  assumptions: ['Card tokens are already stored by the payment provider'],
  dependsOn: [],
  points: 3,
  openQuestions: [],
  sync: {}
};

const goodEpic = {
  ref: 'good',
  title: 'Saved cards at checkout',
  outcome: 'Returning shoppers pay without re-entering card details',
  description: 'Body.',
  priority: 'Must',
  inScope: ['iOS Safari'],
  outOfScope: ['Android'],
  successMeasures: ['Checkout abandonment down 15% within 2 quarters'],
  acceptanceCriteria: [{ given: 'a saved card', when: 'the shopper checks out', then: 'no re-entry is required' }],
  nonFunctional: ['Checkout interactive within 2s at the 95th percentile'],
  assumptions: ['The payment provider already tokenises cards'],
  dependsOn: [],
  sizing: 'M',
  openQuestions: [],
  sourceEvidence: ['reduce checkout friction'],
  sync: {},
  stories: [goodStory]
};

const backlogOf = (epics) => ({
  version: 1,
  source: { kind: 'confluence', pageId: '1', title: 'T', url: 'u', ingestedAt: 'now' },
  target: { projectKey: 'ACME', epicIssueType: 'Epic', storyIssueType: 'Story' },
  prd: { title: 'T', summary: 's', goals: [], nonGoals: [], personas: [], constraints: [], openQuestions: [], risks: [] },
  epics
});

const findingsFor = (backlog, ref) => {
  const q = m.evaluateBacklog(backlog, m.DEFAULT_RUBRIC);
  const item = q.items.find((i) => i.ref === ref);
  return [...item.blockedBy, ...item.warnings].map((f) => f.ruleId);
};

check('rubric: a clean epic produces no blockers or warnings', (() => {
  const ids = findingsFor(backlogOf([goodEpic]), 'good');
  return ids.length === 0;
})(), JSON.stringify(findingsFor(backlogOf([goodEpic]), 'good')));

check('rubric: a clean story produces no blockers or warnings',
  findingsFor(backlogOf([goodEpic]), 'good-story').length === 0,
  JSON.stringify(findingsFor(backlogOf([goodEpic]), 'good-story')));

// Each of these must fire, or the rule is dead code.
const epicCases = [
  ['has-outcome', { ...goodEpic, outcome: '  ' }],
  ['has-acceptance-criteria', { ...goodEpic, acceptanceCriteria: [] }],
  ['complete-acceptance-criteria', { ...goodEpic, acceptanceCriteria: [{ given: 'x', when: '', then: 'y' }] }],
  ['dependencies-resolve', { ...goodEpic, dependsOn: ['nope'] }],
  ['no-self-dependency', { ...goodEpic, dependsOn: ['good'] }],
  ['has-evidence', { ...goodEpic, sourceEvidence: [] }],
  ['has-out-of-scope', { ...goodEpic, outOfScope: [] }],
  ['sizing-xl', { ...goodEpic, sizing: 'XL' }],
  ['no-stories', { ...goodEpic, stories: [] }],
  ['layer-shaped', { ...goodEpic, title: 'The payments API' }],
  ['vague-acceptance-criteria', { ...goodEpic, acceptanceCriteria: [{ given: 'a card', when: 'it is used', then: 'it works properly' }] }],
  ['too-many-stories', { ...goodEpic, stories: Array.from({ length: 13 }, (_, i) => ({ ...goodStory, ref: `s${i}` })) }]
];

for (const [ruleId, epic] of epicCases) {
  const ids = findingsFor(backlogOf([epic]), 'good');
  check(`rubric rule fires: ${ruleId}`, ids.includes(ruleId), `got: ${ids.join(', ') || '(none)'}`);
}

const storyCases = [
  ['has-narrative', { ...goodStory, narrative: { ...goodStory.narrative, soThat: '' } }],
  ['has-acceptance-criteria', { ...goodStory, acceptanceCriteria: [] }],
  ['generic-persona', { ...goodStory, narrative: { ...goodStory.narrative, asA: 'user' } }],
  ['too-large', { ...goodStory, points: 13 }],
  ['vague-acceptance-criteria', { ...goodStory, acceptanceCriteria: [{ given: 'a', when: 'b', then: 'it is user-friendly' }] }],
  ['benefit-restates-want', { ...goodStory, narrative: { asA: 'shopper', iWant: 'to see saved cards listed', soThat: 'saved cards are listed' } }]
];

for (const [ruleId, story] of storyCases) {
  const ids = findingsFor(backlogOf([{ ...goodEpic, stories: [story] }]), 'good-story');
  check(`rubric rule fires: ${ruleId} (story)`, ids.includes(ruleId), `got: ${ids.join(', ') || '(none)'}`);
}

/* scoring and gating */

const allThrees = m.STORY_CRITERIA.map((c) => ({ id: c.id, rating: 3, justification: 'x', suggestion: '' }));
const allZeros = m.STORY_CRITERIA.map((c) => ({ id: c.id, rating: 0, justification: 'x', suggestion: '' }));

check('score: all 3s is 100', m.scoreCriteria('story', allThrees, m.DEFAULT_RUBRIC) === 100);
check('score: all 0s is 0', m.scoreCriteria('story', allZeros, m.DEFAULT_RUBRIC) === 0);
check(
  'score: disabling a criterion does not cap the maximum',
  m.scoreCriteria('story', allThrees.filter((c) => c.id !== 'invest-testable'), {
    ...m.DEFAULT_RUBRIC,
    weights: { 'invest-testable': 0 }
  }) === 100
);
check(
  'score: unassessed criteria are excluded, not counted as zero',
  m.scoreCriteria('story', allThrees.slice(0, 2), m.DEFAULT_RUBRIC) === 100
);
check(
  'score: weighting Testable higher lowers the score when only Testable is poor',
  m.scoreCriteria('story', m.STORY_CRITERIA.map((c) => ({ id: c.id, rating: c.id === 'invest-testable' ? 0 : 3, justification: 'x', suggestion: '' })), m.DEFAULT_RUBRIC) < 80
);

// The gate: a blocker must fail an item no matter how well it scores.
const blocked = backlogOf([{ ...goodEpic, acceptanceCriteria: [] }]);
const cached = new Map([[m.cacheKey('epic', 'good', m.epicFingerprint({ ...goodEpic, acceptanceCriteria: [] })), m.EPIC_CRITERIA.map((c) => ({ id: c.id, rating: 3, justification: 'x', suggestion: '' }))]]);
const blockedQ = m.evaluateBacklog(blocked, m.DEFAULT_RUBRIC, cached);
const blockedItem = blockedQ.items.find((i) => i.ref === 'good');
check('gate: a perfect score still fails when a blocker fired', blockedItem.score === 100 && blockedItem.passed === false);

const cleanCached = new Map([[m.cacheKey('epic', 'good', m.epicFingerprint(goodEpic)), m.EPIC_CRITERIA.map((c) => ({ id: c.id, rating: 3, justification: 'x', suggestion: '' }))]]);
const cleanItem = m.evaluateBacklog(backlogOf([goodEpic]), m.DEFAULT_RUBRIC, cleanCached).items.find((i) => i.ref === 'good');
check('gate: a clean item at 100 passes', cleanItem.passed === true);

const lowCached = new Map([[m.cacheKey('epic', 'good', m.epicFingerprint(goodEpic)), m.EPIC_CRITERIA.map((c) => ({ id: c.id, rating: 1, justification: 'x', suggestion: '' }))]]);
const lowItem = m.evaluateBacklog(backlogOf([goodEpic]), m.DEFAULT_RUBRIC, lowCached).items.find((i) => i.ref === 'good');
check('gate: below threshold fails', lowItem.score < 70 && lowItem.passed === false);

// With requireReview on, an item nobody has reviewed must not read as passing.
check('gate: with requireReview, an unassessed item is not treated as passing',
  cleanItem.deterministicOnly === false &&
  m.evaluateBacklog(backlogOf([goodEpic]), { ...m.DEFAULT_RUBRIC, requireReview: true })
    .items.find((i) => i.ref === 'good').passed === false);

// Editing an item must invalidate its cached assessment.
const edited = { ...goodEpic, title: 'A different title' };
const staleItem = m.evaluateBacklog(backlogOf([edited]), m.DEFAULT_RUBRIC, cleanCached).items.find((i) => i.ref === 'good');
check('cache: editing an item invalidates its assessment', staleItem.deterministicOnly === true);

check('fix instruction names the actual problems',
  m.fixInstruction(blockedItem).includes('No acceptance criteria'),
  m.fixInstruction(blockedItem));

/* --------------------------------------------------- overrides and waivers */

const noAc = { ...goodEpic, acceptanceCriteria: [] };
const noAcBacklog = backlogOf([noAc]);
const noAcPrint = m.epicFingerprint(noAc);
const perfectEpic = m.EPIC_CRITERIA.map((c) => ({ id: c.id, rating: 3, justification: 'x', suggestion: '' }));
const poorEpic = m.EPIC_CRITERIA.map((c) => ({ id: c.id, rating: 1, justification: 'x', suggestion: '' }));

// Waiving a blocker clears it from the verdict but keeps it visible.
const waiver = new Map([
  [m.overrideKey('epic', 'good'), { level: 'epic', ref: 'good', waivedRules: ['has-acceptance-criteria'], reasons: { 'has-acceptance-criteria': 'covered by the linked test plan' } }]
]);
const waivedItem = m.evaluateBacklog(noAcBacklog, m.DEFAULT_RUBRIC, new Map([[m.cacheKey('epic', 'good', noAcPrint), perfectEpic]]), waiver).items.find((i) => i.ref === 'good');
check('waiver: a waived blocker no longer blocks', waivedItem.blockedBy.length === 0 && waivedItem.passed === true);
check('waiver: the waived finding stays visible with its reason',
  waivedItem.waived.length === 1 && waivedItem.waived[0].reason.includes('test plan'));

// Without the waiver the same item must still fail.
const unwaivedItem = m.evaluateBacklog(noAcBacklog, m.DEFAULT_RUBRIC, new Map([[m.cacheKey('epic', 'good', noAcPrint), perfectEpic]])).items.find((i) => i.ref === 'good');
check('waiver: removing it restores the blocker', unwaivedItem.blockedBy.length === 1 && unwaivedItem.passed === false);

// Accepting below threshold passes the item but records why.
const accept = new Map([
  [m.overrideKey('epic', 'good'), { level: 'epic', ref: 'good', waivedRules: [], reasons: {}, acceptedBelowThreshold: { reason: 'spike, detail follows', at: 'now' } }]
]);
const acceptedItem = m.evaluateBacklog(backlogOf([goodEpic]), m.DEFAULT_RUBRIC, new Map([[m.cacheKey('epic', 'good', m.epicFingerprint(goodEpic)), poorEpic]]), accept).items.find((i) => i.ref === 'good');
check('accept: a low score passes once accepted', acceptedItem.score === 33 && acceptedItem.passed === true);
check('accept: the reason is retained', acceptedItem.acceptedBelowThreshold.reason.includes('spike'));

// Acceptance must NOT buy off a blocker — that would make the gate meaningless.
const acceptWithBlocker = m.evaluateBacklog(noAcBacklog, m.DEFAULT_RUBRIC, new Map([[m.cacheKey('epic', 'good', noAcPrint), perfectEpic]]), accept).items.find((i) => i.ref === 'good');
check('accept: cannot override a blocker', acceptWithBlocker.blockedBy.length === 1 && acceptWithBlocker.passed === false);

// requireReview controls whether unreviewed items block.
const strict = m.evaluateBacklog(backlogOf([goodEpic]), { ...m.DEFAULT_RUBRIC, requireReview: true }).items.find((i) => i.ref === 'good');
const relaxed = m.evaluateBacklog(backlogOf([goodEpic]), { ...m.DEFAULT_RUBRIC, requireReview: false }).items.find((i) => i.ref === 'good');
check('requireReview true: an unreviewed item fails', strict.passed === false && strict.deterministicOnly === true);
check('requireReview false: an unreviewed clean item passes', relaxed.passed === true && relaxed.deterministicOnly === true);
check('requireReview false: an unreviewed item with a blocker still fails',
  m.evaluateBacklog(noAcBacklog, { ...m.DEFAULT_RUBRIC, requireReview: false }).items.find((i) => i.ref === 'good').passed === false);

/* ------------------------------------------------------- labels and notes */

const mk = (over) => ({ level: 'story', ref: 'r', title: 't', score: 60, threshold: 70, passed: false,
  blockedBy: [], warnings: [], criteria: [], assessedHash: 'h', assessedAt: 'now', deterministicOnly: false, waived: [], ...over });

const weak = m.STORY_CRITERIA.map((c, i) => ({ id: c.id, rating: i < 2 ? 0 : 3, justification: 'x', suggestion: 'y' }));
const below = mk({ score: 55, criteria: weak });
const okItem = mk({ score: 90, passed: true, criteria: m.STORY_CRITERIA.map((c) => ({ id: c.id, rating: 3, justification: 'x', suggestion: '' })) });
const unreviewed = mk({ score: 0, deterministicOnly: true, criteria: [] });

const belowLabels = m.qualityLabels(below);
check('labels: below threshold is tagged', belowLabels.includes('reqforge-quality-below-threshold'), belowLabels.join(','));
check('labels: the weakest criteria are named', belowLabels.some((l) => l.startsWith('reqforge-needs-')), belowLabels.join(','));
check('labels: criterion labels are capped at 3', belowLabels.filter((l) => l.startsWith('reqforge-needs-')).length <= 3);
check('labels: a passing item is tagged ok', m.qualityLabels(okItem).includes('reqforge-quality-ok'));
check('labels: an unreviewed item is tagged not-reviewed',
  m.qualityLabels(unreviewed).join(',') === 'reqforge-not-reviewed');
check('labels: every label is valid for Jira (no whitespace)',
  [...m.qualityLabelVocabulary(), ...belowLabels].every((l) => /^[a-z0-9-]+$/.test(l)));
check('labels: stale set excludes the current ones',
  m.staleQualityLabels(below).every((l) => !belowLabels.includes(l)) &&
  m.staleQualityLabels(below).includes('reqforge-quality-ok'));

const note = m.qualityNote(below);
check('note: states the score and threshold', note.includes('55/100') && note.includes('70'), note);
check('note: names the weakest criteria', /Weakest:/.test(note), note);
check('note: a passing item gets a one-liner', m.qualityNote(okItem).includes('90/100'));
check('note: an unreviewed item says so', m.qualityNote(unreviewed).includes('not reviewed'));
check('note: renders to valid ADF', m.markdownToAdf(note).content.length > 0);

const accepted = mk({ score: 40, passed: true, acceptedBelowThreshold: { reason: 'spike', at: 'now' }, criteria: weak });
check('labels: an accepted item is tagged accepted', m.qualityLabels(accepted).includes('reqforge-quality-accepted'));
check('note: an accepted item records the reason', m.qualityNote(accepted).includes('spike'));

/* enforcement defaults */
check('default enforcement is label, not block', m.DEFAULT_RUBRIC.enforcement === 'label');
check('default does not require a review to push', m.DEFAULT_RUBRIC.requireReview === false);
check('an unreviewed clean item passes under the defaults',
  m.evaluateBacklog(backlogOf([goodEpic]), m.DEFAULT_RUBRIC).items.find((i) => i.ref === 'good').passed === true);
check('a structurally broken item still fails under the defaults',
  m.evaluateBacklog(backlogOf([{ ...goodEpic, acceptanceCriteria: [] }]), m.DEFAULT_RUBRIC).items.find((i) => i.ref === 'good').blockedBy.length === 1);

check('rubric exposes every rule id for config', m.RULE_IDS.length >= 18 && m.RULE_IDS.includes('generic-persona'));
check('INVEST is complete and correctly named',
  ['Independent','Negotiable','Valuable','Estimable','Small','Testable'].every((n) => m.STORY_CRITERIA.some((c) => c.name === n)));

/* ----------------------------------------- reading an issue back into shape */

{
  // The round trip is the contract: anything we render into a Jira description
  // must come back as the same structure, or "edit an existing epic" silently
  // loses fields the moment somebody saves.
  const rendered = m.epicToMarkdown(goodEpic);
  const back = m.parseEpicMarkdown('KAN-95', goodEpic.title, rendered);

  check('round trip epic: title', back.title === goodEpic.title);
  check('round trip epic: outcome', back.outcome === goodEpic.outcome, back.outcome);
  check('round trip epic: description', back.description === goodEpic.description, back.description);
  check('round trip epic: in scope', back.inScope.join('|') === goodEpic.inScope.join('|'), back.inScope.join('|'));
  check('round trip epic: out of scope', back.outOfScope.join('|') === goodEpic.outOfScope.join('|'));
  check('round trip epic: acceptance criteria',
    JSON.stringify(back.acceptanceCriteria) === JSON.stringify(goodEpic.acceptanceCriteria),
    JSON.stringify(back.acceptanceCriteria));
  check('round trip epic: sizing', back.sizing === goodEpic.sizing);
  check('round trip epic: ref comes from the issue key', back.ref === 'kan-95');

  const richEpic = { ...goodEpic, openQuestions: ['Who owns it?'], dependsOn: ['other-epic'], sizing: 'XL' };
  const richBack = m.parseEpicMarkdown('KAN-1', richEpic.title, m.epicToMarkdown(richEpic));
  check('round trip epic: open questions', richBack.openQuestions.join('|') === 'Who owns it?');
  check('round trip epic: dependsOn', richBack.dependsOn.join('|') === 'other-epic');
  check('round trip epic: XL sizing survives', richBack.sizing === 'XL');

  const st = m.parseStoryMarkdown('KAN-96', goodStory.title, m.storyToMarkdown(goodStory), 'kan-95');
  check('round trip story: narrative asA', st.narrative.asA === goodStory.narrative.asA, st.narrative.asA);
  check('round trip story: narrative iWant', st.narrative.iWant === goodStory.narrative.iWant);
  check('round trip story: narrative soThat', st.narrative.soThat === goodStory.narrative.soThat);
  check('round trip story: acceptance criteria',
    JSON.stringify(st.acceptanceCriteria) === JSON.stringify(goodStory.acceptanceCriteria));
  check('round trip story: points', st.points === goodStory.points);
  check('round trip story: parent ref', st.epicRef === 'kan-95');

  // A quality note we appended on a previous push must not leak into the body.
  const withNote = m.epicToMarkdown(goodEpic) + '\n\n_Quality: 55/100, below the threshold of 70._';
  const noNote = m.parseEpicMarkdown('KAN-95', goodEpic.title, withNote);
  check('round trip: a previously appended quality note is stripped',
    !noNote.description.includes('Quality:') && !JSON.stringify(noNote).includes('55/100'));

  // An issue nobody generated: no structure, but it must still load.
  const handWritten = m.parseEpicMarkdown('KAN-7', 'Some epic', 'We need to sort out the payments thing.\nTalk to Dave.');
  check('hand-written issue: body lands in description', handWritten.description.includes('payments thing'));
  check('hand-written issue: no invented outcome', handWritten.outcome === '');
  check('hand-written issue: no invented criteria', handWritten.acceptanceCriteria.length === 0);

  const handStory = m.parseStoryMarkdown('KAN-8', 'A story', 'Just some prose.', 'kan-7');
  check('hand-written story: gets a placeholder criterion so it can load', handStory.acceptanceCriteria.length === 1);
  check('hand-written story: defaults to 3 points', handStory.points === 3);

  // Non-Gherkin bullets under Acceptance criteria are somebody's work — keep them.
  const loose = m.parseEpicMarkdown('KAN-9', 'x', '## Acceptance criteria\n- It must be fast\n- It must log');
  check('loose criteria are kept rather than dropped', loose.acceptanceCriteria.length === 2 &&
    loose.acceptanceCriteria[0].then === 'It must be fast');
}

/* ------------------------------- the round trip that actually happens in Jira */

{
  // The earlier round-trip tests parse the markdown we rendered. Real data goes
  // markdown -> ADF -> Jira -> ADF -> markdown, and that is where a story's
  // three-line narrative was being collapsed into one line, leaving iWant and
  // soThat empty and the backlog file unloadable.
  const viaJira = (md) => m.adfToMarkdown(m.markdownToAdf(md));

  const st = m.parseStoryMarkdown('K-1', goodStory.title, viaJira(m.storyToMarkdown(goodStory)), 'e');
  check('via ADF: narrative asA survives', st.narrative.asA === goodStory.narrative.asA, st.narrative.asA);
  check('via ADF: narrative iWant survives', st.narrative.iWant === goodStory.narrative.iWant, st.narrative.iWant);
  check('via ADF: narrative soThat survives', st.narrative.soThat === goodStory.narrative.soThat, st.narrative.soThat);
  check('via ADF: acceptance criteria survive',
    JSON.stringify(st.acceptanceCriteria) === JSON.stringify(goodStory.acceptanceCriteria));
  check('via ADF: points survive', st.points === goodStory.points);

  const ep = m.parseEpicMarkdown('K-2', goodEpic.title, viaJira(m.epicToMarkdown(goodEpic)));
  check('via ADF: epic outcome survives', ep.outcome === goodEpic.outcome, ep.outcome);
  check('via ADF: epic in scope survives', ep.inScope.join('|') === goodEpic.inScope.join('|'));
  check('via ADF: epic criteria survive',
    JSON.stringify(ep.acceptanceCriteria) === JSON.stringify(goodEpic.acceptanceCriteria));

  // Even if a renderer somewhere does collapse it, the parser must cope.
  const collapsed = m.parseStoryMarkdown('K-3', 'T',
    '**As a** shopper **I want** to pay **So that** I am done\n\n## Acceptance criteria\n- **Given** a **when** b **then** c', 'e');
  check('collapsed narrative: asA does not swallow the rest', collapsed.narrative.asA === 'shopper', collapsed.narrative.asA);
  check('collapsed narrative: iWant is recovered', collapsed.narrative.iWant === 'to pay');
  check('collapsed narrative: soThat is recovered', collapsed.narrative.soThat === 'I am done');

  // A story with no narrative at all must still load; the rubric flags it.
  const empty = m.deserializeBacklog(m.serializeBacklog(backlogOf([{ ...goodEpic,
    stories: [{ ...goodStory, narrative: { asA: '', iWant: '', soThat: '' } }] }])));
  check('a story with no narrative still loads', empty.epics[0].stories.length === 1);
  const q = m.evaluateBacklog(empty, m.DEFAULT_RUBRIC).items.find((i) => i.ref === goodStory.ref);
  check('a story with no narrative is blocked by the rubric instead',
    q.blockedBy.some((b) => b.ruleId === 'has-narrative'), JSON.stringify(q.blockedBy));
}

/* -------------------------------------------------- the fields added later */

{
  // Every added field has to survive the full path: rendered into Jira, read
  // back out through ADF, and parsed. A field that renders but does not parse
  // is silently lost the first time somebody imports the issue.
  const viaJira = (md) => m.adfToMarkdown(m.markdownToAdf(md));

  const ep = m.parseEpicMarkdown('K-1', goodEpic.title, viaJira(m.epicToMarkdown(goodEpic)));
  check('epic priority survives the round trip', ep.priority === 'Must', ep.priority);
  check('epic success measures survive', ep.successMeasures.join('|') === goodEpic.successMeasures.join('|'), ep.successMeasures.join('|'));
  check('epic non-functional requirements survive', ep.nonFunctional.join('|') === goodEpic.nonFunctional.join('|'), ep.nonFunctional.join('|'));
  check('epic assumptions survive', ep.assumptions.join('|') === goodEpic.assumptions.join('|'), ep.assumptions.join('|'));
  check('epic outcome still survives alongside priority', ep.outcome === goodEpic.outcome, ep.outcome);

  const st = m.parseStoryMarkdown('K-2', goodStory.title, viaJira(m.storyToMarkdown(goodStory)), 'e');
  check('story priority survives the round trip', st.priority === 'Must', st.priority);
  check('story assumptions survive', st.assumptions.join('|') === goodStory.assumptions.join('|'), st.assumptions.join('|'));
  check('story narrative still survives alongside priority', st.narrative.soThat === goodStory.narrative.soThat, st.narrative.soThat);

  const withDeps = { ...goodStory, dependsOn: ['other-story', 'another-story'] };
  const depBack = m.parseStoryMarkdown('K-3', withDeps.title, viaJira(m.storyToMarkdown(withDeps)), 'e');
  check('story dependencies survive', depBack.dependsOn.join('|') === 'other-story|another-story', depBack.dependsOn.join('|'));

  // Links must survive rendering into Jira and being read back.
  const withLinks = {
    ...goodEpic,
    links: [
      { type: 'design', label: 'Checkout flow', url: 'https://www.figma.com/file/abc/checkout' },
      { type: 'spec', label: 'Tokenisation spec', url: 'https://example.com/spec' }
    ]
  };
  const linkBack = m.parseEpicMarkdown('K-9', withLinks.title, viaJira(m.epicToMarkdown(withLinks)));
  check('links survive the round trip', linkBack.links.length === 2, JSON.stringify(linkBack.links));
  check('link type survives', linkBack.links[0].type === 'design', linkBack.links[0]?.type);
  check('link label survives', linkBack.links[0].label === 'Checkout flow', linkBack.links[0]?.label);
  check('link url survives', linkBack.links[0].url === 'https://www.figma.com/file/abc/checkout', linkBack.links[0]?.url);

  const storyLinks = { ...goodStory, links: [{ type: 'design', label: 'Frame 12', url: 'https://www.figma.com/file/x' }] };
  const storyBack = m.parseStoryMarkdown('K-10', storyLinks.title, viaJira(m.storyToMarkdown(storyLinks)), 'e');
  check('story links survive the round trip', storyBack.links.length === 1 && storyBack.links[0].label === 'Frame 12',
    JSON.stringify(storyBack.links));

  // A bare markdown link under the heading is somebody's work; keep it.
  const bare = m.parseEpicMarkdown('K-11', 'x', '## Links\n- [Some doc](https://example.com/doc)');
  check('a bare link under the heading is kept', bare.links.length === 1 && bare.links[0].type === 'reference');

  check('a non-https link is reported',
    m.evaluateBacklog(backlogOf([{ ...goodEpic, links: [{ type: 'design', label: 'x', url: 'http://insecure' }] }]), m.DEFAULT_RUBRIC)
      .items.find((i) => i.ref === 'good').warnings.some((f) => f.ruleId === 'insecure-link'));
  check('an https link is not reported',
    m.evaluateBacklog(backlogOf([withLinks]), m.DEFAULT_RUBRIC)
      .items.find((i) => i.ref === 'good').warnings.every((f) => f.ruleId !== 'insecure-link'));
  check('changing a link changes the fingerprint',
    m.epicFingerprint(goodEpic) !== m.epicFingerprint(withLinks));

  // Editing a new field must count as something worth sending.
  check('changing priority changes the epic fingerprint',
    m.epicFingerprint(goodEpic) !== m.epicFingerprint({ ...goodEpic, priority: 'Could' }));
  check('changing success measures changes the epic fingerprint',
    m.epicFingerprint(goodEpic) !== m.epicFingerprint({ ...goodEpic, successMeasures: ['something else'] }));

  // Missing or unmeasurable measures are reported.
  const noMeasures = m.evaluateBacklog(backlogOf([{ ...goodEpic, successMeasures: [] }]), m.DEFAULT_RUBRIC)
    .items.find((i) => i.ref === 'good');
  check('missing success measures warns', noMeasures.warnings.some((f) => f.ruleId === 'has-success-measures'));

  const vagueMeasures = m.evaluateBacklog(backlogOf([{ ...goodEpic, successMeasures: ['users are happier'] }]), m.DEFAULT_RUBRIC)
    .items.find((i) => i.ref === 'good');
  check('a success measure with no number is reported',
    vagueMeasures.warnings.some((f) => f.ruleId === 'unmeasurable-success'));
  check('a measure with a number is accepted',
    m.evaluateBacklog(backlogOf([goodEpic]), m.DEFAULT_RUBRIC).items.find((i) => i.ref === 'good')
      .warnings.every((f) => f.ruleId !== 'unmeasurable-success'));

  const chained = { ...goodStory, dependsOn: ['a', 'b', 'c'] };
  const chainQ = m.evaluateBacklog(backlogOf([{ ...goodEpic, stories: [chained] }]), m.DEFAULT_RUBRIC)
    .items.find((i) => i.ref === goodStory.ref);
  check('a long story dependency chain is reported',
    chainQ.warnings.some((f) => f.ruleId === 'story-dependency-chain'));

  // Defaults must fill in for a file written before these fields existed.
  const legacy = m.deserializeBacklog(`
version: 1
source: {kind: confluence, pageId: "1", title: T, url: u, ingestedAt: now}
target: {projectKey: ACME}
prd: {title: T, summary: s}
epics:
  - ref: old
    title: An epic from before these fields existed
    outcome: Something
    description: Body.
    acceptanceCriteria: [{given: g, when: w, then: t}]
    stories:
      - ref: old-story
        epicRef: old
        title: A story from before
        narrative: {asA: a, iWant: b, soThat: c}
        acceptanceCriteria: [{given: g, when: w, then: t}]
`);
  check('an older backlog file still loads', legacy.epics.length === 1);
  check('priority defaults on an older epic', legacy.epics[0].priority === 'Should');
  check('new epic lists default to empty', Array.isArray(legacy.epics[0].successMeasures) && legacy.epics[0].successMeasures.length === 0);
  check('priority defaults on an older story', legacy.epics[0].stories[0].priority === 'Should');
  check('an older backlog renders without throwing', m.epicToMarkdown(legacy.epics[0]).includes('Priority:'));
}

/* --------------------------------------------------- stories with substance */

{
  const thin = { ...goodStory, description: 'Show the cards.' };
  const thinQ = m.evaluateBacklog(backlogOf([{ ...goodEpic, stories: [thin] }]), m.DEFAULT_RUBRIC)
    .items.find((i) => i.ref === goodStory.ref);
  check('a one-line description is reported', thinQ.warnings.some((f) => f.ruleId === 'thin-description'));

  const oneCriterion = { ...goodStory, acceptanceCriteria: [goodStory.acceptanceCriteria[0]] };
  const oneQ = m.evaluateBacklog(backlogOf([{ ...goodEpic, stories: [oneCriterion] }]), m.DEFAULT_RUBRIC)
    .items.find((i) => i.ref === goodStory.ref);
  check('a single acceptance criterion is reported', oneQ.warnings.some((f) => f.ruleId === 'too-few-criteria'));

  const happyOnly = {
    ...goodStory,
    acceptanceCriteria: [
      { given: 'a shopper', when: 'they open checkout', then: 'the page loads' },
      { given: 'a shopper', when: 'they pick a card', then: 'it is selected' },
      { given: 'a shopper', when: 'they confirm', then: 'the order is placed' }
    ]
  };
  const happyQ = m.evaluateBacklog(backlogOf([{ ...goodEpic, stories: [happyOnly] }]), m.DEFAULT_RUBRIC)
    .items.find((i) => i.ref === goodStory.ref);
  check('criteria that are all happy path are reported',
    happyQ.warnings.some((f) => f.ruleId === 'happy-path-only'), JSON.stringify(happyQ.warnings.map(w=>w.ruleId)));
  check('a story covering failure and empty states is not reported',
    m.evaluateBacklog(backlogOf([goodEpic]), m.DEFAULT_RUBRIC).items.find((i) => i.ref === goodStory.ref)
      .warnings.every((f) => !['thin-description', 'too-few-criteria', 'happy-path-only'].includes(f.ruleId)));

  // The new fields have to survive the whole path like every other one.
  const viaJira2 = (md) => m.adfToMarkdown(m.markdownToAdf(md));
  const back = m.parseStoryMarkdown('K-20', goodStory.title, viaJira2(m.storyToMarkdown(goodStory)), 'e');
  check('story out of scope survives', back.outOfScope.join('|') === goodStory.outOfScope.join('|'), back.outOfScope.join('|'));
  check('story technical notes survive', back.technicalNotes.join('|') === goodStory.technicalNotes.join('|'), back.technicalNotes.join('|'));
  check('story description survives', back.description === goodStory.description, back.description?.slice(0, 60));
  check('all three criteria survive', back.acceptanceCriteria.length === 3);
  check('changing technical notes changes the fingerprint',
    m.storyFingerprint(goodStory) !== m.storyFingerprint({ ...goodStory, technicalNotes: ['different'] }));
}

/* ------------------------------------------------- the goal-seeking loop */

/**
 * A scripted model. `ratingFor` decides what each assessment returns, so a test
 * can make the loop succeed, stall, or run forever — and forever is the one the
 * bounds exist for.
 */
function fakeLlm(ratingFor) {
  let round = 0;
  let calls = 0;
  const api = {
    kind: 'fixture',
    async probe() { return { ok: true, detail: '' }; },
    async contextWindow() { return 100000; },
    async countTokens(t) { return Math.ceil(t.length / 4); },
    async requestStructured(req) {
      calls++;
      if (req.toolName === 'emit_quality_assessment') {
        round++;
        const level = req.inputSchema.properties.assessments.items.properties.criteria.items.properties.id.enum[0].startsWith('epic-')
          ? 'epic' : 'story';
        const defs = level === 'epic' ? m.EPIC_CRITERIA : m.STORY_CRITERIA;
        // One assessment per item mentioned in the prompt.
        const refs = [...req.messages[0].content.matchAll(/<item ref="([^"]+)">/g)].map((x) => x[1]);
        const payload = {
          assessments: refs.map((ref) => ({
            ref,
            criteria: defs.map((c) => ({
              id: c.id,
              rating: ratingFor(round, ref),
              justification: 'because',
              suggestion: 'do better'
            }))
          }))
        };
        const parsed = req.parse(payload);
        if (!parsed.ok) throw new Error('fake assessment rejected: ' + parsed.error);
        return parsed.value;
      }
      // A rewrite: return the item essentially unchanged but with a new title,
      // which is enough for the loop to see it as changed.
      const base = req.toolName === 'emit_epic'
        ? { ...goodEpic, title: `${goodEpic.title} (v${calls})` }
        : { ...goodStory, title: `${goodStory.title} (v${calls})` };
      const parsed = req.parse(base);
      if (!parsed.ok) throw new Error('fake rewrite rejected: ' + parsed.error);
      return parsed.value;
    },
    get calls() { return calls; }
  };
  return api;
}

{
  const cfg = { ...m.DEFAULT_RUBRIC, threshold: 70 };

  // Improves on the second assessment: the loop should stop as soon as it passes.
  const improving = fakeLlm((round) => (round <= 1 ? 1 : 3));
  const b1 = backlogOf([{ ...goodEpic, stories: [] }]);
  const r1 = await m.improveBacklog(improving, b1, cfg, new Map(), { maxIterations: 3, maxRequests: 40 });
  check('improve: stops once the goal is met', r1.stoppedBecause === 'goal-met', r1.stoppedBecause);
  check('improve: reports the score moving', r1.scoreAfter > r1.scoreBefore, `${r1.scoreBefore} -> ${r1.scoreAfter}`);
  check('improve: reports what it rewrote', r1.steps.length >= 1 && r1.steps[0].scoreAfter > r1.steps[0].scoreBefore);
  check('improve: counts its own requests', r1.requests > 0);

  // Never improves: it must notice rather than spend the whole budget.
  const stuck = fakeLlm(() => 1);
  const b2 = backlogOf([{ ...goodEpic, stories: [] }]);
  const r2 = await m.improveBacklog(stuck, b2, cfg, new Map(), { maxIterations: 5, maxRequests: 100 });
  check('improve: stops when a pass changes nothing', r2.stoppedBecause === 'no-progress', r2.stoppedBecause);
  check('improve: gives up early rather than using the whole budget', r2.requests < 20, String(r2.requests));

  // A tight budget must stop it mid-run.
  const budgeted = fakeLlm(() => 1);
  const b3 = backlogOf([{ ...goodEpic, stories: [goodStory] }]);
  const r3 = await m.improveBacklog(budgeted, b3, cfg, new Map(), { maxIterations: 5, maxRequests: 3 });
  check('improve: honours the request budget', r3.requests <= 4, String(r3.requests));
  check('improve: says the budget stopped it',
    ['request-limit', 'no-progress'].includes(r3.stoppedBecause), r3.stoppedBecause);

  // Nothing to do is not a failure.
  const already = fakeLlm(() => 3);
  const b4 = backlogOf([{ ...goodEpic, stories: [] }]);
  const r4 = await m.improveBacklog(already, b4, cfg, new Map(), {});
  check('improve: does nothing when everything already passes',
    r4.stoppedBecause === 'nothing-to-do' && r4.steps.length === 0, r4.stoppedBecause);

  // Cancellation keeps what it already did.
  const cancelling = fakeLlm(() => 1);
  const b5 = backlogOf([{ ...goodEpic, stories: [] }]);
  const r5 = await m.improveBacklog(cancelling, b5, cfg, new Map(), {
    token: { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) }
  });
  check('improve: cancellation stops it', r5.stoppedBecause === 'cancelled', r5.stoppedBecause);

  check('improve: every stop reason has an explanation',
    ['goal-met','no-progress','iteration-limit','request-limit','cancelled','nothing-to-do']
      .every((why) => m.describeStop(why, cfg).length > 20));

  // The loop must never reach Jira. planPush is the only route there, and the
  // improve module must not be able to call it.
  const src = readFileSync('src/core/pipeline/improve.ts', 'utf8');
  check('improve: cannot push to Jira',
    !/executePush|planPush|AtlassianPort|createIssue|updateIssue/.test(src));
}

/* ------------------------------------------------------------ terminology */

{
  // Evidence is a claim about what a source document says. A rewrite never sees
  // the source document, so anything it returns for that field is invented —
  // which is how a story's own text ends up quoted as an epic's justification.
  const withEvidence = { ...goodEpic, sourceEvidence: ['"a real quote from the PRD"'] };
  const modelReturned = { ...goodEpic, sourceEvidence: ['"something the model made up"'] };
  const mergedLikeRefine = { ...modelReturned, ref: withEvidence.ref, sourceEvidence: withEvidence.sourceEvidence };
  check('refine keeps the original evidence rather than the model\'s',
    mergedLikeRefine.sourceEvidence[0].includes('real quote'));

  // An epic is not always from a PRD; it may be imported or added by hand.
  check('epic footer does not claim a source PRD', !m.epicToMarkdown(goodEpic).includes('source PRD'),
    m.epicToMarkdown(goodEpic).split('\n').pop());
  check('epic footer still records sizing', m.epicToMarkdown(goodEpic).includes('Sizing: M'));

  // The label vocabulary is derived, so renaming a criterion cannot leave a
  // stale label that nothing ever clears.
  const vocab = m.qualityLabelVocabulary();
  for (const c of m.ALL_CRITERIA) {
    const slug = c.id.replace(/^(invest|epic)-/, '');
    check(`label vocabulary covers ${c.id}`, vocab.includes(`reqforge-needs-${slug}`), vocab.join(','));
  }
  check('label vocabulary has no duplicates', new Set(vocab).size === vocab.length);
}

/* ------------------------------------------------ pulling issues out of Jira */

// A fake tenant, so the import path is exercised without a network or a token.
const fakeJira = (issues) => ({
  kind: 'rest',
  capabilities: () => new Set(['jira.read', 'jira.create', 'jira.update', 'jira.search', 'jira.children']),
  async verifyConnection() { return { ok: true, detail: '' }; },
  async getConfluencePage() { throw new Error('not used'); },
  async listProjects() { return []; },
  async listIssueTypes() { return []; },
  async requiredFields() { return []; },
  async createIssue() { throw new Error('not used'); },
  async updateIssue() {},
  async getIssue(key) {
    const i = issues.find((x) => x.key === key);
    if (!i) throw new Error(`no such issue ${key}`);
    return i;
  },
  async searchIssues() { return []; },
  async searchIssueDetails(jql) {
    const parent = jql.match(/parent = "([^"]+)"/)?.[1];
    return issues.filter((i) => i.parentKey === parent);
  }
});

const TARGET = { projectKey: 'KAN', epicIssueType: 'Epic', storyIssueType: 'Story' };

const jiraEpic = {
  id: '1', key: 'KAN-10', url: 'u/KAN-10', issueType: 'Epic', status: 'To Do', labels: [],
  summary: 'Saved cards at checkout', description: m.epicToMarkdown(goodEpic)
};
const jiraStory = {
  id: '2', key: 'KAN-11', url: 'u/KAN-11', issueType: 'Story', status: 'To Do', labels: [],
  summary: 'Show saved cards', description: m.storyToMarkdown(goodStory), parentKey: 'KAN-10'
};
const orphanStory = {
  id: '3', key: 'KAN-12', url: 'u/KAN-12', issueType: 'Story', status: 'To Do', labels: [],
  summary: 'A standalone story', description: m.storyToMarkdown(goodStory)
};

{
  const api = fakeJira([jiraEpic, jiraStory, orphanStory]);

  const asEpic = await m.backlogFromJiraIssue(api, 'KAN-10', TARGET);
  check('import epic: one epic', asEpic.backlog.epics.length === 1);
  check('import epic: its children come with it', asEpic.backlog.epics[0].stories.length === 1);
  check('import epic: the epic keeps its key', asEpic.backlog.epics[0].sync.jiraKey === 'KAN-10');
  check('import epic: fields were parsed back', asEpic.backlog.epics[0].outcome === goodEpic.outcome);

  // The regression: fetching a story used to parse it as an epic, producing an
  // epic with no outcome and a file that then refused to load.
  const asStory = await m.backlogFromJiraIssue(api, 'KAN-11', TARGET);
  check('import story: the story is a story, not an epic',
    asStory.backlog.epics[0].stories.length === 1 && asStory.backlog.epics[0].stories[0].sync.jiraKey === 'KAN-11');
  check('import story: it sits under its real parent', asStory.backlog.epics[0].sync.jiraKey === 'KAN-10');
  check('import story: the parent is not a container', asStory.backlog.epics[0].container !== true);
  check('import story: the narrative survived', asStory.backlog.epics[0].stories[0].narrative.asA === goodStory.narrative.asA);
  check('import story: the file it produces loads',
    m.deserializeBacklog(m.serializeBacklog(asStory.backlog)).epics.length === 1);

  const orphan = await m.backlogFromJiraIssue(api, 'KAN-12', TARGET);
  check('orphan story: goes under a container', orphan.backlog.epics[0].container === true);
  check('orphan story: the container has no Jira key', !orphan.backlog.epics[0].sync.jiraKey);
  check('orphan story: the file loads', m.deserializeBacklog(m.serializeBacklog(orphan.backlog)).epics[0].container === true);

  // A container must never be planned into Jira.
  m.markAsSynced(orphan.backlog);
  const plan = await m.planPush(api, orphan.backlog);
  check('container: is never planned as an epic', plan.actions.every((a) => a.level !== 'epic'), JSON.stringify(plan.actions));
  check('container: its story is still planned', plan.actions.some((a) => a.level === 'story'));

  // And the rubric must not judge it as an epic.
  const q = m.evaluateBacklog(orphan.backlog, m.DEFAULT_RUBRIC);
  check('container: is not judged by the rubric', q.items.every((i) => i.level !== 'epic'), JSON.stringify(q.items.map(i=>i.level)));

  // An epic with no outcome must load and be reported, not rejected.
  const bare = { ...jiraEpic, key: 'KAN-13', description: 'Just some prose from a human.' };
  const bareImport = await m.backlogFromJiraIssue(fakeJira([bare]), 'KAN-13', TARGET);
  check('hand-written epic: loads despite having no outcome',
    m.deserializeBacklog(m.serializeBacklog(bareImport.backlog)).epics[0].outcome === '');
  check('hand-written epic: the rubric blocks on the missing outcome',
    m.evaluateBacklog(bareImport.backlog, m.DEFAULT_RUBRIC).items[0].blockedBy.some((f) => f.ruleId === 'has-outcome'));
  check('hand-written epic: reported as unstructured', bareImport.unstructured === true);
}

/* -------------------------------- a slice of a backlog is not a broken one */

{
  const dependent = { ...goodEpic, dependsOn: ['something-elsewhere'] };

  // A complete decomposition: a dependency on an epic that is not there is broken.
  const whole = backlogOf([dependent]);
  const wholeQ = m.evaluateBacklog(whole, m.DEFAULT_RUBRIC).items.find((i) => i.ref === 'good');
  check('complete backlog: a dangling dependency blocks',
    wholeQ.blockedBy.some((f) => f.ruleId === 'dependencies-resolve'),
    JSON.stringify(wholeQ.blockedBy.map((f) => f.ruleId)));

  // One epic pulled out of Jira: the same dependency points outside the slice,
  // which is ordinary, and blocking on it makes the import unusable.
  const slice = backlogOf([dependent]);
  slice.source.kind = 'jira';
  const sliceQ = m.evaluateBacklog(slice, m.DEFAULT_RUBRIC).items.find((i) => i.ref === 'good');
  check('imported epic: an external dependency does not block',
    !sliceQ.blockedBy.some((f) => f.ruleId === 'dependencies-resolve'),
    JSON.stringify(sliceQ.blockedBy.map((f) => f.ruleId)));
  check('imported epic: it is still reported, as information',
    sliceQ.warnings.some((f) => f.ruleId === 'external-dependency' && f.message.includes('something-elsewhere')),
    JSON.stringify(sliceQ.warnings.map((f) => f.ruleId)));
  check('imported epic: a resolvable dependency reports nothing',
    m.evaluateBacklog(
      (() => { const b = backlogOf([{ ...goodEpic, dependsOn: [] }]); b.source.kind = 'jira'; return b; })(),
      m.DEFAULT_RUBRIC
    ).items.find((i) => i.ref === 'good').warnings.every((f) => f.ruleId !== 'external-dependency'));

  // Same family: traceability is to a source document an import does not have.
  const noEvidence = backlogOf([{ ...goodEpic, sourceEvidence: [] }]);
  check('complete backlog: missing evidence warns',
    m.evaluateBacklog(noEvidence, m.DEFAULT_RUBRIC).items.find((i) => i.ref === 'good')
      .warnings.some((f) => f.ruleId === 'has-evidence'));
  const importedNoEvidence = backlogOf([{ ...goodEpic, sourceEvidence: [] }]);
  importedNoEvidence.source.kind = 'jira';
  check('imported epic: missing evidence does not warn',
    m.evaluateBacklog(importedNoEvidence, m.DEFAULT_RUBRIC).items.find((i) => i.ref === 'good')
      .warnings.every((f) => f.ruleId !== 'has-evidence'));

  // Depending on yourself is broken either way.
  const selfDep = backlogOf([{ ...goodEpic, dependsOn: ['good'] }]);
  selfDep.source.kind = 'jira';
  check('imported epic: a self-dependency still blocks',
    m.evaluateBacklog(selfDep, m.DEFAULT_RUBRIC).items.find((i) => i.ref === 'good')
      .blockedBy.some((f) => f.ruleId === 'no-self-dependency'));
}

/* ------------------------------------------------------------ sync status */

{
  const hash = m.epicFingerprint(goodEpic);
  const other = m.epicFingerprint({ ...goodEpic, title: 'Changed' });

  check('sync: no key means new', m.syncStatus({}, hash) === 'new');
  check('sync: key with a matching hash means synced', m.syncStatus({ jiraKey: 'A-1', pushedHash: hash }, hash) === 'synced');
  // The regression: a present pushedHash used to be taken as proof of being up
  // to date, so anything edited after a push showed as synced and was not sent.
  check('sync: key with a stale hash means edited',
    m.syncStatus({ jiraKey: 'A-1', pushedHash: other }, hash) === 'edited');
  check('sync: an adopted issue never pushed from here counts as edited',
    m.syncStatus({ jiraKey: 'A-1' }, hash) === 'edited');

  check('pending: a synced item is not pending', m.isPending({ jiraKey: 'A-1', pushedHash: hash }, hash) === false);
  check('pending: an edited item is pending', m.isPending({ jiraKey: 'A-1', pushedHash: other }, hash) === true);
  check('pending: a new item is pending', m.isPending({}, hash) === true);
}

/* ------------------------------------------------------- backlog store CRUD */

const memFs = () => {
  const files = new Map();
  return {
    files,
    async read(p) { return files.get(p); },
    async write(p, c) { files.set(p, c); },
    async list(dir) { return [...files.keys()].filter((k) => k.startsWith(dir + '/')).map((k) => k.slice(dir.length + 1)); },
    async remove(p) { files.delete(p); }
  };
};

{
  const fs = memFs();
  const store = new m.BacklogStore(fs, '.reqforge');
  const b = backlogOf([goodEpic]);
  b.source.title = 'Payments';

  await store.save('payments', b);
  await store.save('other', b);
  await m.saveQuality(fs, '.reqforge', 'payments', { assessments: new Map([['k', []]]), overrides: new Map() });

  check('store: saved backlogs are listed', (await store.listSlugs()).sort().join(',') === 'other,payments');
  check('store: a saved backlog loads back', (await store.load('payments'))?.source.title === 'Payments');
  check('store: the quality sidecar is written', fs.files.has(m.qualityPath('.reqforge', 'payments')));

  await store.remove('payments');
  await m.deleteQuality(fs, '.reqforge', 'payments');

  check('delete: the backlog is gone from the list', (await store.listSlugs()).join(',') === 'other');
  check('delete: loading it returns nothing', (await store.load('payments')) === undefined);
  check('delete: its quality sidecar is gone too', !fs.files.has(m.qualityPath('.reqforge', 'payments')));
  check('delete: other backlogs are untouched', (await store.load('other'))?.source.title === 'Payments');
  check('delete: deleting a missing backlog is not an error', await store.remove('nope').then(() => true).catch(() => false));
}

/* Regression: a save must leave the previous contents recoverable. This file is
   the only record of work that has not reached Jira. */
{
  const fs = memFs();
  const store = new m.BacklogStore(fs, '.reqforge');
  const one = backlogOf([goodEpic]);
  const emptied = backlogOf([]);

  await store.save('x', one);
  check('backup: the first save creates no backup', !fs.files.has('.reqforge/x.backlog.yaml.bak'));

  await store.save('x', emptied);
  const bak = fs.files.get('.reqforge/x.backlog.yaml.bak');
  check('backup: the previous contents are kept', Boolean(bak) && bak.includes('good'));
  check('backup: the current file has the new contents', (await store.load('x')).epics.length === 0);
  check('backup: the backup still parses as a backlog', m.deserializeBacklog(bak).epics.length === 1);
  check('backup: backups are not listed as backlogs', (await store.listSlugs()).join(',') === 'x');

  await store.remove('x');
  check('backup: removing a backlog removes its backup too', !fs.files.has('.reqforge/x.backlog.yaml.bak'));
}

/* ------------------------------------------------ assumptions about the host */

{
  // ReqForge can run with no workspace open, using a configured storage folder.
  // Any code that reaches for workspaceFolders[0] with a non-null assertion
  // throws in that mode — and the assertion is exactly what stops the compiler
  // from telling you. One such line shipped and crashed "Create rubric file".
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = `${dir}/${name}`;
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  const offenders = walk('src')
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ file: f, text: readFileSync(f, 'utf8') }))
    .filter(({ text }) => /workspaceFolders!\s*\[/.test(text))
    .map(({ file }) => file);

  check(
    'no file asserts workspaceFolders is non-empty',
    offenders.length === 0,
    `${offenders.join(', ')} — use WorkspaceFs.resolve(), which honours the storage folder`
  );

  // And the folder picker should exist once.
  const pickers = walk('src')
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => readFileSync(f, 'utf8').includes('showOpenDialog'));
  check('the folder picker is defined in one place', pickers.length === 1, pickers.join(', '));
}

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
