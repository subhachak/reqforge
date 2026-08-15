# ReqForge

Decompose a Confluence PRD into fully-formed Jira epics and stories, review them in your editor, and push them — idempotently. Refine existing epics and stories against a plain-English instruction, with a diff before anything is written.

Built to run under a restrictive client policy: **no MCP, no third-party LLM providers**. The restricted build's only network destinations are your own Atlassian tenant and — indirectly, through VS Code's own client — GitHub Copilot.

---

## Quick start

```bash
npm install && npm run check
```

Then press <kbd>F5</kbd> in VS Code ("Run ReqForge (restricted profile)") to launch an Extension Development Host.

In the dev host, **open a folder first** — the backlog is stored workspace-relative — then click
the ReqForge icon in the activity bar. That opens the panel directly; there is no tree to navigate
first. <kbd>⌘⇧P</kbd> → **`ReqForge: Open`** does the same.

**`ReqForge: Open` is the only command in the palette.** Credentials, model checks, story
generation, refine, push and dry run were all palette entries once and are all in the panel now.
A palette entry that duplicates a button is a second code path to keep working and a second thing
to explain to a product owner who was never going to open the palette.

**First run lands on setup and stays there.** Site, account email, API token and Jira project are
required before any other view is reachable — the host recomputes that gate on every render, so
it cannot be routed around from the webview. A half-configured tool fails later, in the middle of
real work, with errors that read like bugs.

**Once configured, the home screen offers two entry points and loads nothing on its own:**

- **Start from a PRD** — pick a Confluence page, get proposed epics, review, send to Jira.
- **Work on an existing epic** — type a Jira key. The epic and its stories are pulled in and
  become a backlog, so the same editor, rubric, story generation and push apply. Changes go back
  as updates.

Backlogs already saved on this machine are listed underneath as a "pick up where you left off"
list. That list is read from local files; nothing queries Jira until you ask it to.

The pipelines those commands drove are unchanged and still headless — `src/core/` has no
`import * as vscode` in it, and `npm run smoke` exercises the lot without an extension host.
Only the palette surface went.

### Working on the UI without an extension host

```bash
npm run harness -- /path/to/some.backlog.yaml
```

Serves the built webview at `http://localhost:5177` with `acquireVsCodeApi()` stubbed and a real
backlog loaded. Posted messages are logged bottom-right; press `t` to toggle light theme. Rebuild
(`npm run build`) and reload to see changes. This is much faster than round-tripping through the
Extension Development Host, and it is how the layout bugs in the autosizing fields were found.

Two environment variables pick which screen to inspect:

```bash
HARNESS_SETUP=incomplete npm run harness          # the first-run setup gate
HARNESS_VIEW=jira npm run harness                 # the update-an-issue view
```

---

## Run the model spike before anything else

Copilot's endpoint applies relevance filtering, and "decompose this product requirements document" is not self-evidently a coding task. **This is the single risk that can sink the project**, because under the restricted profile there is no alternate provider to fall back to.

Open ReqForge, go to Settings, and press **Test connections** — it probes Copilot and Atlassian separately. Then run one real decomposition against a representative PRD. If you get `LanguageModelError` with code `Blocked`, the mitigation is prompt framing, not architecture — all prompts in `src/core/prompts.ts` already lead with an engineering framing (`ENGINEER_PREAMBLE`) and use issue-tracker vocabulary throughout. Push harder in that direction before concluding it cannot work.

The adapter surfaces a refusal verbatim rather than swallowing it: if the model answers in prose instead of calling the emit-tool, that prose is included in the error, which tells you exactly what it objected to.

---

## Architecture

