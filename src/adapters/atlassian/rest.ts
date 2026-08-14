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
  type ProjectRef
} from '../../core/ports';
import { adfToMarkdown, markdownToAdf } from './adf';
import { storageToMarkdown } from './storageFormat';

export interface RestCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'confluence.read',
  'jira.read',
  'jira.create',
  'jira.update',
  'jira.search',
  'jira.createmeta'
]);

/**
 * Atlassian Cloud REST adapter.
 *   Confluence: REST v2  (/wiki/api/v2)
 *   Jira:       REST v3  (/rest/api/3) — descriptions are ADF, not strings.
 */
export class AtlassianRestAdapter implements AtlassianPort {
  readonly kind = 'rest' as const;

  private readonly base: string;
  private readonly authHeader: string;
  private readonly typeCache = new Map<string, IssueTypeRef[]>();

  constructor(creds: RestCredentials) {
    if (!creds.baseUrl) throw new AtlassianError('reqforge.atlassian.baseUrl is not set.');
    if (!creds.email) throw new AtlassianError('reqforge.atlassian.email is not set.');
    if (!creds.apiToken) throw new AtlassianError('No API token stored. Run "ReqForge: Set Atlassian API Token".');
    this.base = creds.baseUrl.replace(/\/+$/, '');
    this.authHeader = 'Basic ' + Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64');
  }

  capabilities(): ReadonlySet<Capability> {
    return CAPABILITIES;
  }

  /* --------------------------------------------------------------- plumbing */

