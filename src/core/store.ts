import { parse, stringify } from 'yaml';
import type { Backlog } from './model';
import { BacklogSchema } from './schemas';

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

/**
 * Loads a backlog file, applying schema defaults.
 *
 * These files are meant to be hand-edited, so this must not be a cast: an
 * author who deletes an `inScope:` line should get a defaulted empty list, and
 * an author who genuinely breaks the file should get told which field is wrong
 * — not a TypeError thrown from inside the markdown renderer three calls later.
 */
export function deserializeBacklog(text: string): Backlog {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`This backlog file is not valid YAML: ${(err as Error).message}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('This backlog file is empty or is not a ReqForge backlog.');
  }
  if ((raw as { version?: unknown }).version !== 1) {
    throw new Error('Not a ReqForge backlog file, or an unsupported schema version.');
  }

  const result = BacklogSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 10)
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`This backlog file has ${result.error.issues.length} problem(s):\n${detail}`);
  }

  return result.data as Backlog;
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
