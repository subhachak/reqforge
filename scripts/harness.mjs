/**
 * Renders the webview outside VS Code so the UI can be looked at and iterated
 * on without an extension host.
 *
 * Stubs acquireVsCodeApi(), loads a real backlog file, and serves the built
 * bundle. Messages the webview posts are logged to the console, so intent
 * wiring can be checked by clicking around.
 *
 *   node scripts/harness.mjs [path-to-backlog.yaml] [port]
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import path from 'node:path';

const backlogPath = process.argv[2];
const port = Number(process.argv[3] ?? 5177);

await esbuild.build({
  stdin: {
    contents: `export { deserializeBacklog } from '${path.resolve('src/core/store.ts')}';
       export { evaluateBacklog, cacheKey } from '${path.resolve('src/core/rubric/score.ts')}';
       export { DEFAULT_RUBRIC } from '${path.resolve('src/core/rubric/types.ts')}';
       export { EPIC_CRITERIA, STORY_CRITERIA } from '${path.resolve('src/core/rubric/criteria.ts')}';
       export { epicFingerprint, storyFingerprint } from '${path.resolve('src/core/model.ts')}';`,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  outfile: '/tmp/reqforge-harness-store.cjs',
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { deserializeBacklog, evaluateBacklog, cacheKey, DEFAULT_RUBRIC, EPIC_CRITERIA, STORY_CRITERIA, epicFingerprint, storyFingerprint } =
  createRequire(import.meta.url)('/tmp/reqforge-harness-store.cjs');

/** A backlog covering every status the UI renders, used when none is supplied. */
const SAMPLE = {
  version: 1,
  source: {
    kind: 'confluence',
    pageId: '66000',
    title: 'Sample PRD',
    url: 'https://example.atlassian.net/wiki/x',
    ingestedAt: new Date().toISOString()
  },
  target: { projectKey: 'DEMO', epicIssueType: 'Epic', storyIssueType: 'Story' },
  prd: {
    title: 'Sample PRD',
    summary: 'A short summary.',
    goals: [],
    nonGoals: [],
    personas: [],
    constraints: [],
    openQuestions: ['Who owns the rollout?', 'What happens on failure?'],
    risks: ['Two requirements contradict each other.']
  },
  epics: [
    {
      ref: 'sample',
      title: 'A sample epic',
      outcome: 'Something useful happens',
      description: 'Body text.',
      inScope: ['One thing'],
      outOfScope: ['Another thing'],
      acceptanceCriteria: [{ given: 'a precondition', when: 'an action', then: 'an outcome' }],
      dependsOn: [],
      sizing: 'M',
      openQuestions: ['Still unclear?'],
      sourceEvidence: ['a quote from the source'],
      sync: {},
      stories: []
    }
  ]
};

const backlog = backlogPath ? deserializeBacklog(readFileSync(backlogPath, 'utf8')) : SAMPLE;

// HARNESS_SYNCED=1 marks every item as pushed and current, which is the state
// after a successful push — the case where the buttons must go quiet.
if (process.env.HARNESS_SYNCED) {
  let n = 80;
  for (const e of backlog.epics) {
    e.sync = { jiraKey: `KAN-${n++}`, pushedHash: epicFingerprint(e), pushedAt: new Date().toISOString() };
    for (const st of e.stories) {
      st.sync = { jiraKey: `KAN-${n++}`, pushedHash: storyFingerprint(st), pushedAt: new Date().toISOString() };
    }
  }
}

// Give the fixture one of each status so every badge and dot is exercised.
if (!process.env.HARNESS_SYNCED) {
  if (backlog.epics[0]) {
    backlog.epics[0].sync = { jiraKey: 'DEMO-1', pushedHash: 'abc', pushedAt: new Date().toISOString() };
    if (backlog.epics[0].stories[0]) {
      backlog.epics[0].stories[0].sync = { jiraKey: 'DEMO-2', pushedHash: 'stale-hash-so-this-reads-as-edited' };
    }
  }
  if (backlog.epics[1]) backlog.epics[1].sync = { jiraKey: 'DEMO-9' };
}

/* A quality fixture covering every visual state: reviewed-good, reviewed-poor,
   blocked, and not-yet-reviewed. */
const CRITERIA = [...EPIC_CRITERIA, ...STORY_CRITERIA];

/* Which reviewer owns which criterion, mirroring REVIEWERS without importing
   it — the harness renders the restricted build too, where there is no panel. */
const OWNER = {
  'epic-outcome-focused': 'product', 'epic-coherent': 'product', 'epic-bounded': 'product',
  'invest-valuable': 'product', 'invest-negotiable': 'product',
  'epic-independent': 'delivery', 'epic-right-sized': 'delivery',
  'invest-independent': 'delivery', 'invest-estimable': 'delivery', 'invest-small': 'delivery',
  'epic-testable': 'test', 'invest-testable': 'test',
  'epic-traceable': 'evidence'
};

