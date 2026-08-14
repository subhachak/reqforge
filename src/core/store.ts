import { parse, stringify } from 'yaml';
import type { Backlog } from './model';

/**
 * The backlog lives as a YAML file in the workspace rather than in extension
 * memory or a webview. That buys us git history, native editing, and the
 * built-in diff editor for free — and it means a reviewer can read the
 * proposed backlog in a pull request before anything reaches Jira.
 */

export interface FileSystemLike {
  read(relPath: string): Promise<string | undefined>;
  write(relPath: string, contents: string): Promise<void>;
  list(relDir: string): Promise<string[]>;
}

const HEADER = `# ReqForge backlog — edit freely, then run "ReqForge: Push Backlog to Jira".
# Items with a sync.jiraKey already exist in Jira and will be updated, not recreated.
`;

export function serializeBacklog(backlog: Backlog): string {
  return HEADER + stringify(backlog, { lineWidth: 100, aliasDuplicateObjects: false });
}

export function deserializeBacklog(text: string): Backlog {
  const parsed = parse(text) as Backlog;
  if (!parsed || parsed.version !== 1) {
    throw new Error('Not a ReqForge backlog file, or an unsupported version.');
  }
  // Normalize optional collections so downstream code can stay simple.
  parsed.epics = (parsed.epics ?? []).map((e) => ({
    ...e,
    sync: e.sync ?? {},
    stories: (e.stories ?? []).map((s) => ({ ...s, sync: s.sync ?? {} }))
  }));
  return parsed;
}

export function backlogPath(folder: string, slug: string): string {
  return `${folder}/${slug}.backlog.yaml`;
}

export class BacklogStore {
  constructor(
    private readonly fs: FileSystemLike,
    private readonly folder: string
  ) {}

  async save(slug: string, backlog: Backlog): Promise<string> {
    const path = backlogPath(this.folder, slug);
    await this.fs.write(path, serializeBacklog(backlog));
    return path;
  }

  async load(slug: string): Promise<Backlog | undefined> {
    const text = await this.fs.read(backlogPath(this.folder, slug));
    return text ? deserializeBacklog(text) : undefined;
  }

  async loadByPath(relPath: string): Promise<Backlog | undefined> {
    const text = await this.fs.read(relPath);
    return text ? deserializeBacklog(text) : undefined;
  }

  async listSlugs(): Promise<string[]> {
    const files = await this.fs.list(this.folder);
    return files.filter((f) => f.endsWith('.backlog.yaml')).map((f) => f.replace(/\.backlog\.yaml$/, ''));
  }
}