```
  Webview (React)        src/webview/         ← what a product owner sees
        │                review · inline edit · rewrite · send to Jira
        │  postMessage, typed by src/shared/protocol.ts
  VS Code layer          src/vscode/, src/extension.ts
        │                panel · one command · secrets
  ──────┼───────────────────────────────────────────────────────────
  Core  │                src/core/
        │                ports · schemas · prompts · pipelines · store
  ──────┴──────────┬──────────────────────────┐
  LlmPort          │           AtlassianPort  │
   ├ copilot  ✅   │            ├ rest   ✅   │
   ├ fixture  ✅   │            └ mcp    ⬜   │
   └ anthropic ⬜  │                          │
```

The host owns all state. The webview posts intents and re-renders whatever comes back, so the
file on disk and the pixels on screen can never disagree. Backlogs are tens of items, so full-state
round trips are simpler and safer than incremental patching and cost nothing at this size.

**Why VS Code, when the users are product owners?** Because the restricted profile's only
permitted model is Copilot, and Copilot is reachable only through `vscode.lm`, which exists only
inside an extension host. A standalone web app would mean giving up the one approved LLM route.
So the host is fixed, and the job is to make it disappear behind the panel.

`src/core/` has no `import * as vscode` anywhere in it. That is deliberate — it means the pipeline, schema validation, idempotency and rendering are all testable headlessly (`npm run smoke`), which is also the evidence a security-conscious client will ask for.

### Ports are domain-shaped, not transport-shaped

`AtlassianPort` exposes `createIssue(input)`, not `post(path, body)`. MCP tools and REST endpoints do not map 1:1, so each adapter owns its own normalization and declares what it can actually do via `capabilities()`. When the MCP adapter lands it slots in behind the same interface; `planPush` already degrades gracefully when `jira.search` or `jira.createmeta` is unavailable.

### Two builds, one repo

`@registry` is aliased at build time to `src/registry.restricted.ts` or `src/registry.full.ts`. Only those two files import adapters, so unused adapters are **absent from the bundle**, not merely unreachable.

```bash
npm run build          # restricted
npm run build:full     # full
npm run package        # typecheck + tests + minified build -> reqforge-restricted.vsix
npm run package:full   # -> reqforge-full.vsix
```

`package` runs `npm run check` first, so a VSIX cannot be produced from a tree that fails the
tests or the compliance guard.

The restricted build runs a **compliance guard** (`esbuild.mjs`) that greps the output bundle for `api.anthropic.com`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `mcp.atlassian.com`, and `api.openai.com`, and fails the build on a hit. Your client's security team will run that grep; better that your CI runs it first.

---

## Installing it

```bash
npm run package
code --install-extension reqforge-restricted.vsix
```

Or in VS Code: Extensions view → `···` → **Install from VSIX**. Reload the window afterwards, then
<kbd>⌘⇧P</kbd> → `ReqForge: Open`.

The VSIX is around 420 KB and contains nine files: the two bundles, `package.json`, the readme,
the licence and the activity-bar icon. No source, no `node_modules`, no source maps, no
credentials — the token lives in the OS keychain and never goes near the package. Worth verifying
before handing it to a client:

```bash
unzip -l reqforge-restricted.vsix
unzip -p reqforge-restricted.vsix extension/dist/extension.js | grep -c "anthropic\|openai\|modelcontextprotocol"
```

That grep should print `0` for the restricted build, which is the same check the compliance guard
runs at build time.

### The VSIX is built on every push

```bash
npm run hooks      # once per clone; npm install also does it
```

That points git at `.githooks`, whose `pre-push` runs `npm run package` — typecheck, the full
test suite, the compliance guard, then vsce. Nothing reaches the remote that fails to build,
fails a test, or has leaked a forbidden dependency into the restricted bundle, and the installable
artifact always matches what was pushed.

Verified by breaking the build on purpose and watching the push refuse. `git push --no-verify`
skips it when you have a reason.

The `.vsix` itself stays out of git — it is a build output, and a 420 KB binary per commit is not
something to keep in history. Attach it to a GitHub Release when you want a fixed, downloadable
version for the client.

### Getting it to the client

For a client with a restrictive policy, hand over the `.vsix` directly — an internal file share,
an artifact repository, or attached to a ticket. Nothing touches the public marketplace, which is
usually what such a client wants.