  private async call<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {})
      }
    });

    // Atlassian rate limits aggressively on trial and small tenants.
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
      await new Promise((r) => setTimeout(r, Math.min(30_000, retryAfter * 1000)));
      return this.call<T>(path, init, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AtlassianError(explain(res.status, path, body), res.status, body);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async verifyConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      const me = await this.call<{ displayName: string; emailAddress?: string }>('/rest/api/3/myself');
      return { ok: true, detail: `authenticated as ${me.displayName}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /* ------------------------------------------------------------- confluence */

  async getConfluencePage(idOrUrl: string): Promise<PageDoc> {
    const id = extractPageId(idOrUrl);
    const page = await this.call<{
      id: string;
      title: string;
      version?: { number: number };
      body?: { storage?: { value: string } };
      _links?: { webui?: string };
    }>(`/wiki/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`);

    const storage = page.body?.storage?.value ?? '';
    return {
      id: page.id,
      title: page.title,
      version: page.version?.number,
      webUrl: page._links?.webui ? `${this.base}/wiki${page._links.webui}` : `${this.base}/wiki/pages/${page.id}`,
      markdown: storageToMarkdown(storage)
    };
  }

  /* -------------------------------------------------------------- jira read */

  async listProjects(): Promise<ProjectRef[]> {
    const res = await this.call<{ values: { id: string; key: string; name: string }[] }>(
      '/rest/api/3/project/search?maxResults=100'
    );
    return res.values.map((p) => ({ id: p.id, key: p.key, name: p.name }));
  }

  async listIssueTypes(projectKey: string): Promise<IssueTypeRef[]> {
    const cached = this.typeCache.get(projectKey);
    if (cached) return cached;

    const res = await this.call<{ issueTypes: { id: string; name: string; subtask: boolean }[] }>(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`
    ).catch(async () =>
      // Older tenants expose this shape instead.
      this.call<{ values: { id: string; name: string; subtask: boolean }[] }>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`
      ).then((r) => ({ issueTypes: r.values }))
    );

    const types = (res.issueTypes ?? []).map((t) => ({ id: t.id, name: t.name, subtask: t.subtask }));
    this.typeCache.set(projectKey, types);
    return types;
  }

  /**
   * Every Jira instance has mandatory custom fields somebody added years ago.
   * Discovering them up front turns a mid-demo 400 into an up-front warning.
   */
  async requiredFields(projectKey: string, issueTypeName: string): Promise<string[]> {
    const type = (await this.listIssueTypes(projectKey)).find(
      (t) => t.name.toLowerCase() === issueTypeName.toLowerCase()
    );
    if (!type) {
      const available = (await this.listIssueTypes(projectKey)).map((t) => t.name).join(', ');
      throw new AtlassianError(
        `Issue type "${issueTypeName}" does not exist in project ${projectKey}. Available: ${available || '(none)'}`
      );
    }

    const res = await this.call<{ fields: { fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean }[] }>(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${type.id}`
    );

    const handled = new Set(['summary', 'description', 'project', 'issuetype', 'labels', 'parent', 'reporter']);
    return (res.fields ?? [])
      .filter((f) => f.required && !f.hasDefaultValue && !handled.has(f.fieldId))
      .map((f) => `${f.name} (${f.fieldId})`);
  }

  async getIssue(key: string): Promise<IssueDetail> {
    const res = await this.call<{
      id: string;
      key: string;
      fields: {
        summary: string;
        description?: unknown;
        issuetype?: { name: string };
        status?: { name: string };
        labels?: string[];
        parent?: { key: string };
      };
    }>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,labels,parent`);

    return {
      id: res.id,
      key: res.key,
      url: `${this.base}/browse/${res.key}`,
      summary: res.fields.summary,
      description: res.fields.description ? adfToMarkdown(res.fields.description) : '',
      issueType: res.fields.issuetype?.name ?? 'Unknown',
      status: res.fields.status?.name ?? 'Unknown',
      labels: res.fields.labels ?? [],
      parentKey: res.fields.parent?.key
    };
  }

  async searchIssues(jql: string, max = 50): Promise<IssueRef[]> {
    // The old GET /rest/api/3/search is retired; /search/jql is the replacement.
    const res = await this.call<{ issues: { id: string; key: string }[] }>('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, maxResults: max, fields: ['summary'] })
    });
    return (res.issues ?? []).map((i) => ({ id: i.id, key: i.key, url: `${this.base}/browse/${i.key}` }));
  }

  /* ------------------------------------------------------------- jira write */

  async createIssue(input: NewIssue): Promise<IssueRef> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueTypeName },
      summary: input.summary.slice(0, 255),
      description: markdownToAdf(input.descriptionMarkdown)
    };
    if (input.labels?.length) fields.labels = input.labels;
    // `parent` is the modern way to link a story to its epic, in both
    // team-managed and company-managed projects. The legacy Epic Link custom
    // field is deprecated and deliberately not used here.
    if (input.parentKey) fields.parent = { key: input.parentKey };

    const res = await this.call<{ id: string; key: string }>('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({ fields })
    });
    return { id: res.id, key: res.key, url: `${this.base}/browse/${res.key}` };
  }

  async updateIssue(key: string, patch: IssuePatch): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (patch.summary !== undefined) fields.summary = patch.summary.slice(0, 255);
    if (patch.descriptionMarkdown !== undefined) fields.description = markdownToAdf(patch.descriptionMarkdown);
    if (patch.labels !== undefined) fields.labels = patch.labels;
    if (Object.keys(fields).length === 0) return;

    await this.call<void>(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields })
    });
  }
}

/** Accepts a bare page id, or any of the Confluence Cloud URL shapes. */
export function extractPageId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  const patterns = [
    /\/pages\/(\d+)/, // /wiki/spaces/KEY/pages/12345/Title
    /[?&]pageId=(\d+)/, // /wiki/pages/viewpage.action?pageId=12345
    /\/content\/(\d+)/
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return m[1];
  }
  throw new AtlassianError(
    `Could not find a Confluence page id in "${idOrUrl}". Paste the full page URL or the numeric page id.`
  );
}

function explain(status: number, path: string, body: string): string {
  const snippet = body.slice(0, 300);
  switch (status) {
    case 401:
      return `Atlassian rejected the credentials (401). Check reqforge.atlassian.email and re-run "ReqForge: Set Atlassian API Token".`;
    case 403:
      return `Permission denied (403) for ${path}. The account may lack Browse Projects or Create Issues in this project. ${snippet}`;
    case 404:
      return `Not found (404): ${path}. Check the page id, issue key, or project key. ${snippet}`;
    case 400:
      return `Atlassian rejected the request (400) for ${path}. This is usually a mandatory custom field or an invalid issue type. ${snippet}`;
    default:
      return `Atlassian request failed (${status}) for ${path}. ${snippet}`;
  }
}
