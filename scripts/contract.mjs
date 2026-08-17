/**
 * Contract tests for AtlassianPort.
 *
 * One suite, two adapters. The REST adapter runs against a stubbed `fetch`
 * serving Atlassian Cloud's REST shapes; the MCP adapter runs against a real
 * in-process MCP server (SDK in-memory transport) whose tools are named and
 * shaped the way Atlassian's are. Both are backed by the SAME fake tenant, so
 * any difference in the domain objects that come out is a genuine divergence
 * between the adapters rather than a difference in the fixtures.
 *
 * This is what makes the port a contract rather than an aspiration: before it
 * existed, "MCP satisfies AtlassianPort" was only ever true at the type level.
 *
 *   node scripts/contract.mjs
 */
import * as esbuild from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'reqforge-contract-'));
const entry = path.join(dir, 'entry.mjs');

writeFileSync(
  entry,
  `
export { AtlassianRestAdapter } from '${path.resolve('src/adapters/atlassian/rest.ts')}';
export { AtlassianMcpAdapter } from '${path.resolve('src/adapters/atlassian/mcp.ts')}';
export { resolveTools, capabilitiesFrom, pickArg, argType } from '${path.resolve('src/adapters/atlassian/mcpRouting.ts')}';
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
export { z } from 'zod';
export { AnthropicLlmAdapter } from '${path.resolve('src/adapters/llm/anthropic.ts')}';
export { withCachedPrefix } from '${path.resolve('src/core/prompts.ts')}';
`
);

const out = path.join(dir, 'bundle.cjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  outfile: out,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // The entry lives in a temp dir, so package resolution has to be pointed
  // back at the repo's node_modules.
  nodePaths: [path.resolve('node_modules')],
  logLevel: 'warning'
});

const {
  AnthropicLlmAdapter,
  withCachedPrefix,
  AtlassianRestAdapter,
  AtlassianMcpAdapter,
  resolveTools,
  capabilitiesFrom,
  pickArg,
  McpServer,
  InMemoryTransport,
  z
} = createRequire(import.meta.url)(out);

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (name) => console.log(`\n${name}`);

/* ------------------------------------------------------------ fake tenant */

const BASE = 'https://example.atlassian.net';
const CLOUD_ID = 'cloud-abc-123';

/** Rebuilt for each adapter so writes from one run cannot leak into the next. */
function newTenant() {
  return {
    pages: {
      '55501': {
        id: '55501',
        title: 'Payments PRD',
        spaceKey: 'PROD',
        version: 3,
        storage: '<h1>Goal</h1><p>Let customers <strong>pay</strong> by card.</p><ul><li>Fast</li><li>Safe</li></ul>'
      }
    },
    projects: [{ id: '10000', key: 'PAY', name: 'Payments' }],
    issueTypes: [
      { id: '10001', name: 'Epic', subtask: false },
      { id: '10002', name: 'Story', subtask: false }
    ],
    issues: {
      'PAY-1': {
        id: '20001',
        key: 'PAY-1',
        summary: 'Card payments',
        descriptionMarkdown: 'Accept card payments.\n\nSecond paragraph.',
        issueType: 'Epic',
        status: 'To Do',
        labels: ['reqforge-55501-E1'],
        parentKey: undefined
      },
      'PAY-2': {
        id: '20002',
        key: 'PAY-2',
        summary: 'Enter card details',
        descriptionMarkdown: 'As a shopper\nI want to enter my card\nSo that I can pay',
        issueType: 'Story',
        status: 'To Do',
        labels: [],
        parentKey: 'PAY-1'
      }
    },
    nextId: 20003
  };
}

/** Crude JQL support: only the two shapes the pipelines actually emit. */
function runJql(tenant, jql) {
  const all = Object.values(tenant.issues);
  const parent = /parent\s*=\s*"?([A-Z]+-\d+)"?/i.exec(jql);
  if (parent) return all.filter((i) => i.parentKey === parent[1]);
  const label = /labels?\s*(?:=|in)\s*\(?"?([\w-]+)"?\)?/i.exec(jql);
  if (label) return all.filter((i) => i.labels.includes(label[1]));
  return all;
}

/* --------------------------------------------------- REST backend (fetch) */

