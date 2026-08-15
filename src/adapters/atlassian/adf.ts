/**
 * Minimal Markdown <-> Atlassian Document Format conversion.
 *
 * Deliberately hand-rolled. The @atlaskit editor packages do this properly but
 * drag in a very large dependency tree, which is a poor trade for a bundle that
 * a client security team is going to unzip and read. This covers the subset we
 * actually emit: headings, paragraphs, bullet/ordered lists, code blocks,
 * rules, and inline bold/italic/code/links.
 *
 * Anything unrecognised degrades to plain paragraph text rather than throwing —
 * a slightly ugly Jira description beats a failed push mid-demo.
 */

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

const INLINE = /(\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`([^`]+?)`|\[([^\]]+)\]\(([^)]+)\))/g;

function inlineNodes(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) nodes.push({ type: 'text', text: text.slice(last, at) });

    if (m[2] !== undefined) {
      nodes.push({ type: 'text', text: m[2], marks: [{ type: 'strong' }] });
    } else if (m[3] !== undefined || m[4] !== undefined) {
      nodes.push({ type: 'text', text: (m[3] ?? m[4])!, marks: [{ type: 'em' }] });
    } else if (m[5] !== undefined) {
      nodes.push({ type: 'text', text: m[5], marks: [{ type: 'code' }] });
    } else if (m[6] !== undefined && m[7] !== undefined) {
      nodes.push({
        type: 'text',
        text: m[6],
        marks: [{ type: 'link', attrs: { href: m[7] } }]
      });
    }
    last = at + m[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes.length > 0 ? nodes : [{ type: 'text', text }];
}

function paragraph(text: string): AdfNode {
  return { type: 'paragraph', content: inlineNodes(text) };
}

/**
 * A paragraph that keeps its line breaks.
 *
 * Markdown says consecutive lines are one paragraph, and joining them with a
 * space is the correct reading. It is the wrong reading here: a story's
 * narrative is three lines, and collapsing them means that when the
 * description is read back out of Jira the structure is gone and the whole
 * thing parses as one field. `hardBreak` survives the round trip.
 */
function paragraphLines(lines: string[]): AdfNode {
  const content: AdfNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...inlineNodes(line));
  });
  return { type: 'paragraph', content };
}

export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: AdfNode[] = [];
  let i = 0;

  const flushList = (ordered: boolean) => {
    const items: AdfNode[] = [];
    const marker = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    while (i < lines.length) {
      const m = lines[i].match(marker);
      if (!m) break;
      items.push({ type: 'listItem', content: [paragraph(m[1])] });
      i++;
    }
    content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      content.push({
        type: 'codeBlock',
        attrs: fence[1] ? { language: fence[1] } : {},
        content: buf.length ? [{ type: 'text', text: buf.join('\n') }] : []
      });
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      content.push({ type: 'rule' });
      i++;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: inlineNodes(heading[2])
      });
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushList(false);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushList(true);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      content.push({ type: 'blockquote', content: [paragraph(buf.join(' '))] });
      continue;
    }

    // Paragraph: consume until blank line or a line that starts a new block.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|```|\s*>\s?)/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) content.push(paragraphLines(buf));
  }

  // ADF rejects an empty doc.
  if (content.length === 0) content.push({ type: 'paragraph', content: [] });

  return { type: 'doc', version: 1, content };
}

/** Best-effort ADF -> markdown, used for reading issues back for refine and diff. */
export function adfToMarkdown(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as AdfNode;

  const kids = () => (n.content ?? []).map(adfToMarkdown).join('');

  switch (n.type) {
    case 'doc':
      return (n.content ?? []).map(adfToMarkdown).join('\n\n').trim();
    case 'paragraph':
      return kids();
    case 'heading':
      return `${'#'.repeat(Number(n.attrs?.level ?? 1))} ${kids()}`;
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${adfToMarkdown(li).trim()}`).join('\n');
    case 'orderedList':
      return (n.content ?? []).map((li, idx) => `${idx + 1}. ${adfToMarkdown(li).trim()}`).join('\n');
    case 'listItem':
      return (n.content ?? []).map(adfToMarkdown).join(' ');
    case 'codeBlock':
      return `\`\`\`${n.attrs?.language ?? ''}\n${kids()}\n\`\`\``;
    case 'blockquote':
      return `> ${kids()}`;
    case 'rule':
      return '---';
    case 'hardBreak':
      return '\n';
    case 'text': {
      let t = n.text ?? '';
      for (const mark of n.marks ?? []) {
        if (mark.type === 'strong') t = `**${t}**`;
        else if (mark.type === 'em') t = `*${t}*`;
        else if (mark.type === 'code') t = `\`${t}\``;
        else if (mark.type === 'link') t = `[${t}](${mark.attrs?.href ?? ''})`;
      }
      return t;
    }
    default:
      return kids();
  }
}
