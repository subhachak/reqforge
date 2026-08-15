# ReqForge

Decompose a Confluence PRD into fully-formed Jira epics and stories, review them in your editor, and push them — idempotently. Refine existing epics and stories against a plain-English instruction, with a diff before anything is written.

Built to run under a restrictive client policy: **no MCP, no third-party LLM providers**. The restricted build's only network destinations are your own Atlassian tenant and — indirectly, through VS Code's own client — GitHub Copilot.

---

## Quick start

```bash
npm install && npm run check
```

Then press <kbd>F5</kbd> in VS Code ("Run ReqForge (restricted profile)") to launch an Extension Development Host.

In the dev host, **open a folder first** — the backlog is stored workspace-relative — then
<kbd>⌘⇧P</kbd> → **`ReqForge: Open`**. That is the only command anybody needs.

**First run lands on setup and stays there.** Site, account email, API token and Jira project are
required before any other view is reachable — the host recomputes that gate on every render, so
it cannot be routed around from the webview. A half-configured tool fails later, in the middle of
real work, with errors that read like bugs.

**Once configured, the home screen offers two entry points and loads nothing on its own:**

- **Start from a PRD** — pick a Confluence page, get proposed epics, review, send to Jira.
- **Update an existing Jira issue** — type a key, pull the issue in, describe the change in plain
  English, review the rewrite, apply it.

Backlogs already saved on this machine are listed underneath as a "pick up where you left off"
list. That list is read from local files; nothing queries Jira until you ask it to.

The command palette entries (`Decompose Epic into Stories`, `Preview Push`, `Push Backlog to
Jira`, `Refine Existing Issue`, `Check Language Model Availability`) still exist as power-user
shortcuts and are what the headless paths are built on, but nobody needs them to use the tool.

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

Run `ReqForge: Check Language Model Availability`, then run one real decomposition against a representative PRD. If you get `LanguageModelError` with code `Blocked`, the mitigation is prompt framing, not architecture — all prompts in `src/core/prompts.ts` already lead with an engineering framing (`ENGINEER_PREAMBLE`) and use issue-tracker vocabulary throughout. Push harder in that direction before concluding it cannot work.

The adapter surfaces a refusal verbatim rather than swallowing it: if the model answers in prose instead of calling the emit-tool, that prose is included in the error, which tells you exactly what it objected to.

---

## Architecture

```
  Webview (React)        src/webview/         ← what a product owner sees
        │                review · inline edit · rewrite · send to Jira
        │  postMessage, typed by src/shared/protocol.ts
  VS Code layer          src/vscode/, src/extension.ts
        │                panel · commands · tree view · secrets
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
npm run package        # reqforge-restricted.vsix
```

The restricted build runs a **compliance guard** (`esbuild.mjs`) that greps the output bundle for `api.anthropic.com`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `mcp.atlassian.com`, and `api.openai.com`, and fails the build on a hit. Your client's security team will run that grep; better that your CI runs it first.

---

## What protects the demo

**Idempotency.** Every created issue is stamped with a label `reqforge-<pageId>-<ref>`. Before creating anything, the planner resolves each item against (1) the `jiraKey` recorded in the backlog file, then (2) a JQL search for that label. Re-running after a crash — or a colleague running the same command — adopts and updates instead of duplicating.

**The plan is always shown.** `planPush` writes nothing. Both push commands render the plan to a preview document first; the real push then requires an explicit modal confirmation stating exact counts.

**Required-field discovery.** Every Jira instance has a mandatory custom field somebody added in 2019. `requiredFields()` reads `createmeta` and warns up front, turning a mid-demo `400` into a preflight warning.

**Partial failure is saved.** `executePush` saves the backlog file even when some items fail, so the keys already obtained are never lost and the retry does not duplicate.

**Undo covers everything local, and stops at the push.** The host keeps up to 50 snapshots, so Undo reverses generated stories, accepted rewrites and deletions, not just typing — consecutive keystrokes collapse into one step. The history is cleared after a push on purpose: undoing past a push would roll back the Jira keys just recorded, and the next push would then duplicate issues that already exist. Local edits are reversible; sending is not.

**Content fidelity.** Confluence storage format is XHTML plus `ac:` macro tags. `storageFormat.ts` normalizes code macros, info/note/warning panels, expands, task lists, and tables before Turndown sees them — PRD content is very often inside an expand or a table, and silently losing it would produce a confidently wrong backlog.

---

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
