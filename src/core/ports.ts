/**
 * Ports are domain-shaped, not transport-shaped. MCP tools and REST endpoints
 * do not map 1:1, so each adapter owns its own normalization and advertises
 * what it can actually do via `capabilities()`.
 */

export type Capability =
  | 'confluence.read'
  | 'jira.read'
  | 'jira.create'
  | 'jira.update'
  | 'jira.search'
  | 'jira.createmeta'
  | 'jira.bulkCreate';

export interface PageDoc {
  id: string;
  title: string;
  spaceKey?: string;
  version?: number;
  webUrl: string;
  /** Confluence storage format converted to markdown. */
  markdown: string;
}

export interface ProjectRef {
  id: string;
  key: string;
  name: string;
}

export interface IssueTypeRef {
  id: string;
  name: string;
  subtask: boolean;
}

export interface IssueRef {
  key: string;
  id: string;
  url: string;
}

export interface IssueDetail extends IssueRef {
  summary: string;
  /** Description rendered down to markdown for the LLM and for diffing. */
  description: string;
  issueType: string;
  status: string;
  labels: string[];
  parentKey?: string;
}

export interface NewIssue {
  projectKey: string;
  issueTypeName: string;
  summary: string;
  /** Markdown. The adapter converts to whatever the backend needs. */
  descriptionMarkdown: string;
  labels?: string[];
  /** Epic key for a story, when the backend supports parent linking. */
  parentKey?: string;
}

export interface IssuePatch {
  summary?: string;
  descriptionMarkdown?: string;
  /** Replaces the whole label set. Prefer addLabels/removeLabels on an update. */
  labels?: string[];
  /**
   * Additive label changes. A plain `labels` write replaces the array and would
   * destroy labels people added in Jira by hand, so updates use set operations.
   */
  addLabels?: string[];
  removeLabels?: string[];
}

export interface AtlassianPort {
  readonly kind: 'rest' | 'mcp' | 'fixture';
  capabilities(): ReadonlySet<Capability>;
  /** Cheap round trip used by the status bar and the pre-demo check. */
  verifyConnection(): Promise<{ ok: boolean; detail: string }>;
  getConfluencePage(idOrUrl: string): Promise<PageDoc>;
  listProjects(): Promise<ProjectRef[]>;
  listIssueTypes(projectKey: string): Promise<IssueTypeRef[]>;
  /** Field names that are mandatory for this project/issue type beyond the basics. */
  requiredFields(projectKey: string, issueTypeName: string): Promise<string[]>;
  createIssue(input: NewIssue): Promise<IssueRef>;
  updateIssue(key: string, patch: IssuePatch): Promise<void>;
  getIssue(key: string): Promise<IssueDetail>;
  searchIssues(jql: string, max?: number): Promise<IssueRef[]>;
}

/* ---------------------------------------------------------------- LLM port */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StructuredRequest<T> {
  /** Prompt messages. Instructions go in the first user message — vscode.lm has no system role. */
  messages: LlmMessage[];
  /** Name of the emit-tool the model must call. One tool per stage. */
  toolName: string;
  toolDescription: string;
  /** JSON Schema for the tool input. Hand-written for tight model control. */
  inputSchema: Record<string, unknown>;
  /** Validates and narrows the tool input. Failure triggers one repair attempt. */
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string };
  /** Shown to the user in the Copilot consent prompt. */
  justification: string;
}

export interface LlmCancellation {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose(): void };
}

export interface LlmPort {
  readonly kind: 'copilot' | 'anthropic' | 'fixture';
  /** Resolves the backing model, or explains why it is unavailable. */
  probe(): Promise<{ ok: boolean; detail: string }>;
  /** Max input tokens for the resolved model, for chunking decisions. */
  contextWindow(): Promise<number>;
  countTokens(text: string): Promise<number>;
  requestStructured<T>(req: StructuredRequest<T>, token?: LlmCancellation): Promise<T>;
}

/** Raised when the model backend refuses or is unavailable. Carries a user-facing hint. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    /** Not named `cause`: that collides with the Error base member. */
    readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export class AtlassianError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = 'AtlassianError';
  }
}