function ratingsFor(level, rating) {
  return (level === 'epic' ? EPIC_CRITERIA : STORY_CRITERIA).map((c) => ({
    id: c.id,
    reviewerId: HARNESS_PANEL ? OWNER[c.id] : undefined,
    rating,
    justification:
      rating >= 3
        ? 'The item states this explicitly and the wording is unambiguous.'
        : 'The wording leaves this open to interpretation, so a team would have to ask.',
    suggestion: rating >= 3 ? '' : 'Name the specific role and restate the outcome as something a tester can observe.'
  }));
}

function buildQuality() {
  const cached = new Map();
  const epics = backlog.epics;
  if (process.env.HARNESS_SYNCED) {
    for (const e of epics) {
      cached.set(cacheKey('epic', e.ref, epicFingerprint(e)), ratingsFor('epic', 3));
      for (const st of e.stories) cached.set(cacheKey('story', st.ref, storyFingerprint(st)), ratingsFor('story', 3));
    }
    return evaluateBacklog(backlog, DEFAULT_RUBRIC, cached);
  }
  if (epics[0]) cached.set(cacheKey('epic', epics[0].ref, epicFingerprint(epics[0])), ratingsFor('epic', 3));
  if (epics[1]) cached.set(cacheKey('epic', epics[1].ref, epicFingerprint(epics[1])), ratingsFor('epic', 1));
  if (epics[2]) cached.set(cacheKey('epic', epics[2].ref, epicFingerprint(epics[2])), ratingsFor('epic', 2));
  for (const s of epics[0]?.stories ?? []) {
    cached.set(cacheKey('story', s.ref, storyFingerprint(s)), ratingsFor('story', s.points >= 5 ? 2 : 3));
  }
  return evaluateBacklog(backlog, DEFAULT_RUBRIC, cached);
}

// HARNESS_PANEL=1 renders the full profile: attributed ratings, observations
// and a conflict. Off by default so the restricted build is what you see.
const HARNESS_PANEL = Boolean(process.env.HARNESS_PANEL);

const complete = process.env.HARNESS_SETUP !== 'incomplete';
const view = process.env.HARNESS_VIEW || (complete ? 'home' : 'setup');