function installFetchStub(tenant) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    // Confluence page
    let m = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(u.pathname);
    if (m) {
      const p = tenant.pages[m[1]];
      if (!p) return json({ message: 'not found' }, 404);
      return json({
        id: p.id,
        title: p.title,
        spaceId: p.spaceKey,
        version: { number: p.version },
        body: { storage: { value: p.storage } },
        _links: { webui: `/wiki/spaces/${p.spaceKey}/pages/${p.id}` }
      });
    }

    if (u.pathname === '/rest/api/3/myself') return json({ emailAddress: 'po@example.com', displayName: 'A PO' });

    if (u.pathname === '/rest/api/3/project/search') return json({ values: tenant.projects });

    if (/^\/rest\/api\/3\/issue\/createmeta/.test(u.pathname)) {
      if (u.pathname.endsWith('/issuetypes')) return json({ issueTypes: tenant.issueTypes });
      return json({ fields: [{ fieldId: 'summary', required: true, name: 'Summary' }] });
    }

    if (u.pathname === '/rest/api/3/search/jql' && method === 'POST') {
      const hits = runJql(tenant, body.jql).slice(0, body.maxResults ?? 50);
      return json({ issues: hits.map(toRestIssue) });
    }

    m = /^\/rest\/api\/3\/issue\/([\w-]+)$/.exec(u.pathname);
    if (m && method === 'GET') {
      const issue = tenant.issues[m[1]];
      return issue ? json(toRestIssue(issue)) : json({ message: 'not found' }, 404);
    }
    if (m && method === 'PUT') {
      const issue = tenant.issues[m[1]];
      if (!issue) return json({ message: 'not found' }, 404);
      applyRestPatch(issue, body);
      return new Response(null, { status: 204 });
    }

    if (u.pathname === '/rest/api/3/issue' && method === 'POST') {
      const f = body.fields;
      const id = String(tenant.nextId++);
      const key = `PAY-${id.slice(-1)}${id.slice(2, 4)}`;
      tenant.issues[key] = {
        id,
        key,
        summary: f.summary,
        descriptionMarkdown: adfText(f.description),
        issueType: f.issuetype.name,
        status: 'To Do',
        labels: f.labels ?? [],
        parentKey: f.parent?.key
      };
      return json({ id, key, self: `${BASE}/rest/api/3/issue/${id}` }, 201);
    }

    return json({ message: `unstubbed ${method} ${u.pathname}` }, 404);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function toRestIssue(i) {
  return {
    id: i.id,
    key: i.key,
    fields: {
      summary: i.summary,
      description: mdToAdfish(i.descriptionMarkdown),
      issuetype: { name: i.issueType },
      status: { name: i.status },
      labels: i.labels,
      parent: i.parentKey ? { key: i.parentKey } : undefined
    }
  };
}

/** Minimal ADF good enough to round-trip through the real converters. */
function mdToAdfish(markdown) {
  return {
    type: 'doc',
    version: 1,
    content: markdown.split(/\n{2,}/).map((para) => ({
      type: 'paragraph',
      content: para.split('\n').flatMap((line, i) => [
        ...(i > 0 ? [{ type: 'hardBreak' }] : []),
        { type: 'text', text: line }
      ])
    }))
  };
}

function adfText(adf) {
  if (typeof adf === 'string') return adf;
  const walk = (node) => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    const inner = (node.content ?? []).map(walk).join('');
    return node.type === 'paragraph' ? `${inner}\n\n` : inner;
  };
  return (adf?.content ?? []).map(walk).join('').trim();
}

function applyRestPatch(issue, body) {
  const f = body.fields ?? {};
  if (f.summary !== undefined) issue.summary = f.summary;
  if (f.description !== undefined) issue.descriptionMarkdown = adfText(f.description);
  if (f.labels !== undefined) issue.labels = f.labels;
  for (const op of body.update?.labels ?? []) {
    if (op.add && !issue.labels.includes(op.add)) issue.labels.push(op.add);
    if (op.remove) issue.labels = issue.labels.filter((l) => l !== op.remove);
  }
}

/* ------------------------------------------------------ MCP backend (real) */

/**
 * Tool names and argument names deliberately differ from anything hardcoded in
 * the adapter — they are Atlassian's names, which the adapter has to discover.
 */