Two consequences of VSIX distribution worth stating up front:

- **No automatic updates.** Users install a new `.vsix` over the old one. Bump `version` in
  `package.json` each time or people cannot tell what they are running.
- **No signature.** VS Code will install it without complaint, but some managed estates block
  unsigned extensions by policy. Check before the rollout, not during it.

If the client runs a private extension gallery or Open VSX internally, publishing there gives you
updates and signing; otherwise `code --install-extension` in an onboarding script is the usual
answer.

There is no marketplace icon (`icon` in `package.json`) because that needs a 128×128 PNG and only
affects a marketplace listing. Add one if you ever publish.

---

## What protects the demo

**Idempotency.** Every created issue is stamped with a label `reqforge-<pageId>-<ref>`. Before creating anything, the planner resolves each item against (1) the `jiraKey` recorded in the backlog file, then (2) a JQL search for that label. Re-running after a crash — or a colleague running the same command — adopts and updates instead of duplicating.

**The plan is always shown.** `planPush` writes nothing. Both push commands render the plan to a preview document first; the real push then requires an explicit modal confirmation stating exact counts.

**Required-field discovery.** Every Jira instance has a mandatory custom field somebody added in 2019. `requiredFields()` reads `createmeta` and warns up front, turning a mid-demo `400` into a preflight warning.

**The buttons go quiet when there is nothing to do.** Once everything matches what is in Jira,
"Review & send" reads *All sent to Jira* and is disabled, and "Review quality" reads *Reviewed*.
Both re-enable the moment something changes, because an item's status is decided by comparing its
`pushedHash` against its **current** fingerprint — not by whether a `pushedHash` exists. Treating a
present hash as proof of being up to date marks anything edited after a push as synced, which is
the one case where sending matters most. `syncStatus()` is in core with tests for exactly that.

The backlog is deliberately **not** deleted after a successful push. It is the record that makes a
later re-push update rather than duplicate, it holds the hand-edits, and clearing it automatically
would destroy the only local copy of work — which is a thing that has already happened once here.
Removing it is a deliberate act, from the home screen.

**Partial failure is saved.** `executePush` saves the backlog file even when some items fail, so the keys already obtained are never lost and the retry does not duplicate.

**Undo covers everything local, and stops at the push.** The host keeps up to 50 snapshots, so Undo reverses generated stories, accepted rewrites and deletions, not just typing — consecutive keystrokes collapse into one step. The history is cleared after a push on purpose: undoing past a push would roll back the Jira keys just recorded, and the next push would then duplicate issues that already exist. Local edits are reversible; sending is not.

**Content fidelity.** Confluence storage format is XHTML plus `ac:` macro tags. `storageFormat.ts` normalizes code macros, info/note/warning panels, expands, task lists, and tables before Turndown sees them — PRD content is very often inside an expand or a table, and silently losing it would produce a confidently wrong backlog.

---

## What an epic and a story hold

Defined in `src/core/schemas.ts` — `EpicProposalSchema` and `StoryProposalSchema` are the source
of truth for both.

| | Epic | Story |
|---|---|---|
| Identity | ref, title | ref, epicRef, title |
| Intent | outcome, description | narrative (as a / I want / so that), description |
| Ordering | priority (MoSCoW), sizing | priority (MoSCoW), points |
| Boundaries | inScope, outOfScope | — |
| Evidence | successMeasures, acceptanceCriteria, sourceEvidence | acceptanceCriteria |
| Constraints | nonFunctional, assumptions, dependsOn | assumptions, dependsOn |
| Elsewhere | links (design / spec / reference) | links (design / spec / reference) |
| Unknowns | openQuestions | openQuestions |

**Adding a field touches eight files**, and missing one fails quietly rather than loudly:

1. `core/schemas.ts` — the field and its validation
2. `core/toolSchemas.ts` — the JSON Schema the model fills. Hand-written and kept in step by hand
3. `core/model.ts` — the renderer, which is what reaches Jira; and the fingerprint, if editing the
   field should mark the item as needing a push
4. `core/pipeline/parseIssue.ts` — the inverse parser, or importing the issue back silently drops it
5. `core/prompts.ts` — what good looks like, or the model fills it plausibly rather than well
6. `webview/index.tsx` — the editor
7. `core/rubric/rules.ts` — a rule about it, if one is warranted
8. `core/pipeline/refineLocal.ts` — whether a rewrite may touch it, as `sourceEvidence` may not

Every field also costs prompt tokens on every call and another thing a product owner has to read,
which is the argument for adding few.

**Links** are typed — `design`, `spec`, `reference` — rather than a `figmaUrl` field. A named field
per tool means a schema change through all eight files the first time somebody wants to attach a
Miro board, and the type costs nothing while letting the editor and the rubric treat a design
differently from a reference. They render as ordinary markdown links, so they survive the ADF round
trip on the existing link mark.

URLs in a backlog arrive from Jira and from git, so they are somebody else's input. The host only
follows `http` and `https`: `openExternal` will act on a `command:` URI, which would let a crafted
issue description run a VS Code command, and `file:` would open arbitrary local paths. Anything
else is refused with a message rather than ignored.

**Next step for links, not yet done:** push them as Jira *remote issue links* rather than only
rendering them in the description. Jira shows those in the issue's own Links section, and the API
takes a `globalId`, which gives the same update-rather-than-duplicate behaviour the stamp labels
already provide. It costs one extra call per item, which is why it is staged rather than in.

**Known gap:** `priority` and `points` are rendered into the description, not written to Jira's own
priority and story-point fields. Both need per-instance field discovery, since the story-point
field id differs between instances.

## What a run costs

Every model request consumes one of the user's Copilot premium requests, and the output channel
now logs each one:

```
Copilot request 1 — emit_prd_structure, 7,240 input tokens
Copilot request 2 — emit_epics, 8,110 input tokens
```

Rough shape of a run: a decomposition with the critic pass is **4 requests**, story generation is
**one per 3 epics**, and a quality review is **one per 4 items**. A full pass over a six-epic
backlog with thirty stories is therefore around **twenty requests**. On a 300-a-month allowance
that adds up faster than people expect, and it is worth knowing before proposing this to a client
as a daily tool.

It is also the first thing to check when a request fails for no obvious reason: an exhausted quota
does not always come back as a clean error, and the Copilot extension's own output channel
(View → Output → GitHub Copilot Chat) logs the real HTTP status behind a transport-level failure.

## When Copilot fails at the network layer

`net::ERR_HTTP2_PROTOCOL_ERROR` and its relatives come from the Copilot extension's own network
stack, not from the model. They say nothing about the request and are usually gone a second later.

ReqForge retries them: three attempts at 1s, 3s and 7s, with the reason written to the output
channel and the wait shown in the panel, so a pause is explicable rather than looking like a hang.
Refusals and permissions failures are deliberately excluded — retrying those burns quota to be
told the same thing again.

If all four attempts fail you get "Copilot could not be reached", which says it is a network
problem rather than a problem with your requirements, and that nothing was lost. A VPN or
corporate proxy is the usual culprit.

The request is also capped at 120k tokens regardless of what the model advertises. The "Auto"
model reports close to a million, which is a routing promise rather than a per-request budget;
taking it literally means never trimming a long document and sending a request large enough to
fail at the transport.

## Quality rubric

Every item is scored, and items must pass a threshold before they can be sent to Jira.

**The model never produces a score.** It rates each *named criterion* 0–3 against a supplied
definition and explicit anchors, and must justify each rating by citing the text that earned it.
The score is computed in `score.ts` from those ratings and configurable weights. A number a model
invented is not reproducible and cannot be argued with; a number derived from *"Independent: 1 —
this cannot start until the schema story lands"* can be.

