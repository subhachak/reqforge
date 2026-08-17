/**
 * The AtlassianPort contract, and the fake tenant both adapters run against.
 *
 * A module rather than a script, because two runners need it: contract.mjs
 * exercises the REST adapter (both profiles have it) and contract.full.mjs
 * exercises the MCP adapter (only the full profile does). Keeping the tenant
 * and the assertions here is what makes "same suite, two adapters" true rather
 * than two suites that drifted apart.
 *
 * Imports nothing profile-specific, so it is copied into the exported
 * restricted repo unchanged.
 */

/** Counts assertions for a runner and prints them as they go. */
export function createChecker() {
  const state = { pass: 0, fail: 0 };
  const check = (name, cond, detail = '') => {
    if (cond) {
      state.pass++;
      console.log(`  ok   ${name}`);
    } else {
      state.fail++;
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };
  const section = (name) => console.log(`\n${name}`);
  const summary = () => {
    console.log(`\n${state.pass} passed, ${state.fail} failed`);
    return state.fail === 0 ? 0 : 1;
  };
  return { check, section, summary, state };
}

/* ------------------------------------------------------------ fake tenant */

export const BASE = 'https://example.atlassian.net';
export const CLOUD_ID = 'cloud-abc-123';

/** Rebuilt for each adapter so writes from one run cannot leak into the next. */
export function newTenant() {
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
export function runJql(tenant, jql) {
  const all = Object.values(tenant.issues);
  const parent = /parent\s*=\s*"?([A-Z]+-\d+)"?/i.exec(jql);
  if (parent) return all.filter((i) => i.parentKey === parent[1]);
  const label = /labels?\s*(?:=|in)\s*\(?"?([\w-]+)"?\)?/i.exec(jql);
  if (label) return all.filter((i) => i.labels.includes(label[1]));
  return all;
}

/* --------------------------------------------------- REST backend (fetch) */

export function installFetchStub(tenant) {
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

export function toRestIssue(i) {
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
export function mdToAdfish(markdown) {
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

export function adfText(adf) {
  if (typeof adf === 'string') return adf;
  const walk = (node) => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    const inner = (node.content ?? []).map(walk).join('');
    return node.type === 'paragraph' ? `${inner}\n\n` : inner;
  };
  return (adf?.content ?? []).map(walk).join('').trim();
}

export function applyRestPatch(issue, body) {
  const f = body.fields ?? {};
  if (f.summary !== undefined) issue.summary = f.summary;
  if (f.description !== undefined) issue.descriptionMarkdown = adfText(f.description);
  if (f.labels !== undefined) issue.labels = f.labels;
  for (const op of body.update?.labels ?? []) {
    if (op.add && !issue.labels.includes(op.add)) issue.labels.push(op.add);
    if (op.remove) issue.labels = issue.labels.filter((l) => l !== op.remove);
  }
}

/* ------------------------------------------------------- the shared suite */

/** Every assertion here must hold for any AtlassianPort implementation. */
export async function runContract({ check, section }, label, port, tenant) {
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