function buildMcpServer(tenant) {
  const server = new McpServer({ name: 'fake-atlassian', version: '1.0.0' });
  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

  server.registerTool(
    'getAccessibleAtlassianResources',
    { description: 'List sites', inputSchema: {} },
    async () => ok([{ id: CLOUD_ID, url: BASE, name: 'example' }])
  );

  server.registerTool(
    'atlassianUserInfo',
    { description: 'Who am I', inputSchema: {} },
    async () => ok({ email: 'po@example.com', displayName: 'A PO' })
  );

  server.registerTool(
    'getConfluencePage',
    {
      description: 'Fetch a Confluence page',
      inputSchema: { cloudId: z.string(), pageId: z.string() }
    },
    async ({ cloudId, pageId }) => {
      if (cloudId !== CLOUD_ID) throw new Error(`wrong cloudId: ${cloudId}`);
      const p = tenant.pages[pageId];
      if (!p) return { isError: true, content: [{ type: 'text', text: 'no such page' }] };
      return ok({
        id: p.id,
        title: p.title,
        space: { key: p.spaceKey },
        version: { number: p.version },
        body: { storage: { value: p.storage } },
        url: `${BASE}/wiki/spaces/${p.spaceKey}/pages/${p.id}`
      });
    }
  );

  server.registerTool(
    'getVisibleJiraProjects',
    { description: 'List projects', inputSchema: { cloudId: z.string() } },
    async () => ok({ values: tenant.projects })
  );

  server.registerTool(
    'getJiraProjectIssueTypesMetadata',
    { description: 'Issue types', inputSchema: { cloudId: z.string(), projectIdOrKey: z.string() } },
    async () => ok({ values: tenant.issueTypes })
  );

  server.registerTool(
    'getJiraIssue',
    { description: 'Fetch one issue', inputSchema: { cloudId: z.string(), issueIdOrKey: z.string() } },
    async ({ issueIdOrKey }) => {
      const i = tenant.issues[issueIdOrKey];
      if (!i) return { isError: true, content: [{ type: 'text', text: 'no such issue' }] };
      return ok(toRestIssue(i));
    }
  );

  server.registerTool(
    'searchJiraIssuesUsingJql',
    {
      description: 'JQL search',
      inputSchema: { cloudId: z.string(), jql: z.string(), maxResults: z.number().optional(), fields: z.array(z.string()).optional() }
    },
    async ({ jql, maxResults }) => ok({ issues: runJql(tenant, jql).slice(0, maxResults ?? 50).map(toRestIssue) })
  );

  server.registerTool(
    'createJiraIssue',
    {
      description: 'Create an issue',
      inputSchema: {
        cloudId: z.string(),
        projectKey: z.string(),
        issueTypeName: z.string(),
        summary: z.string(),
        description: z.string().optional(), // string => the adapter must send markdown, not ADF
        labels: z.array(z.string()).optional(),
        parentKey: z.string().optional()
      }
    },
    async (args) => {
      const id = String(tenant.nextId++);
      const key = `PAY-${id.slice(-1)}${id.slice(2, 4)}`;
      tenant.issues[key] = {
        id,
        key,
        summary: args.summary,
        descriptionMarkdown: args.description ?? '',
        issueType: args.issueTypeName,
        status: 'To Do',
        labels: args.labels ?? [],
        parentKey: args.parentKey
      };
      return ok({ id, key, url: `${BASE}/browse/${key}` });
    }
  );

  server.registerTool(
    'editJiraIssue',
    {
      description: 'Edit an issue',
      inputSchema: { cloudId: z.string(), issueIdOrKey: z.string(), fields: z.object({}).passthrough() }
    },
    async ({ issueIdOrKey, fields }) => {
      const i = tenant.issues[issueIdOrKey];
      if (!i) return { isError: true, content: [{ type: 'text', text: 'no such issue' }] };
      if (fields.summary !== undefined) i.summary = fields.summary;
      if (fields.description !== undefined) i.descriptionMarkdown = adfText(fields.description);
      if (fields.labels !== undefined) i.labels = fields.labels;
      return ok({ key: i.key });
    }
  );

  // Teamwork Graph retrieval. No REST equivalent — this is the capability the
  // full profile exists for.
  server.registerTool(
    'search',
    {
      description: 'Natural-language search across Confluence and Jira (Rovo)',
      inputSchema: { cloudId: z.string(), query: z.string(), limit: z.number().optional() }
    },
    async ({ query, limit }) => {
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const hits = [];
      for (const i of Object.values(tenant.issues)) {
        const hay = `${i.summary} ${i.descriptionMarkdown}`.toLowerCase();
        const score = words.filter((w) => hay.includes(w)).length / Math.max(words.length, 1);
        if (score > 0) hits.push({ id: i.key, key: i.key, title: i.summary, product: 'jira', type: i.issueType, url: `${BASE}/browse/${i.key}`, excerpt: i.descriptionMarkdown.slice(0, 40), score });
      }
      for (const p of Object.values(tenant.pages)) {
        const hay = `${p.title} ${p.storage}`.toLowerCase();
        const score = words.filter((w) => hay.includes(w)).length / Math.max(words.length, 1);
        if (score > 0) hits.push({ id: p.id, title: p.title, product: 'confluence', type: 'page', url: `${BASE}/wiki/pages/${p.id}`, score });
      }
      hits.sort((a, b) => b.score - a.score);
      return ok({ results: hits.slice(0, limit ?? 10) });
    }
  );

  return server;
}

