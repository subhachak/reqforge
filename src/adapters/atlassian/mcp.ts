import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
  AtlassianError,
  type AtlassianPort,
  type Capability,
  type IssueDetail,
  type IssuePatch,
  type IssueRef,
  type IssueTypeRef,
  type NewIssue,
  type PageDoc,
  type ProjectRef,
  type SearchHit,
  type SearchOptions
} from '../../core/ports';
import { adfToMarkdown, markdownToAdf } from './adf';
import { storageToMarkdown } from './storageFormat';
import {
  argType,
  capabilitiesFrom,
  describeRouting,
  resolveTools,
  type McpOp,
  type ResolvedOp,
  type Routing
} from './mcpRouting';

export interface McpOptions {
  /**
   * Either an http(s) URL for a remote server, or a command line for a stdio
   * server (`npx -y mcp-remote https://mcp.atlassian.com/v1/sse`). The stdio
   * form is how OAuth normally gets handled — the proxy owns the browser flow,
   * so no Atlassian credentials pass through this process.
   */
  endpoint: string;
  /** Used to pick the right site when the server exposes several. */
  baseUrl: string;
  /** Extra headers for the http transports, e.g. a bearer token. */
  headers?: Record<string, string>;
  /** Injected by the contract tests to run against an in-memory server. */
  transportFactory?: () => Transport;
}

const CLIENT_INFO = { name: 'reqforge', version: '0.1.0' };

/**
 * Atlassian MCP adapter.
 *
 * Nothing about the server is assumed: tools are discovered at connect time and
 * matched to domain operations by `mcpRouting`, capabilities are derived from
 * what actually resolved, and anything unresolved is withheld rather than
 * faked. The payoff over REST is `graph.search` — Teamwork Graph retrieval,
 * which has no REST equivalent.
 */
export class AtlassianMcpAdapter implements AtlassianPort {
  readonly kind = 'mcp' as const;

  private client?: Client;
  private routing?: Routing;
  private caps: ReadonlySet<Capability> = new Set();
  private cloudId?: string;
  private connecting?: Promise<void>;
  private readonly typeCache = new Map<string, IssueTypeRef[]>();

  constructor(private readonly opts: McpOptions) {
    if (!opts.endpoint && !opts.transportFactory) {
      throw new AtlassianError('reqforge.atlassian.mcpEndpoint is not set.');
    }
  }

  /**
   * Empty until the first call completes. Callers that gate on a capability
   * must `await verifyConnection()` (or any other call) first; the panel does
   * this during its startup check.
   */
  capabilities(): ReadonlySet<Capability> {
    return this.caps;
  }

  /* --------------------------------------------------------------- plumbing */

  private makeTransport(): Transport {
    if (this.opts.transportFactory) return this.opts.transportFactory();

    const endpoint = this.opts.endpoint.trim();
    if (/^https?:\/\//i.test(endpoint)) {
      const url = new URL(endpoint);
      const init = this.opts.headers ? { requestInit: { headers: this.opts.headers } } : undefined;
      // SSE is the older Atlassian shape and is still what /v1/sse speaks;
      // streamable HTTP is the current spec. Pick by path rather than trying
      // one and reconnecting, which doubles the handshake on every start.
      return /\/sse\b/i.test(url.pathname)
        ? new SSEClientTransport(url, init)
        : new StreamableHTTPClientTransport(url, init);
    }

    const parts = endpoint.replace(/^stdio:/, '').trim().split(/\s+/);
    const command = parts.shift();
    if (!command) throw new AtlassianError(`Could not read a command from mcpEndpoint: "${endpoint}"`);
    return new StdioClientTransport({ command, args: parts });
  }

