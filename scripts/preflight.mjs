/**
 * Headless Atlassian preflight — the half of "Check Language Model Availability"
 * that does not need VS Code.
 *
 * The Copilot half cannot run here: vscode.lm only exists inside an extension
 * host. Run that from the command palette.
 *
 * Credentials come from the environment, not the keychain: the extension stores
 * the token in VS Code SecretStorage, which is deliberately not readable from a
 * plain script.
 *
 *   REQFORGE_BASE_URL=https://acme.atlassian.net \
 *   REQFORGE_EMAIL=you@acme.com \
 *   REQFORGE_TOKEN=... \
 *   REQFORGE_PROJECT=ACME \
 *   npm run preflight [-- <confluence-page-url-or-id>]
 *
 * Exercises the real adapter, not a reimplementation, so a pass here means the
 * extension's Atlassian path works against this tenant.
 */
import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const env = {
  baseUrl: process.env.REQFORGE_BASE_URL ?? '',
  email: process.env.REQFORGE_EMAIL ?? '',
  apiToken: process.env.REQFORGE_TOKEN ?? '',
  project: process.env.REQFORGE_PROJECT ?? '',
  epicType: process.env.REQFORGE_EPIC_TYPE ?? 'Epic',
  storyType: process.env.REQFORGE_STORY_TYPE ?? 'Story'
};

const VAR_NAMES = { baseUrl: 'REQFORGE_BASE_URL', email: 'REQFORGE_EMAIL', apiToken: 'REQFORGE_TOKEN' };
const missing = Object.keys(VAR_NAMES).filter((k) => !env[k]);
if (missing.length) {
  console.error(
    `Missing: ${missing.map((k) => VAR_NAMES[k]).join(', ')}\n` + 'See the header of scripts/preflight.mjs for usage.'
  );
  process.exit(2);
}

const dir = mkdtempSync(path.join(tmpdir(), 'reqforge-preflight-'));
const out = path.join(dir, 'bundle.cjs');
await esbuild.build({
  stdin: {
    contents: `export { AtlassianRestAdapter } from '${path.resolve('src/adapters/atlassian/rest.ts')}';`,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  outfile: out,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});

const { AtlassianRestAdapter } = createRequire(import.meta.url)(out);
const jira = new AtlassianRestAdapter(env);

let failed = 0;
const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail) => {
  failed++;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const warn = (label, detail) => console.log(`  warn  ${label}${detail ? `\n        ${detail}` : ''}`);

console.log(`\nReqForge preflight → ${env.baseUrl}\n`);

/* ------------------------------------------------------------------- auth */

const conn = await jira.verifyConnection();
conn.ok ? ok('authentication', conn.detail) : bad('authentication', conn.detail);
if (!conn.ok) {
  console.log('\nStopping: nothing else can pass without valid credentials.');
  process.exit(1);
}

/* ---------------------------------------------------------------- project */

if (!env.project) {
  warn('project checks skipped', 'set REQFORGE_PROJECT to validate issue types and required fields');
} else {
  try {
    const projects = await jira.listProjects();
    const match = projects.find((p) => p.key.toUpperCase() === env.project.toUpperCase());
    match
      ? ok(`project ${match.key}`, match.name)
      : bad(`project ${env.project}`, `not found. Visible projects: ${projects.map((p) => p.key).join(', ') || '(none)'}`);

    if (match) {
      const types = await jira.listIssueTypes(match.key);
      const names = types.map((t) => t.name);
      ok('issue types', names.join(', '));

      for (const [label, wanted] of [
        ['epic issue type', env.epicType],
        ['story issue type', env.storyType]
      ]) {
        const hit = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
        hit
          ? ok(`${label} "${wanted}"`)
          : bad(`${label} "${wanted}"`, `not in this project. Set reqforge.jira.${label.startsWith('epic') ? 'epicIssueType' : 'storyIssueType'} to one of: ${names.join(', ')}`);
      }

      // The check that most often turns into a mid-demo 400.
      for (const [label, wanted] of [
        ['epic', env.epicType],
        ['story', env.storyType]
      ]) {
        if (!names.some((n) => n.toLowerCase() === wanted.toLowerCase())) continue;
        try {
          const required = await jira.requiredFields(match.key, wanted);
          required.length === 0
            ? ok(`${label} required fields`, 'none beyond what ReqForge populates')
            : bad(
                `${label} required fields`,
                `ReqForge does not populate: ${required.join(', ')}\n        Creates will be rejected with a 400 until these get a default or become optional.`
              );
        } catch (err) {
          bad(`${label} required fields`, err.message);
        }
      }

      // Confirms the search path the idempotency stamp depends on.
      try {
        await jira.searchIssues(`project = "${match.key}" AND labels = "reqforge-preflight-probe"`, 1);
        ok('JQL search', 'idempotency lookups will work');
      } catch (err) {
        bad('JQL search', `${err.message}\n        Re-runs would create duplicates instead of adopting existing issues.`);
      }
    }
  } catch (err) {
    bad('project checks', err.message);
  }
}

/* ------------------------------------------------------------- confluence */

const page = process.argv[2];
if (!page) {
  warn('confluence check skipped', 'pass a page URL or id as an argument to test ingestion');
} else {
  try {
    const doc = await jira.getConfluencePage(page);
    const words = doc.markdown.split(/\s+/).filter(Boolean).length;
    if (words < 50) {
      bad(
        `confluence page ${doc.id}`,
        `"${doc.title}" converted to only ${words} words. The page is probably empty, or its content sits in a macro the converter drops.`
      );
    } else {
      ok(`confluence page ${doc.id}`, `"${doc.title}", v${doc.version ?? '?'}, ${words} words of markdown`);
      console.log('\n  --- first 400 characters of ingested markdown ---');
      console.log(
        doc.markdown
          .slice(0, 400)
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')
      );
      console.log('  ---\n');
      console.log('  Read that. If it looks wrong, the epics will be wrong too.');
    }
  } catch (err) {
    bad('confluence page', err.message);
  }
}

console.log(failed === 0 ? '\nAtlassian side looks good.' : `\n${failed} check(s) failed.`);
console.log('Still to verify inside VS Code: "ReqForge: Check Language Model Availability" (Copilot cannot be tested from a terminal).');
process.exit(failed === 0 ? 0 : 1);