async function connectedMcpAdapter(tenant) {
  const server = buildMcpServer(tenant);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const adapter = new AtlassianMcpAdapter({
    endpoint: 'in-memory',
    baseUrl: BASE,
    transportFactory: () => clientSide
  });
  return { adapter, server };
}

/* ------------------------------------------------------- the shared suite */

/** Every assertion here must hold for any AtlassianPort implementation. */
async function runContract(label, port, tenant) {
  section(`Contract: ${label}`);

  const verify = await port.verifyConnection();
  check(`${label}: verifyConnection succeeds`, verify.ok === true, verify.detail);

  const caps = port.capabilities();
  for (const c of ['confluence.read', 'jira.read', 'jira.create', 'jira.update', 'jira.search']) {
    check(`${label}: advertises ${c}`, caps.has(c));
  }

  const page = await port.getConfluencePage('55501');
  check(`${label}: page title`, page.title === 'Payments PRD', page.title);
  check(`${label}: page id`, page.id === '55501', page.id);
  check(`${label}: storage converted to markdown`, /^#\s*Goal/m.test(page.markdown), JSON.stringify(page.markdown));
  check(`${label}: bold survives conversion`, /\*\*pay\*\*/.test(page.markdown), page.markdown);
  check(`${label}: list survives conversion`, /^- Fast$/m.test(page.markdown), JSON.stringify(page.markdown));

  const fromUrl = await port.getConfluencePage(`${BASE}/wiki/spaces/PROD/pages/55501/Payments+PRD`);
  check(`${label}: accepts a page URL`, fromUrl.id === '55501', fromUrl.id);

  const projects = await port.listProjects();
  check(`${label}: lists projects`, projects.length === 1 && projects[0].key === 'PAY', JSON.stringify(projects));

  const types = await port.listIssueTypes('PAY');
  check(`${label}: lists issue types`, types.map((t) => t.name).sort().join(',') === 'Epic,Story', JSON.stringify(types));

  const epic = await port.getIssue('PAY-1');
  check(`${label}: issue summary`, epic.summary === 'Card payments', epic.summary);
  check(`${label}: issue type`, epic.issueType === 'Epic', epic.issueType);
  check(`${label}: issue status`, epic.status === 'To Do', epic.status);
  check(`${label}: issue labels`, epic.labels.join(',') === 'reqforge-55501-E1', epic.labels.join(','));
  check(`${label}: issue url is browsable`, epic.url === `${BASE}/browse/PAY-1`, epic.url);
  check(`${label}: description came back as markdown`, /Accept card payments/.test(epic.description), epic.description);
  check(`${label}: paragraph break survived`, /Second paragraph/.test(epic.description), epic.description);

  const story = await port.getIssue('PAY-2');
  check(`${label}: story reports its parent`, story.parentKey === 'PAY-1', String(story.parentKey));
  // The narrative bug that shipped once: three lines must not collapse into one.
  check(
    `${label}: narrative keeps its line breaks`,
    story.description.split('\n').filter((l) => l.trim()).length === 3,
    JSON.stringify(story.description)
  );

  const children = await port.searchIssueDetails('parent = "PAY-1"');
  check(`${label}: finds children by parent`, children.length === 1 && children[0].key === 'PAY-2', JSON.stringify(children.map((c) => c.key)));

  const byLabel = await port.searchIssues('labels = "reqforge-55501-E1"');
  check(`${label}: finds by stamp label`, byLabel.length === 1 && byLabel[0].key === 'PAY-1', JSON.stringify(byLabel));

  const created = await port.createIssue({
    projectKey: 'PAY',
    issueTypeName: 'Story',
    summary: 'Save a card for later',
    descriptionMarkdown: 'As a shopper\nI want to save my card\nSo that checkout is faster',
    labels: ['reqforge-55501-S9'],
    parentKey: 'PAY-1'
  });
  check(`${label}: create returns a key`, /^PAY-/.test(created.key), created.key);
  check(`${label}: create returns a url`, created.url.includes(created.key), created.url);

  const readBack = await port.getIssue(created.key);
  check(`${label}: created summary round-trips`, readBack.summary === 'Save a card for later', readBack.summary);
  check(`${label}: created parent round-trips`, readBack.parentKey === 'PAY-1', String(readBack.parentKey));
  check(`${label}: created labels round-trip`, readBack.labels.join(',') === 'reqforge-55501-S9', readBack.labels.join(','));
  check(
    `${label}: created narrative round-trips intact`,
    readBack.description.split('\n').filter((l) => l.trim()).length === 3,
    JSON.stringify(readBack.description)
  );

  await port.updateIssue(created.key, { summary: 'Save a card', addLabels: ['reqforge-quality-pass'] });
  const updated = await port.getIssue(created.key);
  check(`${label}: update changes the summary`, updated.summary === 'Save a card', updated.summary);
  check(
    `${label}: addLabels preserves existing labels`,
    updated.labels.sort().join(',') === 'reqforge-55501-S9,reqforge-quality-pass',
    updated.labels.join(',')
  );

  await port.updateIssue(created.key, { removeLabels: ['reqforge-quality-pass'] });
  const afterRemove = await port.getIssue(created.key);
  check(`${label}: removeLabels drops just that label`, afterRemove.labels.join(',') === 'reqforge-55501-S9', afterRemove.labels.join(','));

  // An empty patch must not write. Guards against a no-op update bumping the
  // issue's updated timestamp and spamming watchers.
  const before = tenant.issues[created.key].summary;
  await port.updateIssue(created.key, {});
  check(`${label}: an empty patch writes nothing`, tenant.issues[created.key].summary === before);
}

/* ------------------------------------------------------------------- runs */

{
  const tenant = newTenant();
  const restore = installFetchStub(tenant);
  try {
    const rest = new AtlassianRestAdapter({ baseUrl: BASE, email: 'po@example.com', apiToken: 'token' });
    await runContract('rest', rest, tenant);

    section('Contract: rest — capability boundaries');
    check('rest: does not advertise graph.search', !rest.capabilities().has('graph.search'));
    let threw = false;
    try {
      await rest.semanticSearch('anything');
    } catch {
      threw = true;
    }
    check('rest: semanticSearch throws rather than returning []', threw);
  } finally {
    restore();
  }
}

{
  const tenant = newTenant();
  const { adapter, server } = await connectedMcpAdapter(tenant);
  try {
    await runContract('mcp', adapter, tenant);

    section('Contract: mcp — Teamwork Graph');
    check('mcp: advertises graph.search', adapter.capabilities().has('graph.search'));

    const hits = await adapter.semanticSearch('card payments', { limit: 5 });
    check('mcp: semantic search returns hits', hits.length > 0, String(hits.length));
    check('mcp: hits carry a product', hits.every((h) => h.product === 'jira' || h.product === 'confluence'), JSON.stringify(hits.map((h) => h.product)));
    check('mcp: hits carry an id and title', hits.every((h) => h.id && h.title));
    check('mcp: hits are ordered by score', hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score));
    check('mcp: search spans both products', new Set(hits.map((h) => h.product)).size === 2, JSON.stringify(hits.map((h) => h.product)));

    section('Contract: mcp — discovery diagnostics');
    check('mcp: verifyConnection names the resolved tools', /getConfluencePage/.test((await adapter.verifyConnection()).detail));
    check('mcp: verifyConnection reports the user', /po@example.com/.test((await adapter.verifyConnection()).detail));
  } finally {
    await adapter.close();
    await server.close();
  }
}