  /** Idempotent and concurrency-safe: parallel agents share one handshake. */
  private async connect(): Promise<void> {
    if (this.client && this.routing) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      try {
        await client.connect(this.makeTransport());
      } catch (err) {
        throw new AtlassianError(
          `Could not connect to the MCP server at "${this.opts.endpoint}": ${(err as Error).message}`
        );
      }

      const listed = await client.listTools();
      const routing = resolveTools(
        listed.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
        }))
      );

      this.client = client;
      this.routing = routing;
      this.caps = capabilitiesFrom(routing) as ReadonlySet<Capability>;
      await this.resolveCloudId();
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /**
   * Most Atlassian tools are site-scoped. The site is resolved from the
   * configured baseUrl rather than assuming the first one, since an account
   * with several sites would otherwise write to whichever came back first.
   */
  private async resolveCloudId(): Promise<void> {
    const op = this.routing?.ops['meta.resources'];
    if (!op) return;

    const raw = await this.rawCall(op, {});
    const list = asArray(raw);
    if (list.length === 0) return;

    const host = safeHost(this.opts.baseUrl);
    const match =
      list.find((r) => host && typeof r.url === 'string' && safeHost(r.url) === host) ??
      (list.length === 1 ? list[0] : undefined);

    if (!match) {
      const sites = list.map((r) => String(r.url ?? r.name ?? r.id)).join(', ');
      throw new AtlassianError(
        `The MCP server offers several Atlassian sites (${sites}) and none matches reqforge.atlassian.baseUrl (${this.opts.baseUrl}). Set baseUrl to the site you want.`
      );
    }
    this.cloudId = String(match.id ?? match.cloudId ?? '');
  }

  private op(name: McpOp): ResolvedOp {
    const resolved = this.routing?.ops[name];
    if (!resolved) {
      throw new AtlassianError(
        `The MCP server at "${this.opts.endpoint}" exposes no tool for ${name}. Open ReqForge settings and press "Test connections" to see what it does expose.`
      );
    }
    return resolved;
  }

  private async rawCall(op: ResolvedOp, domainArgs: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new AtlassianError('MCP client is not connected.');

    const args: Record<string, unknown> = {};
    for (const [domainName, value] of Object.entries(domainArgs)) {
      if (value === undefined) continue;
      const serverName = op.args[domainName];
      // Silently dropping an argument the server does not accept beats a
      // hard failure: an unsupported `limit` should not stop a search.
      if (serverName) args[serverName] = value;
    }
    if (op.needsCloudId && op.cloudIdArg && this.cloudId) args[op.cloudIdArg] = this.cloudId;

    let result;
    try {
      result = await this.client.callTool({ name: op.toolName, arguments: args });
    } catch (err) {
      throw new AtlassianError(`MCP tool "${op.toolName}" failed: ${(err as Error).message}`);
    }
    return unwrap(result, op.toolName);
  }

  private async call(name: McpOp, domainArgs: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return this.rawCall(this.op(name), domainArgs);
  }

  /* ----------------------------------------------------------------- reads */

  async verifyConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.connect();
      const routing = this.routing!;
      const resolved = Object.keys(routing.ops).length;
      const total = resolved + routing.unresolved.length;

      let who = '';
      if (routing.ops['meta.userInfo']) {
        try {
          const info = asRecord(await this.rawCall(routing.ops['meta.userInfo'], {}));
          who = String(info.email ?? info.displayName ?? info.name ?? '');
        } catch {
          // A server that cannot say who we are is still usable.
        }
      }

      const graph = this.caps.has('graph.search') ? 'Teamwork Graph search available' : 'no Teamwork Graph search';
      return {
        ok: true,
        detail:
          `MCP connected${who ? ` as ${who}` : ''} — ${resolved}/${total} operations resolved, ${graph}.\n` +
          describeRouting(routing)
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async getConfluencePage(idOrUrl: string): Promise<PageDoc> {
    const pageId = extractPageId(idOrUrl);
    const page = asRecord(await this.call('confluence.getPage', { pageId }));
    const body = asRecord(page.body);

    // Servers return storage format, ADF, or already-converted markdown
    // depending on version. All three are in the wild.
    const storage = asRecord(body.storage).value ?? asRecord(body.view).value;
    const adf = body.atlas_doc_format ?? asRecord(body.atlas_doc_format).value;
    let markdown = '';
    if (typeof storage === 'string') markdown = storageToMarkdown(storage);
    else if (adf && typeof adf === 'object') markdown = adfToMarkdown(adf);
    else markdown = String(page.markdown ?? page.text ?? body.value ?? '');

    const id = String(page.id ?? pageId);
    return {
      id,
      title: String(page.title ?? ''),
      spaceKey: str(page.spaceKey) ?? str(asRecord(page.space).key),
      version: numberOr(asRecord(page.version).number),
      webUrl: str(page.url) ?? str(page._links && asRecord(page._links).webui) ?? `${this.opts.baseUrl}/wiki/pages/${id}`,
      markdown
    };
  }

  async listProjects(): Promise<ProjectRef[]> {
    const raw = await this.call('jira.listProjects', {});
    return asArray(raw).map((p) => ({
      id: String(p.id ?? ''),
      key: String(p.key ?? ''),
      name: String(p.name ?? p.key ?? '')
    }));
  }

  async listIssueTypes(projectKey: string): Promise<IssueTypeRef[]> {
    const cached = this.typeCache.get(projectKey);
    if (cached) return cached;

    const raw = await this.call('jira.listIssueTypes', { projectKey });
    const types = asArray(raw).map((t) => ({
      id: String(t.id ?? ''),
      name: String(t.name ?? ''),
      subtask: Boolean(t.subtask ?? t.hierarchyLevel === -1)
    }));
    this.typeCache.set(projectKey, types);
    return types;
  }

  /**
   * Not implemented yet, so a create that hits a mandatory custom field fails
   * at create time with Jira's own message rather than being caught in the
   * plan.
   *
   * This is a gap, not a limitation: Atlassian's server does expose
   * `getJiraIssueTypeMetaWithFields`, verified against a live tenant with
   * scripts/probeMcp.mjs. Wiring it would need a second routed operation and
   * an issue-type id, which `listIssueTypes` already returns.
   */
  async requiredFields(): Promise<string[]> {
    return [];
  }

  async getIssue(key: string): Promise<IssueDetail> {
    const raw = asRecord(await this.call('jira.getIssue', { issueKey: key }));
    return this.toIssueDetail(raw);
  }

  async searchIssues(jql: string, max = 50): Promise<IssueRef[]> {
    const details = await this.searchIssueDetails(jql, max);
    return details.map(({ key, id, url }) => ({ key, id, url }));
  }

  async searchIssueDetails(jql: string, max = 100): Promise<IssueDetail[]> {
    const raw = await this.call('jira.search', {
      jql,
      limit: max,
      fields: ['summary', 'description', 'issuetype', 'status', 'labels', 'parent']
    });
    const record = asRecord(raw);
    const issues = Array.isArray(record.issues) ? record.issues : asArray(raw);
    return issues.map((i) => this.toIssueDetail(asRecord(i)));
  }

  async semanticSearch(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    await this.connect();
    if (!this.caps.has('graph.search')) {
      throw new AtlassianError(
        'This MCP server exposes no Teamwork Graph search tool. Open ReqForge settings and press "Test connections" to see what it does expose.'
      );
    }
    const raw = await this.rawCall(this.op('graph.search'), {
      query,
      limit: opts.limit ?? 10,
      products: opts.products
    });

    const record = asRecord(raw);
    const rows = Array.isArray(record.results)
      ? record.results
      : Array.isArray(record.hits)
        ? record.hits
        : asArray(raw);

    return rows.map((r) => {
      const row = asRecord(r);
      const url = str(row.url) ?? str(asRecord(row._links).webui);
      return {
        id: String(row.id ?? row.key ?? row.ari ?? ''),
        title: String(row.title ?? row.summary ?? row.name ?? ''),
        product: String(row.product ?? row.source ?? guessProduct(url, String(row.key ?? ''))),
        entityType: str(row.type) ?? str(row.entityType) ?? str(asRecord(row.issuetype).name),
        url,
        excerpt: str(row.excerpt) ?? str(row.snippet) ?? str(row.description) ?? str(row.text),
        score: numberOr(row.score ?? row.relevance)
      };
    });
  }

  /* ---------------------------------------------------------------- writes */

  async createIssue(input: NewIssue): Promise<IssueRef> {
    await this.connect();
    const op = this.op('jira.createIssue');

    // Whether the description travels as markdown or ADF is read off the
    // server's own schema rather than guessed; both shapes are in the wild.
    const wantsAdf = argType(op, 'description') === 'object';
    const raw = asRecord(
      await this.rawCall(op, {
        projectKey: input.projectKey,
        issueTypeName: input.issueTypeName,
        summary: input.summary.slice(0, 255),
        description: wantsAdf ? markdownToAdf(input.descriptionMarkdown) : input.descriptionMarkdown,
        labels: input.labels?.length ? input.labels : undefined,
        parentKey: input.parentKey
      })
    );

    const issue = asRecord(raw.issue ?? raw);
    const key = String(issue.key ?? '');
    if (!key) {
      throw new AtlassianError(`MCP tool "${op.toolName}" returned no issue key: ${JSON.stringify(raw).slice(0, 300)}`);
    }
    return {
      key,
      id: String(issue.id ?? ''),
      url: str(issue.url) ?? str(asRecord(issue.self).href) ?? `${this.opts.baseUrl}/browse/${key}`
    };
  }

  async updateIssue(key: string, patch: IssuePatch): Promise<void> {
    await this.connect();
    const op = this.op('jira.updateIssue');
    const wantsAdf = argType(op, 'description') === 'object';

    // The edit tools take a whole `fields` object and have no equivalent of
    // REST's add/remove label operations. Read-merge-write is the only way to
    // avoid destroying labels somebody applied in Jira by hand — it races with
    // a concurrent editor, which the REST path does not, so it is only done
    // when there are label changes to apply.
    let labels = patch.labels;
    if (patch.addLabels?.length || patch.removeLabels?.length) {
      const current = new Set((await this.getIssue(key)).labels);
      for (const l of patch.addLabels ?? []) current.add(l);
      for (const l of patch.removeLabels ?? []) current.delete(l);
      labels = [...current];
    }

    const fields: Record<string, unknown> = {};
    if (patch.summary !== undefined) fields.summary = patch.summary.slice(0, 255);
    if (patch.descriptionMarkdown !== undefined) {
      fields.description = wantsAdf ? markdownToAdf(patch.descriptionMarkdown) : patch.descriptionMarkdown;
    }
    if (labels !== undefined) fields.labels = labels;
    if (Object.keys(fields).length === 0) return;

    // Some servers take a `fields` object; others take flattened arguments.
    // Send whichever the schema declares.
    if (op.args.fields) {
      await this.rawCall(op, { issueKey: key, fields });
    } else {
      await this.rawCall(op, {
        issueKey: key,
        summary: fields.summary,
        description: fields.description,
        labels: fields.labels
      });
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.routing = undefined;
  }

  /* ------------------------------------------------------------ normalizing */

  private toIssueDetail(raw: Record<string, unknown>): IssueDetail {
    const fields = asRecord(raw.fields ?? raw);
    const key = String(raw.key ?? fields.key ?? '');
    const description = fields.description;

    return {
      key,
      id: String(raw.id ?? fields.id ?? ''),
      url: str(raw.url) ?? `${this.opts.baseUrl}/browse/${key}`,
      summary: String(fields.summary ?? ''),
      description:
        typeof description === 'string'
          ? description
          : description && typeof description === 'object'
            ? adfToMarkdown(description)
            : '',
      issueType: String(asRecord(fields.issuetype).name ?? fields.issueType ?? ''),
      status: String(asRecord(fields.status).name ?? fields.status ?? ''),
      labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
      parentKey: str(asRecord(fields.parent).key) ?? str(fields.parentKey)
    };
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * MCP results are content blocks, not JSON. Prefer `structuredContent` when the
 * server sends it; otherwise take the text and parse it if it parses.
 */
function unwrap(result: unknown, toolName: string): unknown {
  const r = asRecord(result);
  const text = Array.isArray(r.content)
    ? r.content
        .filter((c) => asRecord(c).type === 'text')
        .map((c) => String(asRecord(c).text ?? ''))
        .join('\n')
    : '';

  if (r.isError) {
    throw new AtlassianError(`MCP tool "${toolName}" returned an error: ${text || 'no detail'}`);
  }
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Tolerates the several shapes servers use for a list: bare, or wrapped. */
function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const r = asRecord(value);
  for (const key of ['values', 'results', 'items', 'issues', 'projects', 'data']) {
    if (Array.isArray(r[key])) return (r[key] as unknown[]).map(asRecord);
  }
  return [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function guessProduct(url: string | undefined, key: string): string {
  if (url?.includes('/wiki/')) return 'confluence';
  if (url?.includes('/browse/') || /^[A-Z][A-Z0-9]+-\d+$/.test(key)) return 'jira';
  return 'unknown';
}

/** Same page-id shapes the REST adapter accepts, kept in step deliberately. */
function extractPageId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match =
    trimmed.match(/\/pages\/(\d+)/) ?? trimmed.match(/pageId=(\d+)/) ?? trimmed.match(/\/content\/(\d+)/);
  if (match) return match[1];
  throw new AtlassianError(`Could not find a Confluence page id in "${idOrUrl}".`);
}