- **Stories: INVEST** (Wake, 2003) verbatim — Independent, Negotiable, Valuable, Estimable,
  Small, Testable.
- **Epics: no equally canonical rubric exists.** INVEST gets stretched to fit, but "Negotiable"
  and "Small" mean little at quarter scale. So: the INVEST ideas that transfer, plus
  Outcome-focused, Coherent, Bounded, Right-sized, and **Traceable** — the last is what a
  regulated client actually audits, and why `sourceEvidence` has been in the schema from the start.
- **20 deterministic rules** run on every edit with no model call: missing acceptance criteria,
  incomplete given/when/then, dangling dependencies, generic personas, untestable language,
  layer-shaped epic titles, a "so that" that merely restates the "I want".

`score = Σ(rating × weight) / Σ(3 × weight) × 100`, default threshold **70**.

Three properties worth knowing, each covered by a test because each is a way this could quietly
go wrong:

- **Blockers fail an item at any score.** An epic with no acceptance criteria and all-3 ratings
  scores 100 and still fails. A well-written story that is incomplete is not a good story.
- **Disabling a criterion does not cap the maximum** — a client who zeroes out Traceable can
  still reach 100.
- **Unassessed criteria are excluded, not scored zero**, so a partial assessment cannot fake a
  bad score. An item nobody has reviewed reads as "not reviewed", never as passing.

Assessments are cached by content fingerprint in `.reqforge/<slug>.quality.json`, so editing an
item invalidates its score rather than showing a stale one. The model pass is batched — Copilot
offers no prompt caching, so one call per story would burn quota for nothing.

### What a failure actually stops

Two different things are being judged, and they are treated differently.

**Structural problems always block.** No acceptance criteria, an incomplete given/when/then, a
dependency that does not exist — these are facts about the item, not opinions about it, and no
setting lets one through. The message names them: *"3 × No acceptance criteria"*.

**A low score does not block, by default.** It is a judgement, and a backlog nobody can move is
worse than one that ships honest about itself. The item goes to Jira carrying:

- **Labels** — `reqforge-quality-below-threshold`, plus up to three naming the weakest criteria
  (`reqforge-needs-testable`), or `reqforge-not-reviewed`, or `reqforge-quality-ok`. Filterable,
  dashboard-able, and valid Jira labels (no whitespace, checked by a test).
- **A one-line note** appended to the description, because a label cannot hold a sentence:
  *"Quality: 55/100, below the threshold of 70. Weakest: Testable 0/3, Independent 0/3."*

On update these are applied with Jira's label **add/remove operations**, not a whole-array write,
so labels somebody added in Jira by hand survive, and quality labels that no longer apply are
cleared instead of piling up.

| `enforcement` | Effect on a low-scoring item |
|---|---|
| `label` *(default)* | Sent, tagged with what fell short |
| `warn` | A modal names them; "Send Anyway" proceeds |
| `block` | Refused |

Only items whose epic is **ticked for inclusion** are considered, so unticking an epic takes it
out of both the gate and the send. `requireReview` (default `false`) decides whether a
never-reviewed item counts as failing; under `label` that only changes which tag it gets.

### Three ways to clear a failure

1. **Edit it.** Every field is editable in place, and the deterministic rules re-run on each
   keystroke, so blockers clear as you type. The model score goes stale on edit — by design — and
   the item reads "not reviewed" until you re-review it.
2. **Fix with AI.** Turns the findings into a refine instruction and runs the normal diff review.
3. **Dismiss or accept.** A rule that is right ninety times is wrong the ninety-first, and a
   criterion can misjudge an item whose context lives outside the text. `dismiss` waives one
   finding, `Accept anyway` passes an item scoring below the threshold. Both demand a written
   reason, both stay visible on the item afterwards rather than disappearing into a pass, and both
   survive editing so nobody has to re-justify after fixing a typo.