/* --------------------------------------------- routing, without any server */

section('Routing: name resolution');
{
  // Per-tool schemas, not one shared blob: whether a tool declares `jql` is
  // load-bearing for routing, so a fixture that gives it to everything would
  // test nothing.
  const atlassian = [
    ['getConfluencePage', { cloudId: {}, pageId: {} }],
    ['getVisibleJiraProjects', { cloudId: {} }],
    ['getJiraProjectIssueTypesMetadata', { cloudId: {}, projectIdOrKey: {} }],
    ['getJiraIssue', { cloudId: {}, issueIdOrKey: {} }],
    ['createJiraIssue', { cloudId: {}, projectKey: {}, issueTypeName: {}, summary: {}, description: {} }],
    ['editJiraIssue', { cloudId: {}, issueIdOrKey: {}, fields: {} }],
    ['searchJiraIssuesUsingJql', { cloudId: {}, jql: {}, maxResults: {} }],
    ['getAccessibleAtlassianResources', {}],
    ['atlassianUserInfo', {}],
    ['search', { cloudId: {}, query: {} }]
  ].map(([name, properties]) => ({ name, inputSchema: { properties } }));

  const r = resolveTools(atlassian);
  check('atlassian names: getIssue is not the JQL tool', r.ops['jira.getIssue'].toolName === 'getJiraIssue', r.ops['jira.getIssue'].toolName);
  check('atlassian names: jira.search takes the JQL tool', r.ops['jira.search'].toolName === 'searchJiraIssuesUsingJql', r.ops['jira.search'].toolName);
  check('atlassian names: bare `search` becomes graph.search', r.ops['graph.search'].toolName === 'search', r.ops['graph.search'].toolName);
  check('atlassian names: nothing unresolved', r.unresolved.length === 0, r.unresolved.join(','));
  check('atlassian names: cloudId detected', r.ops['jira.getIssue'].needsCloudId === true);

  // snake_case server, different names, no graph search at all
  const snake = [
    { name: 'confluence_get_page', inputSchema: { properties: { page_id: {} }, required: ['page_id'] } },
    { name: 'jira_get_issue', inputSchema: { properties: { issue_key: {} }, required: ['issue_key'] } },
    { name: 'jira_create_issue', inputSchema: { properties: { project_key: {}, issue_type: {}, summary: {}, description: { type: 'object' } }, required: ['project_key', 'summary'] } },
    { name: 'jira_search', inputSchema: { properties: { jql: {}, max_results: {} } } }
  ];
  const s = resolveTools(snake);
  check('snake_case: page tool resolved', s.ops['confluence.getPage'].toolName === 'confluence_get_page');
  check('snake_case: page_id arg mapped', s.ops['confluence.getPage'].args.pageId === 'page_id', JSON.stringify(s.ops['confluence.getPage'].args));
  check('snake_case: issue_key arg mapped', s.ops['jira.getIssue'].args.issueKey === 'issue_key');
  check('snake_case: project_key arg mapped', s.ops['jira.createIssue'].args.projectKey === 'project_key');
  check('snake_case: max_results maps to limit', s.ops['jira.search'].args.limit === 'max_results');
  check('snake_case: no cloudId wanted', s.ops['jira.getIssue'].needsCloudId === false);

  const caps = capabilitiesFrom(s);
  check('snake_case: withholds graph.search', !caps.has('graph.search'));
  check('snake_case: withholds jira.update (no edit tool)', !caps.has('jira.update'));
  check('snake_case: still grants jira.create', caps.has('jira.create'));
  check('snake_case: still grants jira.children via search', caps.has('jira.children'));

  // A required argument we cannot supply must withhold the capability rather
  // than let the call fail later against a live tenant.
  const weird = [
    { name: 'jira_create_issue', inputSchema: { properties: { project_key: {}, summary: {}, tenant_secret: {} }, required: ['project_key', 'summary', 'tenant_secret'] } }
  ];
  const w = resolveTools(weird);
  check('unmappable required arg is reported', w.ops['jira.createIssue'].missingArgs.join(',') === 'tenant_secret', w.ops['jira.createIssue'].missingArgs.join(','));
  check('unmappable required arg withholds the capability', !capabilitiesFrom(w).has('jira.create'));

  const empty = resolveTools([]);
  check('an empty server resolves nothing', empty.unresolved.length > 0 && capabilitiesFrom(empty).size === 0);

  // The case the schema tiebreaker exists for: names point the wrong way, and
  // only what each tool *accepts* distinguishes them.
  const misnamed = resolveTools([
    { name: 'search', inputSchema: { properties: { jql: {}, maxResults: {} } } },
    { name: 'rovo_search', inputSchema: { properties: { query: {}, limit: {} } } }
  ]);
  check(
    'misleading names: the tool taking jql becomes jira.search',
    misnamed.ops['jira.search'].toolName === 'search',
    misnamed.ops['jira.search']?.toolName
  );
  check(
    'misleading names: the tool taking query becomes graph.search',
    misnamed.ops['graph.search'].toolName === 'rovo_search',
    misnamed.ops['graph.search']?.toolName
  );

  check('pickArg prefers the earlier pattern', pickArg({ id: {}, page_id: {} }, [/^page_?id$/i, /^id$/i]) === 'page_id');
  check('pickArg returns undefined when absent', pickArg({ foo: {} }, [/^bar$/i]) === undefined);
}

