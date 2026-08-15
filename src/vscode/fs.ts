import * as vscode from 'vscode';
import type { FileSystemLike } from '../core/store';
import { workspaceFolder } from './config';

/** Workspace-relative file access for the backlog store. */
export class WorkspaceFs implements FileSystemLike {
  private uri(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(workspaceFolder().uri, ...relPath.split('/'));
  }

  async read(relPath: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri(relPath));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  async write(relPath: string, contents: string): Promise<void> {
    const uri = this.uri(relPath);
    const dir = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) });
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
  }

  async remove(relPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(relPath), { useTrash: true });
    } catch {
      // Already gone is the desired end state.
    }
  }

  async list(relDir: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.uri(relDir));
      return entries.filter(([, kind]) => kind === vscode.FileType.File).map(([name]) => name);
    } catch {
      return [];
    }
  }
}

/**
 * Backs the read-only virtual documents used for the dry-run preview and the
 * refine diff. Using real documents means we get syntax highlighting, find,
 * and the native diff editor without building any UI.
 */
export class VirtualDocs implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'reqforge';

  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  set(name: string, text: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${VirtualDocs.scheme}:${name}`);
    this.contents.set(uri.toString(), text);
    this.emitter.fire(uri);
    return uri;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
