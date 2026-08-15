import * as vscode from 'vscode';
import type { Backlog, EpicItem, StoryItem } from '../core/model';
import { epicFingerprint, storyFingerprint } from '../core/model';
import { BacklogStore } from '../core/store';
import { backlogPath } from '../core/store';
import { dataFolder } from './config';
import { WorkspaceFs } from './fs';

type Node =
  | { kind: 'backlog'; slug: string; backlog: Backlog }
  | { kind: 'epic'; slug: string; epic: EpicItem }
  | { kind: 'story'; slug: string; story: StoryItem }
  | { kind: 'message'; text: string };

export class BacklogTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  private store(): BacklogStore {
    return new BacklogStore(new WorkspaceFs(), dataFolder());
  }

  async getChildren(node?: Node): Promise<Node[]> {
    try {
      if (!node) {
        const store = this.store();
        const slugs = await store.listSlugs();
        if (slugs.length === 0) {
          return [{ kind: 'message', text: 'No backlogs yet — run "ReqForge: Decompose Confluence PRD"' }];
        }
        const out: Node[] = [];
        for (const slug of slugs) {
          const backlog = await store.load(slug).catch(() => undefined);
          if (backlog) out.push({ kind: 'backlog', slug, backlog });
        }
        return out;
      }

      if (node.kind === 'backlog') {
        return node.backlog.epics.map((epic) => ({ kind: 'epic' as const, slug: node.slug, epic }));
      }
      if (node.kind === 'epic') {
        return node.epic.stories.map((story) => ({ kind: 'story' as const, slug: node.slug, story }));
      }
      return [];
    } catch (err) {
      return [{ kind: 'message', text: `Could not read backlogs: ${(err as Error).message}` }];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }

    if (node.kind === 'backlog') {
      const item = new vscode.TreeItem(node.backlog.source.title, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${node.backlog.epics.length} epics → ${node.backlog.target.projectKey}`;
      item.iconPath = new vscode.ThemeIcon('book');
      item.contextValue = 'reqforge.backlog';
      item.resourceUri = vscode.Uri.file(backlogPath(dataFolder(), node.slug));
      // Clicking a backlog opens the review panel, not the raw file.
      item.command = { command: 'reqforge.open', title: 'Open', arguments: [node.slug] };
      return item;
    }

    if (node.kind === 'epic') {
      const state = syncBadge(node.epic.sync.jiraKey, node.epic.sync.pushedHash, epicFingerprint(node.epic));
      const item = new vscode.TreeItem(
        node.epic.title,
        node.epic.stories.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      );
      item.description = `${node.epic.sync.jiraKey ?? 'unpushed'} · ${state.label} · ${node.epic.sizing}`;
      item.iconPath = new vscode.ThemeIcon(state.icon, state.color);
      item.contextValue = 'reqforge.epic';
      item.tooltip = new vscode.MarkdownString(
        `**${node.epic.title}**\n\n${node.epic.outcome}\n\n_${node.epic.stories.length} stories_`
      );
      if (node.epic.sync.jiraUrl) {
        item.command = { command: 'reqforge.openItem', title: 'Open', arguments: [{ type: 'url', url: node.epic.sync.jiraUrl }] };
      }
      return item;
    }

    const state = syncBadge(node.story.sync.jiraKey, node.story.sync.pushedHash, storyFingerprint(node.story));
    const item = new vscode.TreeItem(node.story.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${node.story.sync.jiraKey ?? 'unpushed'} · ${node.story.points}pt`;
    item.iconPath = new vscode.ThemeIcon(state.icon, state.color);
    item.contextValue = 'reqforge.story';
    if (node.story.sync.jiraUrl) {
      item.command = { command: 'reqforge.openItem', title: 'Open', arguments: [{ type: 'url', url: node.story.sync.jiraUrl }] };
    }
    return item;
  }
}

function syncBadge(
  jiraKey: string | undefined,
  pushedHash: string | undefined,
  currentHash: string
): { icon: string; label: string; color?: vscode.ThemeColor } {
  if (!jiraKey) {
    return { icon: 'circle-outline', label: 'new', color: new vscode.ThemeColor('charts.blue') };
  }
  if (pushedHash !== currentHash) {
    return { icon: 'circle-filled', label: 'edited', color: new vscode.ThemeColor('charts.yellow') };
  }
  return { icon: 'check', label: 'synced', color: new vscode.ThemeColor('charts.green') };
}
