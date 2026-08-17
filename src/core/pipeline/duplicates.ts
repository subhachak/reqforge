import { z } from 'zod';
import type { Backlog, EpicItem } from '../model';
import type { AtlassianPort, LlmCancellation, LlmPort, SearchHit } from '../ports';
import type { DuplicateCandidate, DuplicateReport, Relationship } from '../findings';
import type { Progress } from './decompose';
import { zodParser } from './parse';

export type { DuplicateCandidate, DuplicateReport, Relationship } from '../findings';

/**
 * Finds work that already exists before creating more of it.
 *
 * The push planner's idempotency is stamp-label based, which means it can only
 * recognise issues *this tool* created. It cannot tell that another team already
 * has an epic covering single sign-on, and in a backlog of any size that is a
 * routine and embarrassing failure. Teamwork Graph retrieval is the only thing
 * available that can, which is the concrete reason the full profile exists.
 *
 * Two deliberate limits:
 *   - Nothing is ever auto-skipped. A duplicate is a judgement about intent,
 *     and silently not creating an issue somebody asked for is a much worse
 *     failure than creating a second one. The output is advice for the PO.
 *   - Retrieval alone is not enough. Semantic search happily returns things
 *     that are merely adjacent, so a model pass decides which hits are the
 *     *same work* rather than related work — the one judgement here that code
 *     cannot make.
 */

const VerdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        ref: z.string().min(1),
        key: z.string().min(1),
        relationship: z.enum(['duplicate', 'overlaps', 'related', 'unrelated']),
        reason: z.string().min(1)
      })
    )
    .default([])
});




export interface DuplicateOptions {
  /** Check only these epic refs. Omit for every unpushed epic. */
  only?: string[];
  /** Hits to request per item. */
  perItem?: number;
  progress?: Progress;
  token?: LlmCancellation;
}

/** The query text for one epic. Title alone is too thin to retrieve well. */
function queryFor(epic: EpicItem): string {
  return [epic.title, epic.outcome, ...epic.inScope.slice(0, 3)].filter(Boolean).join('. ');
}

export async function findDuplicates(
  atlassian: AtlassianPort,
  llm: LlmPort,
  backlog: Backlog,
  opts: DuplicateOptions = {}
): Promise<DuplicateReport> {
  if (!atlassian.capabilities().has('graph.search')) {
    return {
      available: false,
      unavailableReason:
        'Checking for existing work needs Teamwork Graph search, which the REST transport cannot reach. Switch the transport to "mcp" in settings.',
      candidates: [],
      checked: []
    };
  }

  const epics = backlog.epics.filter(
    (e) => !e.container && !e.sync.jiraKey && (!opts.only || opts.only.includes(e.ref))
  );
  if (epics.length === 0) return { available: true, candidates: [], checked: [] };

  // Anything already in this backlog is not a discovery. Without this the epic
  // being checked matches its own previously-pushed siblings and every run
  // reports duplicates of itself.
  const ours = new Set(
    backlog.epics.flatMap((e) => [e.sync.jiraKey, ...e.stories.map((s) => s.sync.jiraKey)]).filter(Boolean) as string[]
  );

  const found = new Map<string, { epic: EpicItem; hits: SearchHit[] }>();
  const checked: string[] = [];

  for (const [i, epic] of epics.entries()) {
    if (opts.token?.isCancellationRequested) break;
    opts.progress?.report(`Checking for existing work: ${i + 1} of ${epics.length}…`);
    checked.push(epic.ref);

    let hits: SearchHit[];
    try {
      hits = await atlassian.semanticSearch(queryFor(epic), { limit: opts.perItem ?? 5, products: ['jira'] });
    } catch {
      // One failed lookup should not lose the rest. A missed duplicate check
      // costs a duplicate issue; a failed run costs the whole push.
      continue;
    }

    const useful = hits.filter((h) => h.id && !ours.has(h.id));
    if (useful.length > 0) found.set(epic.ref, { epic, hits: useful });
  }

  if (found.size === 0) return { available: true, candidates: [], checked };

  const blocks = [...found.values()]
    .map(({ epic, hits }) =>
      [
        `<proposed ref="${epic.ref}">`,
        `Title: ${epic.title}`,
        `Outcome: ${epic.outcome}`,
        epic.inScope.length ? `In scope: ${epic.inScope.join('; ')}` : '',
        epic.outOfScope.length ? `Explicitly out of scope: ${epic.outOfScope.join('; ')}` : '',
        '',
        'Existing issues found in Jira:',
        ...hits.map((h) => `- [${h.id}] ${h.title}${h.excerpt ? ` — ${h.excerpt}` : ''}`),
        '</proposed>'
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');

  const parsed = await llm.requestStructured<z.infer<typeof VerdictSchema>>(
    {
      messages: [
        {
          role: 'user',
          content: [
            'You are assisting a software engineering team with backlog planning in Jira.',
            'For each proposed epic below, a search returned existing Jira issues. Decide how each existing issue relates to the proposed work, so a product owner can avoid creating something that already exists.',
            '',
            'Relationships:',
            '- duplicate: the existing issue covers the same work. Creating the proposed epic would be redundant.',
            '- overlaps: they share a meaningful part of their scope, but neither contains the other.',
            '- related: same area or system, different work. This is the common case.',
            '- unrelated: the search returned it, but it is not relevant.',
            '',
            'Rules:',
            '- Be conservative with "duplicate". Two issues about the same feature area are usually "related", not duplicates.',
            '- Judge by the work described, not by how similar the titles look.',
            '- Give a reason that names the specific overlap or the specific difference.',
            '- Include a verdict for every existing issue listed under every proposed epic.',
            '',
            blocks,
            '',
            'Call the emit tool.'
          ].join('\n')
        }
      ],
      toolName: 'emit_duplicate_verdicts',
      toolDescription: 'Record how each existing Jira issue relates to the proposed epic.',
      inputSchema: {
        type: 'object',
        properties: {
          verdicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: 'The ref of the proposed epic.' },
                key: { type: 'string', description: 'The existing Jira issue key, exactly as given in brackets.' },
                relationship: { type: 'string', enum: ['duplicate', 'overlaps', 'related', 'unrelated'] },
                reason: { type: 'string', description: 'One sentence naming the specific overlap or difference.' }
              },
              required: ['ref', 'key', 'relationship', 'reason']
            }
          }
        },
        required: ['verdicts']
      },
      parse: zodParser(VerdictSchema),
      justification: `ReqForge is checking ${found.size} proposed epic(s) against existing Jira issues.`
    },
    opts.token
  );

  const candidates: DuplicateCandidate[] = [];
  for (const verdict of parsed.verdicts) {
    if (verdict.relationship === 'unrelated') continue;
    const entry = found.get(verdict.ref);
    // Only verdicts about issues the search actually returned. A model that
    // invents a key must not put a phantom issue in front of the PO.
    const hit = entry?.hits.find((h) => h.id === verdict.key);
    if (!entry || !hit) continue;
    candidates.push({
      level: 'epic',
      ref: entry.epic.ref,
      title: entry.epic.title,
      hit,
      relationship: verdict.relationship,
      reason: verdict.reason
    });
  }

  // Strongest relationship first: a duplicate needs a decision, a related issue
  // is only worth a glance.
  const rank: Record<Relationship, number> = { duplicate: 0, overlaps: 1, related: 2 };
  candidates.sort((a, b) => rank[a.relationship] - rank[b.relationship]);

  return { available: true, candidates, checked };
}
