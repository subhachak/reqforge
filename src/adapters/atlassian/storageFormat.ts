import TurndownService from 'turndown';

/**
 * Confluence storage format is XHTML plus a pile of `ac:` / `ri:` macro tags
 * that Turndown knows nothing about. We normalise the macros we care about into
 * ordinary HTML first, then convert. Unhandled macros are unwrapped rather than
 * dropped — a PRD's content is often inside an expand or a panel, and silently
 * losing it would be worse than slightly messy markdown.
 */

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function storageToHtml(storage: string): string {
  let html = storage;

  // Code macros -> <pre><code>
  html = html.replace(
    /<ac:structured-macro[^>]*ac:name="code"[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/g,
    (_m, code) => `<pre><code>${code}</code></pre>`
  );

  // Info / note / warning / tip panels -> blockquote
  html = html.replace(
    /<ac:structured-macro[^>]*ac:name="(info|note|warning|tip|panel)"[\s\S]*?<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>[\s\S]*?<\/ac:structured-macro>/g,
    (_m, _kind, body) => `<blockquote>${body}</blockquote>`
  );

  // Expand macros -> keep the body, it usually holds the detail we want.
  html = html.replace(
    /<ac:structured-macro[^>]*ac:name="expand"[\s\S]*?<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>[\s\S]*?<\/ac:structured-macro>/g,
    (_m, body) => body
  );

  // Task lists -> checkbox bullets
  html = html.replace(/<ac:task-list>([\s\S]*?)<\/ac:task-list>/g, (_m, body: string) => {
    const items = [...body.matchAll(/<ac:task>[\s\S]*?<ac:status>(\w+)<\/ac:status>[\s\S]*?<ac:task-body>([\s\S]*?)<\/ac:task-body>[\s\S]*?<\/ac:task>/g)]
      .map(([, status, text]) => `<li>${status === 'complete' ? '[x] ' : '[ ] '}${text}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  });

  // Page links -> plain text of the target title
  html = html.replace(/<ac:link[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>[\s\S]*?<\/ac:link>/g, '$1');

  // User mentions -> a neutral placeholder; we never want raw account ids in prompts.
  html = html.replace(/<ac:link[^>]*>[\s\S]*?<ri:user[^>]*\/>[\s\S]*?<\/ac:link>/g, '@person');

  // Any remaining structured macro: keep rich text body, drop the wrapper.
  html = html.replace(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/g, '$1');
  html = html.replace(/<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/g, '$1');

  // Strip leftover ac:/ri: tags but keep their text content.
  html = html.replace(/<\/?(?:ac|ri):[^>]*>/g, '');

  // Layout wrappers add nothing.
  html = html.replace(/<\/?(?:ac:layout|ac:layout-section|ac:layout-cell)[^>]*>/g, '');

  return html;
}

let turndown: TurndownService | undefined;

function service(): TurndownService {
  if (turndown) return turndown;
  turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*'
  });

  // Turndown drops tables by default; a PRD's requirements are often in one.
  // Typed structurally: Turndown supplies a domino node, and we do not want to
  // pull the whole DOM lib into an extension host build for two methods.
  interface QueryNode {
    querySelectorAll(selector: string): ArrayLike<QueryNode>;
    textContent: string | null;
  }

  turndown.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as unknown as QueryNode).querySelectorAll('tr'));
      if (rows.length === 0) return '';
      const cells = (tr: QueryNode) =>
        Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());
      const header = cells(rows[0]);
      const out = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
      for (const tr of rows.slice(1)) out.push(`| ${cells(tr).join(' | ')} |`);
      return `\n\n${out.join('\n')}\n\n`;
    }
  });

  return turndown;
}

/**
 * Turndown pads list markers to a four-character column ("-   item"). Valid
 * markdown, but it wastes prompt tokens and reads badly in the backlog file,
 * so collapse it while preserving the leading indent that encodes nesting.
 */
function normalizeLists(md: string): string {
  return md.replace(/^(\s*)([-*+])[ \t]{2,}/gm, '$1$2 ').replace(/^(\s*)(\d+\.)[ \t]{2,}/gm, '$1$2 ');
}

export function storageToMarkdown(storage: string): string {
  const html = storageToHtml(storage);
  try {
    return normalizeLists(decodeEntities(service().turndown(html)))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    // Turndown needs a DOM shim in some hosts; fall back to a crude strip so
    // the pipeline degrades instead of failing.
    return decodeEntities(html.replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
