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
    contents: `export { deserializeBacklog } from '${path.resolve('src/core/store.ts')}';`,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  outfile: '/tmp/reqforge-harness-store.cjs',
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { deserializeBacklog } = createRequire(import.meta.url)('/tmp/reqforge-harness-store.cjs');

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

// Give the fixture one of each status so every badge and dot is exercised.
if (backlog.epics[0]) {
  backlog.epics[0].sync = { jiraKey: 'DEMO-1', pushedHash: 'abc', pushedAt: new Date().toISOString() };
  if (backlog.epics[0].stories[0]) {
    backlog.epics[0].stories[0].sync = { jiraKey: 'DEMO-2', pushedHash: 'stale-hash-so-this-reads-as-edited' };
  }
}
if (backlog.epics[1]) backlog.epics[1].sync = { jiraKey: 'DEMO-9' };

const state = {
  backlog,
  available: [{ slug: 'sample', title: backlog.source.title }],
  slug: 'sample',
  busy: false,
  busyLabel: '',
  plan: undefined,
  notice: undefined,
  pendingRefine: undefined,
  jiraBrowseBase: 'https://example.atlassian.net',
  canPush: true
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