const state = {
  view,
  setup: {
    llmProvider: HARNESS_PANEL ? 'anthropic' : 'copilot',
    transport: HARNESS_PANEL ? 'mcp' : 'rest',
    mcpEndpoint: HARNESS_PANEL ? 'npx -y mcp-remote https://example-mcp.invalid/v1/sse' : '',
    hasAnthropicKey: false,
    profile: HARNESS_PANEL ? 'full' : 'restricted',
    availableTransports: HARNESS_PANEL ? ['rest', 'mcp'] : ['rest'],
    availableLlmProviders: HARNESS_PANEL ? ['copilot', 'anthropic', 'fixture'] : ['copilot'],
    baseUrl: complete ? 'https://example.atlassian.net' : '',
    email: complete ? 'you@example.com' : '',
    projectKey: complete ? 'KAN' : '',
    epicIssueType: 'Epic',
    storyIssueType: 'Story',
    modelFamily: '',
    hasToken: complete,
    complete,
    // With the panel fixtures on, stand in a realistic MCP resolution table:
    // it is multi-line, and rendering it legibly is the whole point of the check.
    atlassian: HARNESS_PANEL
      ? {
          state: 'ok',
          detail:
            'MCP connected as po@example.com — 9/9 operations resolved, Teamwork Graph search available.\n' +
            '  confluence.getPage -> getConfluencePage (cloudId)\n' +
            '  jira.search -> searchJiraIssuesUsingJql (cloudId)\n' +
            '  jira.createIssue -> createJiraIssue (cloudId)\n' +
            '  jira.updateIssue -> editJiraIssue (cloudId)\n' +
            '  jira.getIssue -> getJiraIssue (cloudId)\n' +
            '  graph.search -> search (cloudId)'
        }
      : { state: 'unknown', detail: '' },
    model: { state: 'unknown', detail: '' }
  },
  recent: [
    {
      slug: 'sample',
      title: backlog.source.title,
      epics: backlog.epics.length,
      stories: backlog.epics.reduce((n, e) => n + e.stories.length, 0),
      unpushed: 3,
      projectKey: backlog.target.projectKey
    }
  ],
  backlog,
  slug: 'sample',
  jira:
    view === 'jira'
      ? {
          key: 'KAN-95',
          url: 'https://example.atlassian.net/browse/KAN-95',
          summary: 'Configurable Pension and Bank-Charge Rules API',
          description:
            '*Outcome:* Administrators can change pension rules without a code release.\n\n## Acceptance criteria\n- **Given** an authorised administrator **when** they POST a rule **then** a version id is returned\n- **Given** overlapping effective dates **when** the second is submitted **then** it is rejected',
          issueType: 'Epic',
          status: 'In Progress'
        }
      : undefined,
  busy: false,
  busyLabel: '',
  plan: undefined,
  notice: undefined,
  pendingRefine: undefined,
  jiraBrowseBase: 'https://example.atlassian.net',
  undoLabel: 'edit',
  redoLabel: undefined,
  criteria: CRITERIA,
  reviewers: HARNESS_PANEL
    ? [
        { id: 'product', name: 'Product', purpose: 'Is this the right work, and is it bounded?' },
        { id: 'delivery', name: 'Delivery', purpose: 'Can a team actually build and ship this?' },
        { id: 'test', name: 'Test', purpose: 'Could someone verify this without asking what was meant?' },
        { id: 'evidence', name: 'Evidence', purpose: 'Is every claim supported by the source?' }
      ]
    : [],
  observations: HARNESS_PANEL
    ? [
        {
          reviewerId: 'test',
          level: 'epic',
          ref: backlog.epics[0]?.ref,
          severity: 'warn',
          message: 'No acceptance criterion covers what happens when the rule service is unavailable.',
          field: 'acceptanceCriteria'
        },
        {
          reviewerId: 'evidence',
          level: 'epic',
          ref: backlog.epics[0]?.ref,
          severity: 'warn',
          message: 'The source states a 2-second response budget, but no item carries it as a non-functional requirement.'
        }
      ]
    : [],
  conflicts: HARNESS_PANEL
    ? [
        {
          level: 'epic',
          ref: backlog.epics[0]?.ref,
          between: ['delivery', 'product'],
          positions: [
            'Split this into rule authoring and rule publishing so the first half can ship in one sprint.',
            'Authoring without publishing changes nothing for an administrator, so the split would ship no outcome.'
          ],
          tradeoff: 'Ship something in one sprint, or keep the epic whole and deliver the outcome in two.'
        }
      ]
    : [],
  lastPanelRun: undefined,
  canCheckExisting: HARNESS_PANEL,
  duplicates: undefined,
  rubric: { threshold: 70, enforcement: 'block', requireReview: true, source: 'default' },
  quality: buildQuality()
};

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>ReqForge webview harness</title>
<link rel="stylesheet" href="/webview.css" />
<style>
  /* Approximate VS Code Dark Modern so the harness is representative. */
  :root {
    --vscode-foreground:#cccccc; --vscode-editor-background:#1f1f1f;
    --vscode-descriptionForeground:#9d9d9d; --vscode-panel-border:#2b2b2b;
    --vscode-input-background:#313131; --vscode-input-foreground:#cccccc; --vscode-input-border:#3c3c3c;
    --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff; --vscode-button-hoverBackground:#026ec1;
    --vscode-button-secondaryBackground:#313131; --vscode-button-secondaryForeground:#cccccc;
    --vscode-focusBorder:#0078d4; --vscode-list-hoverBackground:#2a2d2e;
    --vscode-list-activeSelectionBackground:#04395e; --vscode-list-activeSelectionForeground:#ffffff;
    --vscode-charts-green:#89d185; --vscode-charts-yellow:#cca700; --vscode-charts-blue:#3794ff;
    --vscode-errorForeground:#f14c4c; --vscode-font-size:13px;
    --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  }
  :root.light {
    --vscode-foreground:#3b3b3b; --vscode-editor-background:#ffffff;
    --vscode-descriptionForeground:#767676; --vscode-panel-border:#e5e5e5;
    --vscode-input-background:#ffffff; --vscode-input-foreground:#3b3b3b; --vscode-input-border:#cecece;
    --vscode-button-secondaryBackground:#e5e5e5; --vscode-button-secondaryForeground:#3b3b3b;
    --vscode-list-hoverBackground:#f0f0f0; --vscode-list-activeSelectionBackground:#0060c0;
    --vscode-charts-green:#388a34; --vscode-charts-yellow:#b5900a; --vscode-charts-blue:#1a85ff;
  }
  #log { position:fixed; bottom:0; right:0; max-width:460px; max-height:190px; overflow:auto;
    background:rgba(0,0,0,.82); color:#8f8; font:11px/1.45 monospace; padding:8px; z-index:99;
    border-top-left-radius:6px; }
</style>
</head><body>
<div id="root"></div>
<pre id="log">harness ready — posted messages appear here</pre>
<script>
  const initial = ${JSON.stringify(state)};
  const log = (m) => {
    const el = document.getElementById('log');
    el.textContent += '\\n' + m;
    el.scrollTop = el.scrollHeight;
  };
  window.acquireVsCodeApi = () => ({
    postMessage: (msg) => {
      log('→ ' + JSON.stringify(msg).slice(0, 260));
      // Echo state back on ready, as the host would.
      if (msg.type === 'ready') {
        setTimeout(() => window.postMessage({ type: 'state', state: initial }, '*'), 30);
      }
    }
  });
  // Toggle theme with "t" to eyeball light mode.
  addEventListener('keydown', (e) => { if (e.key === 't') document.documentElement.classList.toggle('light'); });
</script>
<script src="/webview.js"></script>
</body></html>`;

createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/webview.js' || url === '/webview.css') {
    const body = readFileSync(path.join('dist', url.slice(1)));
    res.writeHead(200, { 'Content-Type': url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}).listen(port, () => console.log(`harness on http://localhost:${port}`));
