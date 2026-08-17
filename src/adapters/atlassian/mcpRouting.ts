/**
 * MCP tool resolution — pure, so it can be tested without a server.
 *
 * An MCP server is discovered, not hardcoded. Tool names drift between server
 * versions (`getConfluencePage` vs `confluence_get_page` vs `get-page`) and
 * self-hosted servers rename freely, so this module matches the *domain
 * operations* ReqForge needs against whatever the server advertises, and pulls
 * each call's argument names out of the tool's own declared inputSchema.
 *
 * What is not resolved is not faked: the adapter drops the corresponding
 * Capability, and the pipelines already degrade on a missing capability.
 */

/** The domain operations AtlassianPort needs a tool for. */
export type McpOp =
  | 'confluence.getPage'
  | 'jira.listProjects'
  | 'jira.listIssueTypes'
  | 'jira.getIssue'
  | 'jira.createIssue'
  | 'jira.updateIssue'
  | 'jira.search'
  | 'graph.search'
  | 'meta.resources'
  | 'meta.userInfo';

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

/**
 * Candidate name patterns per operation, most specific first. Ordering is the
 * whole point: `getJiraIssue` and `searchJiraIssuesUsingJql` both contain
 * "jira" and "issue", so the search patterns must not win the getIssue slot.
 */
const OP_PATTERNS: Record<McpOp, RegExp[]> = {
  'confluence.getPage': [
    /^getConfluencePage$/i,
    /confluence.*(get|read|fetch).*page/i,
    /(get|read|fetch).*confluence.*page/i,
    /^(get|read)_?page$/i
  ],
  'jira.listProjects': [
    /^getVisibleJiraProjects$/i,
    /jira.*(list|get|visible|all).*projects?/i,
    /(list|get).*projects?/i
  ],
  'jira.listIssueTypes': [
    /^getJiraProjectIssueTypesMetadata$/i,
    /issue.?types?.*meta/i,
    /jira.*issue.?types?/i,
    /(list|get).*issue.?types?/i
  ],
  'jira.getIssue': [
    /^getJiraIssue$/i,
    /^jira_?get_?issue$/i,
    /^(get|read|fetch)_?jira_?issue$/i,
    /jira.*(get|read|fetch).*issue(?!s)/i
  ],
  'jira.createIssue': [
    /^createJiraIssue$/i,
    /^jira_?create_?issue$/i,
    /(create|add|new).*jira.*issue/i,
    /jira.*(create|add).*issue/i
  ],
  'jira.updateIssue': [
    /^editJiraIssue$/i,
    /^jira_?(update|edit)_?issue$/i,
    /(edit|update|patch).*jira.*issue/i,
    /jira.*(edit|update|patch).*issue/i
  ],
  'jira.search': [
    /^searchJiraIssuesUsingJql$/i,
    /jql/i,
    /jira.*search/i,
    /search.*jira/i,
    /search.*issues?/i
  ],
  /**
   * Teamwork Graph retrieval. Atlassian's remote server has shipped this as a
   * bare `search` and under Rovo naming; self-hosted servers use neither. The
   * bare-`search` pattern is last so it cannot outrank a JQL tool, and the
   * ordering in `resolveTools` puts jira.search ahead of this operation.
   */
  'graph.search': [/rovo/i, /teamwork.?graph/i, /semantic/i, /natural.?language.*search/i],
  'meta.resources': [/accessible.*resources/i, /cloud.?id/i, /^getAccessibleAtlassianResources$/i],
  'meta.userInfo': [/^atlassianUserInfo$/i, /user.?info/i, /(current|my).*user/i, /whoami/i]
};

/**
 * Argument-name candidates per operation, matched against the tool's declared
 * schema properties. A server that names a field we cannot find still works if
 * that field is optional; if it is required, `missingArgs` reports it rather
 * than the call failing later with a server-side validation error.
 */
