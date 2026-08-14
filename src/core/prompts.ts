import type { EpicItem } from './model';
import type { PrdSkeleton } from './schemas';

/**
 * Prompt framing note: these run through Copilot's endpoint, which applies
 * relevance filtering. Everything here is deliberately framed as software
 * delivery engineering — backlog structure, issue trackers, acceptance tests —
 * rather than as open-ended business or product strategy analysis. Keep that
 * framing if you edit them. See README "Model availability spike".
 */

const ENGINEER_PREAMBLE =
  'You are assisting a software engineering team with backlog engineering in Jira. ' +
  'You convert requirements documents into well-formed issue-tracker artifacts. ' +
  'You are precise, you never invent requirements that are not supported by the source text, ' +
  'and you surface ambiguity as explicit open questions rather than guessing.';

export function extractSkeletonPrompt(pageTitle: string, markdown: string): string {
  return [
    ENGINEER_PREAMBLE,
    '',
    'Task: read the requirements document below and extract its structure so the team can plan delivery.',
    '',
    'Rules:',
    '- Only record what the document actually says. Do not fill gaps with plausible detail.',
    '- Anything ambiguous, contradictory, or missing belongs in openQuestions or risks.',
    '- Prefer the document\'s own vocabulary over generic phrasing.',
    '',
    `Document title: ${pageTitle}`,
    '',
    '<document>',
    markdown,
    '</document>',
    '',
    'Call the emit tool with the extracted structure.'
  ].join('\n');
}

export function proposeEpicsPrompt(skeleton: PrdSkeleton, markdown: string): string {
  return [
    ENGINEER_PREAMBLE,
    '',
    'Task: decompose the requirements document below into a set of Jira epics.',
    '',
    'What makes a good epic here:',
    '- It delivers one coherent, user-visible or operationally meaningful outcome.',
    '- It can be described without referring to how another epic is implemented.',
    '- It is large enough to hold several stories, small enough to ship in a quarter.',
    '- Its acceptance criteria are observable, not internal implementation checks.',
    '',
    'Avoid:',
    '- Layer-shaped epics ("build the database", "build the API", "build the UI"). Slice by outcome.',
    '- Epics that only restate a goal without describing what gets built.',
    '- Inventing compliance, security, or integration scope the document never mentions.',
    '',
    'Structure already extracted from the document:',
    JSON.stringify(skeleton, null, 2),
    '',
    '<document>',
    markdown,
    '</document>',
    '',
    'Call the emit tool with your proposed epics.'
  ].join('\n');
}

export function critiqueEpicsPrompt(epicsJson: string): string {
  return [
    ENGINEER_PREAMBLE,
    '',
    'Task: review this proposed epic breakdown the way a staff engineer reviews a backlog before sprint planning.',
    '',
    'Look specifically for:',
    '- Two epics that overlap, or one that is really two.',
    '- Acceptance criteria that are not observable or not testable.',
    '- Epics sliced by technical layer rather than by delivered outcome.',
    '- Dependency chains that would block the team from delivering anything early.',
    '- Scope that is not supported by the sourceEvidence quotes.',
    '',
    'Report only real problems. An empty findings array is a valid and useful answer.',
    '',
    '<epics>',
    epicsJson,
    '</epics>',
    '',
    'Call the emit tool with your findings.'
  ].join('\n');
}

export function reviseEpicsPrompt(epicsJson: string, critiqueJson: string): string {
  return [
    ENGINEER_PREAMBLE,
    '',
    'Task: apply the review findings below to the epic breakdown and emit the corrected set.',
    '',
    'Rules:',
    '- Address every blocker and major finding. Minor findings are discretionary.',
    '- Preserve the ref of any epic you keep, so existing links stay intact.',
    '- If you split an epic, the first half keeps the original ref.',
    '- Do not introduce scope that was not in the original set.',
    '',
    '<epics>',
    epicsJson,
    '</epics>',
    '',
    '<review-findings>',
    critiqueJson,
    '</review-findings>',
    '',
    'Call the emit tool with the full corrected set of epics.'
  ].join('\n');
}

export function proposeStoriesPrompt(epics: EpicItem[], skeleton: PrdSkeleton): string {
  return [
    ENGINEER_PREAMBLE,
    '',
    'Task: break each of the epics below into implementable Jira stories.',
    '',
    'Each story must:',
    '- Be independently deliverable and independently testable (INVEST).',
    '- Be sized so one pair could finish it inside a single sprint.',
    '- Name a concrete role in the "as a" clause, drawn from the personas below.',
    '- Have acceptance criteria that a QA engineer could execute without asking questions.',
    '',
    'Include the unglamorous work — migrations, error states, empty states, permissions, ' +
      'observability — where the epic implies it. Do not include generic boilerplate stories ' +
      'that every project has ("set up CI") unless the document calls for them.',
    '',
    'Personas and constraints from the source document:',
    JSON.stringify({ personas: skeleton.personas, constraints: skeleton.constraints }, null, 2),
    '',
    '<epics>',
    JSON.stringify(
      epics.map((e) => ({
        ref: e.ref,
        title: e.title,
        outcome: e.outcome,
        description: e.description,
        inScope: e.inScope,
        outOfScope: e.outOfScope,
        acceptanceCriteria: e.acceptanceCriteria
      })),
      null,
      2
    ),
    '</epics>',
    '',
    'Call the emit tool with stories for every epic listed.'
  ].join('\n');
}

export function refineIssuePrompt(
  issueType: 'epic' | 'story',
  current: { key: string; summary: string; description: string },
  instruction: string,
  context?: string
): string {
  return [
    ENGINEER_PREAMBLE,
    '',
    `Task: refine the existing Jira ${issueType} below according to the reviewer's instruction.`,
    '',
    'Rules:',
    '- Preserve anything the instruction does not ask you to change.',
    '- Keep the existing title unless the instruction implies it should change.',
    '- Do not silently drop existing acceptance criteria; if one is wrong, correct it.',
    '- If the instruction cannot be satisfied from the information available, record the gap as an open question rather than inventing an answer.',
    '',
    `<current-issue key="${current.key}">`,
    `Title: ${current.summary}`,
    '',
    current.description,
    '</current-issue>',
    '',
    context ? `<additional-context>\n${context}\n</additional-context>\n` : '',
    '<reviewer-instruction>',
    instruction,
    '</reviewer-instruction>',
    '',
    'Call the emit tool with the complete refined version.'
  ].join('\n');
}

/** Appended to a retry when the first response failed schema validation. */
export function repairPrompt(error: string): string {
  return [
    'Your previous tool call did not satisfy the schema and was rejected.',
    '',
    `Validation error: ${error}`,
    '',
    'Call the tool again with a corrected payload. Change only what the error requires.'
  ].join('\n');
}