section('Routing: description shape follows the declared schema');
{
  const asString = resolveTools([
    { name: 'createJiraIssue', inputSchema: { properties: { summary: {}, description: { type: 'string' } } } }
  ]);
  const asObject = resolveTools([
    { name: 'createJiraIssue', inputSchema: { properties: { summary: {}, description: { type: 'object' } } } }
  ]);
  const { argType } = createRequire(import.meta.url)(out);
  check('string description => markdown', argType(asString.ops['jira.createIssue'], 'description') === 'string');
  check('object description => ADF', argType(asObject.ops['jira.createIssue'], 'description') === 'object');
}

/* ------------------------------------------------- Anthropic LLM adapter */

section('Anthropic: request shaping');
{
  /** Captures the outgoing request instead of sending it. */
  const stub = (reply) => {
    const seen = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url: String(url), body });
      const payload = typeof reply === 'function' ? reply(body, seen.length) : reply;
      if (payload instanceof Error) throw payload;
      if (payload.__status) {
        return new Response(JSON.stringify({ error: { message: 'boom' } }), {
          status: payload.__status,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    return { fetch, seen };
  };

  const toolUse = (input) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_thing', input }]
  });

  const request = (over = {}) => ({
    messages: [{ role: 'user', content: 'the varying part' }],
    toolName: 'emit_thing',
    toolDescription: 'Emit a thing.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    parse: (raw) => (raw && typeof raw.value === 'string' ? { ok: true, value: raw } : { ok: false, error: 'value must be a string' }),
    justification: 'testing',
    ...over
  });

  {
    const { fetch, seen } = stub(toolUse({ value: 'ok' }));
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch });
    const out = await llm.requestStructured(request());

    check('anthropic: returns the parsed tool input', out.value === 'ok', JSON.stringify(out));
    check('anthropic: forces the tool call', seen[0].body.tool_choice.type === 'tool' && seen[0].body.tool_choice.name === 'emit_thing', JSON.stringify(seen[0].body.tool_choice));
    check('anthropic: sends exactly one tool', seen[0].body.tools.length === 1);
    check('anthropic: passes the schema through untouched', seen[0].body.tools[0].input_schema.required.join() === 'value');
    check('anthropic: makes one request when the first parses', seen.length === 1, String(seen.length));
    check('anthropic: sends no system block without a prefix', seen[0].body.system === undefined);
  }

  {
    // A long shared prefix must travel as a cache block, not inlined — that is
    // the entire reason cachedPrefix exists.
    const long = 'SOURCE '.repeat(1000);
    const { fetch, seen } = stub(toolUse({ value: 'ok' }));
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch });
    await llm.requestStructured(request({ cachedPrefix: long }));

    const sys = seen[0].body.system;
    check('anthropic: a long prefix becomes a system block', Array.isArray(sys) && sys.length === 1, JSON.stringify(sys)?.slice(0, 80));
    check('anthropic: the block is marked cacheable', sys[0].cache_control.type === 'ephemeral', JSON.stringify(sys[0].cache_control));
    check('anthropic: the prefix is not also inlined', !seen[0].body.messages[0].content.includes('SOURCE'), seen[0].body.messages[0].content.slice(0, 60));
    check('anthropic: the varying part still travels', seen[0].body.messages[0].content.includes('the varying part'));
  }

  {
    // Below the minimum, caching costs more than it saves — so the same text is
    // inlined, and the model must still see all of it.
    const short = 'tiny prefix';
    const { fetch, seen } = stub(toolUse({ value: 'ok' }));
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch });
    await llm.requestStructured(request({ cachedPrefix: short }));

    check('anthropic: a short prefix is not cached', seen[0].body.system === undefined);
    check('anthropic: a short prefix is inlined instead of dropped', seen[0].body.messages[0].content.startsWith(short), seen[0].body.messages[0].content.slice(0, 40));
  }

  {
    // The repair path: one retry with the validation error fed back.
    const { fetch, seen } = stub((_body, n) => toolUse(n === 1 ? { value: 42 } : { value: 'fixed' }));
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch });
    const out = await llm.requestStructured(request());

    check('anthropic: repairs one bad payload', out.value === 'fixed', JSON.stringify(out));
    check('anthropic: repairs exactly once', seen.length === 2, String(seen.length));
    check('anthropic: the repair feeds back the validation error', JSON.stringify(seen[1].body.messages).includes('value must be a string'));
  }

  {
    // Two bad payloads is the schema's fault, not the model's; stop paying.
    const { fetch, seen } = stub(toolUse({ value: 42 }));
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch });
    let threw = '';
    try {
      await llm.requestStructured(request());
    } catch (err) {
      threw = err.message;
    }
    check('anthropic: gives up after two bad payloads', /did not match the expected schema, twice/.test(threw), threw);
    check('anthropic: does not keep retrying', seen.length === 2, String(seen.length));
  }

  {
    // A model that answers in prose instead of calling the tool.
    const { fetch } = stub({
      id: 'm', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: 'I would rather not.' }]
    });
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch });
    let threw = '';
    try {
      await llm.requestStructured(request());
    } catch (err) {
      threw = err.message;
    }
    check('anthropic: a prose answer is reported, not parsed', /schema/.test(threw), threw);
  }

  {
    const { fetch, seen } = stub({ __status: 429 });
    const retries = [];
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch, onRetry: (n, ms) => retries.push([n, ms]) });
    let threw = '';
    try {
      await llm.requestStructured(request());
    } catch (err) {
      threw = err.message;
    }
    check('anthropic: a rate limit is retried', seen.length > 1, String(seen.length));
    check('anthropic: retries are announced', retries.length > 0, JSON.stringify(retries));
    check('anthropic: a rate limit ends with an actionable message', /rate limit/i.test(threw), threw);
  }

  {
    const { fetch, seen } = stub({ __status: 400 });
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch });
    let threw = '';
    try {
      await llm.requestStructured(request());
    } catch (err) {
      threw = err.message;
    }
    check('anthropic: a 400 is not retried', seen.length === 1, String(seen.length));
    check('anthropic: a 400 explains itself', /rejected the request/.test(threw), threw);
  }

  {
    let threw = '';
    try {
      new AnthropicLlmAdapter({ apiKey: '' });
    } catch (err) {
      threw = err.message;
    }
    check('anthropic: a missing key fails at construction', /No Anthropic API key/.test(threw), threw);
  }

  {
    const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
    const { fetch, seen } = stub(toolUse({ value: 'ok' }));
    const llm = new AnthropicLlmAdapter({ apiKey: 'k', fetch });
    let threw = '';
    try {
      await llm.requestStructured(request(), token);
    } catch (err) {
      threw = err.message;
    }
    check('anthropic: a cancelled request is not sent', seen.length === 0 && /Cancelled/.test(threw), threw);
  }
}

section('Cached prefix: adapters without caching must inline it');
{
  const msgs = [{ role: 'user', content: 'body' }];
  check('prefix is prepended to the first message', withCachedPrefix(msgs, 'PREFIX')[0].content === 'PREFIX\n\nbody');
  check('no prefix leaves the messages alone', withCachedPrefix(msgs)[0].content === 'body');
  check('an empty prefix leaves the messages alone', withCachedPrefix(msgs, '')[0].content === 'body');
  check(
    'only the first message is touched',
    withCachedPrefix([...msgs, { role: 'assistant', content: 'reply' }], 'P')[1].content === 'reply'
  );
  check('a prefix with no messages still travels', withCachedPrefix([], 'P')[0].content === 'P');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
