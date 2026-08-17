/**
 * Contract tests for AtlassianPort — the adapters both profiles have.
 *
 * Runs the shared suite in contractShared.mjs against the REST adapter over a
 * stubbed fetch. The MCP adapter runs the same suite in contract.full.mjs; that
 * file, and the code it tests, are absent from the restricted repo.
 *
 *   node scripts/contract.mjs
 */
import * as esbuild from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BASE, createChecker, installFetchStub, newTenant, runContract } from './contractShared.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'reqforge-contract-'));
const entry = path.join(dir, 'entry.mjs');

writeFileSync(
  entry,
  `
export { AtlassianRestAdapter } from '${path.resolve('src/adapters/atlassian/rest.ts')}';
export { withCachedPrefix } from '${path.resolve('src/core/prompts.ts')}';
`
);

const out = path.join(dir, 'bundle.cjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  outfile: out,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  nodePaths: [path.resolve('node_modules')],
  logLevel: 'warning'
});

const { AtlassianRestAdapter, withCachedPrefix } = createRequire(import.meta.url)(out);
const { check, section, summary } = createChecker();

{
  const tenant = newTenant();
  const restore = installFetchStub(tenant);
  try {
    const rest = new AtlassianRestAdapter({ baseUrl: BASE, email: 'po@example.com', apiToken: 'token' });
    await runContract({ check, section }, 'rest', rest, tenant);

    section('Contract: rest — capability boundaries');
    check('rest: does not advertise graph.search', !rest.capabilities().has('graph.search'));
    let threw = false;
    try {
      await rest.semanticSearch('anything');
    } catch {
      threw = true;
    }
    check('rest: semanticSearch throws rather than returning []', threw);
  } finally {
    restore();
  }
}

section('Cached prefix: adapters without caching must inline it');
{
  const msgs = [{ role: 'user', content: 'body' }];
  check('prefix is prepended to the first message', withCachedPrefix(msgs, 'PREFIX')[0].content === 'PREFIX\n\nbody');
  check('no prefix leaves the messages alone', withCachedPrefix(msgs)[0].content === 'body');
  check('an empty prefix leaves the messages alone', withCachedPrefix(msgs, '')[0].content === 'body');
  check(
    'only the first message is touched',
    withCachedPrefix([...msgs, { role: 'assistant', content: 'reply' }], 'P')[1].content === 'reply'
  );
  check('a prefix with no messages still travels', withCachedPrefix([], 'P')[0].content === 'P');
}

process.exit(summary());
