import type { EpicProposal, StoryProposal, AcceptanceCriterion } from '../schemas';
import { slugify } from '../model';

/**
 * The inverse of `epicToMarkdown` / `storyToMarkdown`.
 *
 * An issue ReqForge created carries its structure in the description, so it can
 * be read back into the same editor the PRD path uses. An issue somebody wrote
 * by hand in Jira has no such structure — everything then lands in
 * `description`, acceptance criteria come back empty, and the rubric says so.
 * That is the correct outcome: a hand-written epic with no testable criteria
 * genuinely does not have any.
 */

const AC_LINE = /^[-*]\s*\*\*Given\*\*\s*(.+?)\s*\*\*when\*\*\s*(.+?)\s*\*\*then\*\*\s*(.+?)\s*$/i;
const BULLET = /^[-*]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

interface Sections {
  /** Text before the first heading. */
  preamble: string[];
  /** Heading title (lowercased) to its lines. */
  sections: Map<string, string[]>;
}

/** Splits on markdown headings, dropping the trailing generated footer. */
function split(markdown: string): Sections {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const preamble: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Everything from the horizontal rule onwards is our own generated footer
    // (sizing, estimate, quality note) and is reconstructed rather than parsed.
    if (/^\s*---+\s*$/.test(line)) break;

    const heading = line.match(HEADING);
    if (heading) {
      current = [];
      sections.set(heading[1].trim().toLowerCase(), current);
      continue;
    }
    (current ?? preamble).push(line);
  }

  return { preamble, sections };
}

function bullets(lines: string[] | undefined): string[] {
  return (lines ?? [])
    .map((l) => l.match(BULLET)?.[1]?.trim())
    .filter((v): v is string => Boolean(v));
}

function criteria(lines: string[] | undefined): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];
  for (const line of lines ?? []) {
    const m = line.trim().match(AC_LINE);
    if (m) {
      out.push({ given: m[1].trim(), when: m[2].trim(), then: m[3].trim() });
      continue;
    }
    // A bullet that is not in Given/When/Then form is still a criterion
    // somebody wrote; keep it rather than silently dropping their work.
    const plain = line.trim().match(BULLET)?.[1]?.trim();
    if (plain) out.push({ given: '', when: '', then: plain });
  }
  return out;
}


/** Strips any quality note we appended on a previous push. */
function withoutQualityNote(markdown: string): string {
  return markdown.replace(/^_Quality:[\s\S]*?_\s*$/gm, '').trim();
}

export function parseEpicMarkdown(key: string, summary: string, markdown: string): EpicProposal {
  const clean = withoutQualityNote(markdown);
  const { preamble, sections } = split(clean);

  const text = preamble.join('\n');
  const outcomeMatch = text.match(/^\*Outcome:\*\s*(.+?)\s*$/m);
  const description = text
    .replace(/^\*Outcome:\*.*$/m, '')
    .replace(/^\*Priority:\*.*$/m, '')
    .trim();

  const sizingMatch = clean.match(/Sizing:\s*(S|M|L|XL)\b/i);

  return {
    ref: slugify(key),
    title: summary,
    outcome: outcomeMatch?.[1]?.trim() ?? '',
    description,
    priority: priorityFrom(clean),
    inScope: bullets(sections.get('in scope')),
    outOfScope: bullets(sections.get('out of scope')),
    successMeasures: bullets(sections.get('success measures')),
    acceptanceCriteria: criteria(sections.get('acceptance criteria')),
    nonFunctional: bullets(sections.get('non-functional requirements')),
    assumptions: bullets(sections.get('assumptions')),
    dependsOn: bullets(sections.get('depends on')),
    sizing: (sizingMatch?.[1]?.toUpperCase() as EpicProposal['sizing']) ?? 'M',
    openQuestions: bullets(sections.get('open questions')),
    // Evidence refers to a source document this issue may not have come from.
    sourceEvidence: []
  };
}

/**
 * Reads the three narrative parts whether they are on separate lines or run
 * together on one. Anchoring each to its own line looks right until a renderer
 * somewhere collapses the paragraph, at which point "As a" greedily swallows
 * the other two and they come back empty.
 */
function narrativeFrom(text: string): { asA: string; iWant: string; soThat: string } {
  const grab = (label: string): string => {
    // Stops at the next narrative marker, at any following field line such as
    // *Priority:*, at a blank line, or at the end. Without the extra stops a
    // lazy match runs to the end of the text and swallows whatever follows.
    const re = new RegExp(
      `\\*\\*${label}\\*\\*\\s*([\\s\\S]*?)\\s*(?=\\*\\*(?:As a|I want|So that)\\*\\*|\\*[A-Z][a-z]+:\\*|\\n\\s*\\n|$)`,
      'i'
    );
    return text.match(re)?.[1]?.trim() ?? '';
  };
  return { asA: grab('As a'), iWant: grab('I want'), soThat: grab('So that') };
}

const PRIORITIES = ['Must', 'Should', 'Could'] as const;

function priorityFrom(markdown: string): (typeof PRIORITIES)[number] {
  const found = markdown.match(/^\*Priority:\*\s*(Must|Should|Could)\b/im)?.[1];
  return (PRIORITIES.find((p) => p.toLowerCase() === found?.toLowerCase()) ?? 'Should');
}

const POINTS = new Set([1, 2, 3, 5, 8, 13]);

export function parseStoryMarkdown(
  key: string,
  summary: string,
  markdown: string,
  epicRef: string
): StoryProposal {
  const clean = withoutQualityNote(markdown);
  const { preamble, sections } = split(clean);
  const text = preamble.join('\n');

  const { asA, iWant, soThat } = narrativeFrom(text);

  const description = text
    .replace(/^\*\*(As a|I want|So that)\*\*.*$/gm, '')
    .replace(/^\*Priority:\*.*$/m, '')
    .trim();

  const rawPoints = Number(clean.match(/Estimate:\s*(\d+)\s*points/i)?.[1]);
  const parsedCriteria = criteria(sections.get('acceptance criteria'));

  return {
    ref: slugify(key),
    epicRef,
    title: summary,
    narrative: { asA, iWant, soThat },
    description,
    priority: priorityFrom(clean),
    // The schema requires at least one criterion; an empty placeholder keeps a
    // hand-written issue loadable, and the rubric immediately flags it.
    acceptanceCriteria: parsedCriteria.length > 0 ? parsedCriteria : [{ given: '', when: '', then: '' }],
    assumptions: bullets(sections.get('assumptions')),
    dependsOn: bullets(sections.get('depends on')),
    points: (POINTS.has(rawPoints) ? rawPoints : 3) as StoryProposal['points'],
    openQuestions: bullets(sections.get('open questions'))
  };
}