const ARG_PATTERNS: Partial<Record<McpOp, Record<string, RegExp[]>>> = {
  'confluence.getPage': { pageId: [/^page_?id$/i, /^id$/i, /page/i] },
  'jira.listIssueTypes': { projectKey: [/^project_?(id_?or_?)?key$/i, /^project$/i, /project/i] },
  'jira.getIssue': { issueKey: [/^issue_?(id_?or_?)?key$/i, /^issue$/i, /^key$/i, /issue/i] },
  'jira.createIssue': {
    projectKey: [/^project_?(id_?or_?)?key$/i, /^project$/i, /project/i],
    issueTypeName: [/^issue_?type_?name$/i, /^issue_?type$/i, /type/i],
    summary: [/^summary$/i, /^title$/i],
    description: [/^description$/i, /^body$/i],
    labels: [/^labels$/i],
    parentKey: [/^parent_?(id_?or_?)?key$/i, /^parent$/i]
  },
  'jira.updateIssue': {
    issueKey: [/^issue_?(id_?or_?)?key$/i, /^issue$/i, /^key$/i],
    fields: [/^fields$/i, /^update$/i],
    summary: [/^summary$/i, /^title$/i],
    description: [/^description$/i, /^body$/i],
    labels: [/^labels$/i]
  },
  'jira.search': {
    jql: [/^jql$/i, /query/i],
    limit: [/^max_?results$/i, /^limit$/i, /^max$/i],
    fields: [/^fields$/i]
  },
  'graph.search': {
    query: [/^query$/i, /^q$/i, /^text$/i, /^prompt$/i, /search/i],
    limit: [/^limit$/i, /^max_?results$/i, /^max$/i, /count/i],
    products: [/^products?$/i, /^sources?$/i, /^entit(y|ies)_?types?$/i]
  }
};

/** Every operation whose tool takes a cloudId gets it injected automatically. */
export const CLOUD_ID_PATTERNS = [/^cloud_?id$/i, /^site_?id$/i];

export interface ResolvedOp {
  op: McpOp;
  toolName: string;
  /** Domain arg name -> the server's own property name. */
  args: Record<string, string>;
  /** Required schema properties we could not map to anything we know how to supply. */
  missingArgs: string[];
  /** True when the tool declares a cloudId-shaped property. */
  needsCloudId: boolean;
  /** The server's own property name for cloudId, when it wants one. */
  cloudIdArg?: string;
  /** Kept so the adapter can consult declared property types — see `argType`. */
  schema?: DiscoveredTool['inputSchema'];
}

/**
 * The declared JSON-Schema `type` of one of the server's properties.
 *
 * Used to decide payload shape rather than guessing: a `description` declared
 * as a string wants markdown, one declared as an object wants ADF. Servers
 * differ on this and both are in the wild.
 */
export function argType(resolved: ResolvedOp | undefined, domainName: string): string | undefined {
  const prop = resolved?.args[domainName];
  if (!prop) return undefined;
  const schema = resolved?.schema?.properties?.[prop] as { type?: string } | undefined;
  return schema?.type;
}

export interface Routing {
  ops: Partial<Record<McpOp, ResolvedOp>>;
  unresolved: McpOp[];
  /** Tools the server offers that we made no use of — useful in diagnostics. */
  unused: string[];
}

/** Does the tool declare a JQL-shaped argument? The strongest available signal. */
const declaresJql = (t: DiscoveredTool): boolean =>
  Object.keys(t.inputSchema?.properties ?? {}).some((p) => /^jql$/i.test(p));

/**
 * Schema-based tiebreakers, applied before name matching decides.
 *
 * Names are a weak signal for the two search tools in particular: a server can
 * call its JQL tool `search` and its graph tool `rovo_search`, which the name
 * patterns alone would get exactly backwards. What a tool *accepts* is much
 * harder to be wrong about — a JQL tool takes `jql` and a graph tool does not.
 */
const OP_PREFER: Partial<Record<McpOp, (t: DiscoveredTool) => boolean>> = {
  'jira.search': declaresJql,
  'graph.search': (t) => !declaresJql(t)
};

/**
 * Names too ambiguous to trust on their own. A bare `search` is either the JQL
 * tool or the graph tool depending on the server, so it is only ever accepted
 * when the schema tiebreaker agrees — never on the name alone.
 */
const OP_WEAK_PATTERNS: Partial<Record<McpOp, RegExp[]>> = {
  'jira.search': [/^search$/i],
  'graph.search': [/^search(_?atlassian)?$/i, /^atlassian_?search$/i]
};

function firstMatch(
  tools: DiscoveredTool[],
  patterns: RegExp[],
  taken: Set<string>,
  prefer?: (t: DiscoveredTool) => boolean,
  weak: RegExp[] = []
): DiscoveredTool | undefined {
  const find = (list: RegExp[], filter?: (t: DiscoveredTool) => boolean) => {
    for (const pattern of list) {
      const hit = tools.find((t) => !taken.has(t.name) && pattern.test(t.name) && (!filter || filter(t)));
      if (hit) return hit;
    }
    return undefined;
  };

  // Schema agreement outranks a confident name: a tool that accepts `jql` is
  // the JQL tool whatever it happens to be called.
  return find(patterns, prefer) ?? (prefer ? find(weak, prefer) : undefined) ?? find(patterns);
}