**Acceptance cannot buy off a blocker.** An epic with no acceptance criteria stays failed however
many people accept it — otherwise the gate means nothing. Covered by a test.

### Working through the failures

The rail filters by readiness — All / Needs work / Not reviewed / Ready, with live counts — and
an epic's readiness is **the worst of itself and its stories**. An epic that reads perfectly but
whose stories are unusable is not ready, and the filter says so. Inside an epic, a "N need work"
toggle narrows the story list the same way. The detail pane follows the filter rather than
leaving a hidden item on screen.

Alongside it, `all shown` / `none` set which epics are included in the next send, so the useful
workflow — filter to Ready, include all shown, send — is three clicks.

### Making it your own standard

```yaml
# .reqforge/rubric.yaml
threshold: 80
enforcement: block          # or warn, to allow an override with a confirmation
weights:
  epic-traceable: 2         # this client audits traceability
  invest-negotiable: 0      # and does not care about this one
rules:
  has-evidence: blocker
  sizing-xl: off
```

"Create rubric file" in the panel writes a commented starting point listing every rule and
criterion id. The client's Definition of Ready then lives in git and gets reviewed like anything
else — which is also the mechanism that makes this reusable across clients.

## Working on an epic that already exists

Fetching a Jira epic does not open a second editor. The issue and its children are parsed back
into the same `Backlog` shape the PRD path produces, which means everything built for that path
applies unchanged: structured fields, the rubric, "generate stories", "add story", undo, and a
push that updates rather than creates.

That works because a description ReqForge wrote is structured markdown, and `parseIssue.ts` is the
exact inverse of the renderers. The round trip is the contract — render an epic, parse it back,
and every field must survive — so it is covered by 20 tests. Without them, editing an existing
epic would quietly drop a field the first time somebody saved.

An issue **nobody generated** has no structure to read back. Its description lands in the
description field, acceptance criteria come back empty, and the rubric immediately says so. That
is the right answer: a hand-written epic with no testable criteria genuinely does not have any.
The panel says as much when it loads one.

**Rules that reason about the whole set know they only have a slice.** A dependency on an epic
that is not present is a broken reference inside a complete decomposition, and an ordinary
external dependency inside one epic pulled out of Jira — so the first blocks and the second is
reported as information. Likewise traceability: an imported epic has no source document, so
demanding evidence of one is noise. `RuleContext.partial` carries the distinction, set from
`source.kind`.

**A story key gives you a story.** It is placed under its real parent epic where it has one, so
editing keeps its context and a push updates the right things. A story with no parent goes under a
*container* — a local grouping that is never created in Jira, never planned into a push, and never
judged by the rubric, because somebody who fetched one story did not ask for a new epic.

Two details worth knowing:

- Children are read with one `parent = KEY` search returning full detail, not a search followed by
  a fetch per result — an epic with twenty stories would otherwise cost twenty-one calls and trip
  the rate limiter on a small tenant. Projects that do not model children as `parent` lose the
  stories, not the whole operation.
- Everything is marked as matching Jira on arrival, so the panel does not open claiming that an
  epic you have not touched needs sending.

## The pipeline

PRD → epics runs in stages rather than one call. Each is separately retryable and separately inspectable, and the intermediate skeleton is itself a deliverable — the open questions it surfaces are often the most valuable output of the whole run.

```
ingest → extract skeleton → propose epics → critique → revise → [review] → push
                                                ↑ optional, 2 extra calls
```

The critic pass is worth its cost: asking a second call "which of these overlap, which have untestable criteria, which are sliced by technical layer" measurably improves the result, and the findings are surfaced in the output channel so you can show the reasoning during a demo.

Stories are generated in batches of 3 epics. Under Copilot there is no prompt caching, so per-epic calls would re-send the full context every time and burn premium requests; batching is the mitigation.

### Structured output

Never prompt for JSON in prose. Every stage forces a single required tool call (`LanguageModelChatToolMode.Required`) with a hand-written JSON Schema, validates the result with zod, and on failure retries **once** with the validation error fed back to the model. Beyond one retry the fault is usually the schema rather than the model, and more retries just burn quota.

