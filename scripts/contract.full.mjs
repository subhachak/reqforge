/**
 * Contract tests for the full profile: the MCP adapter and the Anthropic
 * provider.
 *
 * The MCP adapter runs the SAME suite as REST, from contractShared.mjs, against
 * a real in-process MCP server on the SDK's in-memory transport and the same
 * fake tenant. Any difference in the domain objects that come out is a genuine
 * divergence between the adapters rather than a difference in fixtures.
 *
 *   node scripts/contract.full.mjs
 */
import * as esbuild from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  BASE,
  CLOUD_ID,
  createChecker,
  newTenant,
  runContract,
  runJql,
  toRestIssue,
  adfText
} from './contractShared.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'reqforge-contract-full-'));
const entry = path.join(dir, 'entry.mjs');

writeFileSync(
  entry,
  `
export { AtlassianMcpAdapter } from '${path.resolve('src/adapters/atlassian/mcp.ts')}';
export { resolveTools, capabilitiesFrom, pickArg, argType } from '${path.resolve('src/adapters/atlassian/mcpRouting.ts')}';
export { AnthropicLlmAdapter } from '${path.resolve('src/adapters/llm/anthropic.ts')}';
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
export { z } from 'zod';
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
  nodePaths: [path.resolve('node_modules')],
  logLevel: 'warning'
});

const {
  AtlassianMcpAdapter,
  resolveTools,
  capabilitiesFrom,
  pickArg,
  argType,
  AnthropicLlmAdapter,
  McpServer,
  InMemoryTransport,
  z
} = createRequire(import.meta.url)(out);

const { check, section, summary } = createChecker();

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

{
  const tenant = newTenant();
  const { adapter, server } = await connectedMcpAdapter(tenant);
  try {
    await runContract({ check, section }, 'mcp', adapter, tenant);

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

process.exit(summary());