/** Finds the server's property name for one of our domain arguments. */
export function pickArg(
  props: Record<string, unknown> | undefined,
  patterns: RegExp[]
): string | undefined {
  if (!props) return undefined;
  const names = Object.keys(props);
  for (const pattern of patterns) {
    const hit = names.find((n) => pattern.test(n));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Matches discovered tools to domain operations.
 *
 * Resolution order matters and is not the order of the type union: the
 * narrowest operations claim their tool first so a greedy pattern later cannot
 * steal it. Each tool is claimed at most once.
 */
export function resolveTools(tools: DiscoveredTool[]): Routing {
  const ORDER: McpOp[] = [
    'confluence.getPage',
    'jira.search', // before getIssue: "searchJiraIssuesUsingJql" must not land in the getIssue slot
    'jira.createIssue',
    'jira.updateIssue',
    'jira.getIssue',
    'jira.listIssueTypes',
    'jira.listProjects',
    'graph.search', // after jira.search, so a bare `search` tool loses the JQL slot only if nothing better exists
    'meta.resources',
    'meta.userInfo'
  ];

  const taken = new Set<string>();
  const ops: Partial<Record<McpOp, ResolvedOp>> = {};
  const unresolved: McpOp[] = [];

  for (const op of ORDER) {
    const tool = firstMatch(tools, OP_PATTERNS[op], taken, OP_PREFER[op], OP_WEAK_PATTERNS[op]);
    if (!tool) {
      unresolved.push(op);
      continue;
    }
    taken.add(tool.name);

    const props = tool.inputSchema?.properties;
    const wanted = ARG_PATTERNS[op] ?? {};
    const args: Record<string, string> = {};
    for (const [domainName, patterns] of Object.entries(wanted)) {
      const found = pickArg(props, patterns);
      if (found) args[domainName] = found;
    }

    const needsCloudId = pickArg(props, CLOUD_ID_PATTERNS) !== undefined;
    const cloudIdProp = pickArg(props, CLOUD_ID_PATTERNS);
    const mapped = new Set(Object.values(args));
    if (cloudIdProp) mapped.add(cloudIdProp);

    const missingArgs = (tool.inputSchema?.required ?? []).filter((r) => !mapped.has(r));

    ops[op] = {
      op,
      toolName: tool.name,
      args,
      missingArgs,
      needsCloudId,
      cloudIdArg: cloudIdProp,
      schema: tool.inputSchema
    };
  }

  return { ops, unresolved, unused: tools.filter((t) => !taken.has(t.name)).map((t) => t.name) };
}

/** Which Capability each operation unlocks. Unresolved op -> capability withheld. */
const CAPABILITY_REQUIREMENTS: Record<string, McpOp[]> = {
  'confluence.read': ['confluence.getPage'],
  'jira.read': ['jira.getIssue'],
  'jira.create': ['jira.createIssue'],
  'jira.update': ['jira.updateIssue'],
  'jira.search': ['jira.search'],
  'jira.createmeta': ['jira.listIssueTypes'],
  // Children are fetched with a `parent = KEY` JQL search, not a dedicated tool.
  'jira.children': ['jira.search'],
  'graph.search': ['graph.search']
};

export function capabilitiesFrom(routing: Routing): Set<string> {
  const out = new Set<string>();
  for (const [capability, required] of Object.entries(CAPABILITY_REQUIREMENTS)) {
    const usable = required.every((op) => {
      const resolved = routing.ops[op];
      return resolved !== undefined && resolved.missingArgs.length === 0;
    });
    if (usable) out.add(capability);
  }
  return out;
}

/** One-line-per-operation report, surfaced in the connection check. */
export function describeRouting(routing: Routing): string {
  const lines = Object.values(routing.ops).map((r) => {
    const flags = [
      r.needsCloudId ? 'cloudId' : '',
      r.missingArgs.length ? `unmapped required: ${r.missingArgs.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('; ');
    return `  ${r.op} -> ${r.toolName}${flags ? ` (${flags})` : ''}`;
  });
  if (routing.unresolved.length) lines.push(`  unresolved: ${routing.unresolved.join(', ')}`);
  return lines.join('\n');
}