JSON Schemas are hand-written in `src/core/toolSchemas.ts` rather than generated from zod: generated output carries `$ref`s that some backends handle poorly, and the field descriptions there are prompt engineering, not documentation. **They must be kept in step with `src/core/schemas.ts` by hand.**

---

## Configuration

| Setting | Notes |
|---|---|
| `reqforge.atlassian.baseUrl` | `https://acme.atlassian.net` |
| `reqforge.atlassian.email` | Account paired with the API token |
| `reqforge.jira.projectKey` | Target project |
| `reqforge.jira.epicIssueType` / `storyIssueType` | Default `Epic` / `Story` |
| `reqforge.llm.modelFamily` | Blank = pick the largest available context window |
| `reqforge.push.dryRunDefault` | Default `true` |

The API token lives in `SecretStorage` (OS keychain) and never in `settings.json`. Set it with `ReqForge: Set Atlassian API Token`.

Stories are linked to epics with the `parent` field, which works in both team-managed and company-managed projects. The legacy Epic Link custom field is deprecated and deliberately unused.

---

## Demo runbook

Do this dry once, end to end, before the client is watching.

1. **The day before:** run `ReqForge: Check Language Model Availability`. Confirm both lines say OK.
2. **The day before:** run a full decomposition on the actual PRD you will demo, push it to a **scratch** project, then delete the issues. This surfaces mandatory-field surprises while you can still fix them.
3. Point `reqforge.jira.projectKey` at the demo project.
4. Open the ReqForge view in the activity bar so the tree is visible from the start.

Demo order that tells the best story:

1. Decompose the PRD. While it runs, talk about the staged pipeline.
2. **Show the open questions first** in the output channel — they land harder than the epics, because they are the thing a human reviewer would have taken an afternoon to find.
3. Open the YAML backlog. Edit one epic title by hand. This is the moment the "backlog as reviewable code" idea lands.
4. Generate stories for two epics.
5. Dry run. Show the plan.
6. Push. Show the tree turn green and open a real Jira issue.
7. Run it a second time — show that nothing duplicates. This is the trust-builder.
8. Refine an epic with a plain-English instruction. Show the diff. Apply.

If the network or SSO fails on stage, set `reqforge.llm.provider` to `fixture` — but note the fixture recorder is not built yet (see below).

---

## Not built yet

Honest list of what a weekend did not cover:

- **MCP adapter** (`src/adapters/atlassian/mcp.ts`) — interface and registry slot exist; the adapter does not. Out of scope for the restricted client by policy.
- **Anthropic LLM adapter** — same.
- **Fixture recorder.** `FixtureLlmAdapter` replays fixtures, but nothing writes them yet, and the `reqforge.llm.recordFixtures` setting referenced in its doc comment does not exist. Offline demo mode is therefore not usable as shipped.
- **Reordering and moving stories between epics.** Splitting an epic still means adding a new one and retyping.
- **Story points as a real Jira field.** `points` is rendered into the description text, not written to the story-points custom field, whose id differs per instance.
- **Copilot agent-mode tools.** Expose the pipeline stages via `vscode.lm.registerTool` so Copilot agent mode can drive them conversationally. Tools must call the core (so dry-run and idempotency still apply), and every write tool must return `confirmationMessages` from `prepareInvocation`. Not MCP — no new egress — so it should survive the client's policy, but confirm agent mode itself is permitted.
- **Contract test suite** across adapters — worth writing before the MCP adapter, not after.
- **Confluence write-back** (posting the epic breakdown to the PRD page as a child page).
- **Sub-tasks, sprint assignment, components.** `NewIssue` covers summary, description, labels, parent only.
- **Automated tests beyond `scripts/smoke.mjs`**, which covers the pure converters, hashing, and serialization — not the pipeline, the adapters, or the UI.
