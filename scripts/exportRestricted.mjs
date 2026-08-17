/**
 * Generates the restricted client repository from this one.
 *
 * The client's strongest compliance position is not "the build flag excluded
 * it" — it is "the repository you were given contains no such code". That
 * survives a misconfigured build, and it is checkable by anyone with `grep`.
 * Maintaining it as a hand-kept fork would mean duplicating roughly eighty
 * percent of the source, which is where every bug in this project has actually
 * lived, so the restricted tree is generated instead.
 *
 * The file list is NOT hand-maintained. It comes from esbuild's metafile for
 * the restricted build, which is the real import graph: if a module is not
 * reachable from registry.restricted.ts, it is not in the bundle and it is not
 * exported. Add a full-profile import to shared code and this export stops
 * including that code, rather than silently leaking it.
 *
 *   node scripts/exportRestricted.mjs [target-dir]
 */
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.resolve(process.argv[2] ?? path.join(root, '..', 'reqforge-restricted'));

/**
 * Files the build graph cannot know about: tooling, tests, assets, docs.
 * Everything here must be free of full-profile references — verified below
 * rather than trusted, since that is the whole point of the exercise.
 */
const EXTRA_FILES = [
  'tsconfig.json',
  'esbuild.mjs',
  'LICENSE',
  '.gitignore',
  // Without this the packaged VSIX carries src/, scripts/ and node_modules —
  // 5.8MB instead of 250KB.
  '.vscodeignore',
  '.vscode/launch.json',
  // Type-only, so the build graph never sees it.
  'src/webview/css.d.ts',
  '.githooks/pre-push',
  'scripts/smoke.mjs',
  'scripts/contract.mjs',
  'scripts/contractShared.mjs',
  'scripts/harness.mjs',
  'scripts/preflight.mjs',
  'scripts/verifyVsix.mjs',
  'resources/icon.svg'
];

/** Scripts that only make sense where the full profile exists. */
const DROP_SCRIPTS = ['build:full', 'package:full', 'check:full', 'smoke:full', 'contract:full', 'export:restricted'];

/** Dependencies only the full profile needs. */
const DROP_DEPS = ['@modelcontextprotocol/sdk', '@anthropic-ai/sdk'];

/**
 * Text that would indicate full-profile *code* in the exported tree.
 *
 * Deliberately not the word "anthropic" on its own. The LlmPort union names
 * three providers and the settings UI can store a key for one it cannot use;
 * that is vocabulary, and the restricted registry rejects it at the seam. What
 * must be absent is the code — an SDK import, an adapter class, a reachable
 * agent module — and that is what these match. The build-graph check above is
 * the real guarantee; this is a second, cruder net for anything that arrives by
 * a route the bundler cannot see.
 */
const FORBIDDEN = [
  '@modelcontextprotocol/sdk',
  '@anthropic-ai/sdk',
  'api.anthropic.com',
  'mcp.atlassian.com',
  'AtlassianMcpAdapter',
  'AnthropicLlmAdapter',
  "core/agents",
  'registry.full'
];

/**
 * Files whose job is to name the forbidden strings: the compliance guard and
 * the VSIX verifier both work by grepping for them, so they necessarily
 * contain them. Excluding the guards from the guard is not a loophole — a
 * client can read both files and see exactly what is being checked.
 */
const SCAN_EXEMPT = ['esbuild.mjs', 'scripts/verifyVsix.mjs'];

/* ------------------------------------------------- work out what to copy */

const alias = { '@registry': path.join(root, 'src/registry.restricted.ts') };
const common = {
  bundle: true,
  write: false,
  metafile: true,
  logLevel: 'silent',
  alias,
  treeShaking: true
};

const [ext, web] = await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/extension.ts')],
    outfile: path.join(root, 'dist/_probe_ext.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode']
  }),
  esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/webview/index.tsx')],
    outfile: path.join(root, 'dist/_probe_web.js'),
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    loader: { '.css': 'css' }
  })
]);

const sourceFiles = [...Object.keys(ext.metafile.inputs), ...Object.keys(web.metafile.inputs)]
  .filter((f) => !f.includes('node_modules'))
  .map((f) => path.relative(root, path.resolve(root, f)))
  .filter((f) => f.startsWith('src' + path.sep) || f.startsWith('src/'));

/*
 * The metafile is the runtime graph, and TypeScript erases type-only imports —
 * so modules that exist purely as types (registryTypes.ts, for one) are absent
 * from it and the exported tree would not typecheck. Walk the copied sources
 * for relative specifiers and pull in whatever they reach, including
 * `import type`.
 *
 * The leak check runs after this expansion on purpose: a type-only import of a
 * full-profile module is still a reference the client would find, and it is
 * exactly the mistake that put core/agents into this graph an hour ago.
 */
const SPECIFIER = /(?:from|import)\s+['"](\.[^'"]+|@registry)['"]/g;
const CANDIDATES = ['', '.ts', '.tsx', '.css', '/index.ts', '/index.tsx'];

const resolveLocal = (fromFile, spec) => {
  const base =
    spec === '@registry'
      ? path.join(root, 'src/registry.restricted')
      : path.resolve(path.dirname(path.join(root, fromFile)), spec);
  for (const ext of CANDIDATES) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.relative(root, candidate);
  }
  return undefined;
};

const set = new Set(sourceFiles);
const queue = [...set];
while (queue.length > 0) {
  const file = queue.pop();
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const text = readFileSync(path.join(root, file), 'utf8');
  for (const match of text.matchAll(SPECIFIER)) {
    const resolved = resolveLocal(file, match[1]);
    if (resolved && !set.has(resolved)) {
      set.add(resolved);
      queue.push(resolved);
    }
  }
}

const unique = [...set].sort();

// The alias resolves @registry to the restricted file, so the full one can only
// appear if something imported it directly — which would be the bug this
// export exists to make impossible.
const leaked = unique.filter((f) => /registry\.full|core[\\/]agents|adapters[\\/]atlassian[\\/]mcp|adapters[\\/]llm[\\/]anthropic|duplicates/.test(f));
if (leaked.length > 0) {
  console.error('\n  EXPORT ABORTED — the restricted build graph reaches full-profile code:');
  for (const f of leaked) console.error(`    - ${f}`);
  process.exit(1);
}

/* ------------------------------------------------------------ write it out */

/*
 * Everything else is regenerated, because a stale leftover file is exactly the
 * kind of thing that survives into an audit. `.git` stays so the export can be
 * committed to an existing client repo; `node_modules` and `dist` stay because
 * they are generated, gitignored, and reinstalling them on every regeneration
 * buys nothing.
 */
const PRESERVE = new Set(['.git', 'node_modules', 'dist']);

if (existsSync(target)) {
  for (const entry of readdirSync(target)) {
    if (PRESERVE.has(entry)) continue;
    rmSync(path.join(target, entry), { recursive: true, force: true });
  }
} else {
  mkdirSync(target, { recursive: true });
}

const copy = (rel) => {
  const from = path.join(root, rel);
  if (!existsSync(from)) return false;
  const to = path.join(target, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
  return true;
};

let copied = 0;
for (const rel of unique) if (copy(rel)) copied++;

/*
 * A missing entry here is a silent hole, not a loud one: the list named
 * LICENSE.txt when the file is LICENSE, so the client's repository shipped with
 * no licence at all and nothing said so. Fail instead.
 */
const absent = EXTRA_FILES.filter((rel) => !existsSync(path.join(root, rel)));
if (absent.length > 0) {
  console.error('\n  EXPORT ABORTED — files listed in EXTRA_FILES do not exist:');
  for (const rel of absent) console.error(`    - ${rel}`);
  process.exit(1);
}
for (const rel of EXTRA_FILES) if (copy(rel)) copied++;

// registry.restricted.ts is reached through the alias, so the graph lists it
// under its real name already; @registry needs no special handling here.

/* -------------------------------------------------------------- manifest */

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const s of DROP_SCRIPTS) delete pkg.scripts[s];
for (const d of DROP_DEPS) delete pkg.dependencies[d];
pkg.scripts.package = pkg.scripts.package.replace('REQFORGE_PROFILE=restricted ', '');
pkg.scripts['vscode:prepublish'] = 'node esbuild.mjs --minify';

// Identity: the client build keeps the plain name. The full build is
// ReqForge Studio and lives in the source repo.
pkg.name = 'reqforge';
pkg.displayName = 'ReqForge';
pkg.description = 'Decompose Confluence PRDs into Jira epics and stories, and refine existing ones.';

// The transport and provider enums exist to describe what a build can do.
// Leaving 'mcp' and 'anthropic' in a manifest whose code cannot do either would
// be the settings-UI version of the same false claim this export removes.
const props = pkg.contributes.configuration.properties;
delete props['reqforge.atlassian.mcpEndpoint'];
props['reqforge.atlassian.transport'].enum = ['rest'];
props['reqforge.atlassian.transport'].markdownDescription = 'How to talk to Atlassian.';
props['reqforge.llm.provider'].enum = ['copilot', 'fixture'];
props['reqforge.llm.provider'].markdownDescription =
  'Language model backend. `fixture` replays recorded responses for offline demos.';
pkg.contributes.commands = pkg.contributes.commands.filter((c) => c.command !== 'reqforge.setAnthropicKey');
pkg.contributes.menus.commandPalette = pkg.contributes.menus.commandPalette.filter(
  (m) => m.command !== 'reqforge.setAnthropicKey'
);

writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

/* ------------------------------------------------------------------ README */

/*
 * Sections are dropped by content, not by name: any section that mentions
 * full-profile code is describing something this repository does not contain,
 * and documentation of absent features is worse than no documentation. Doing it
 * by content rather than by a list of headings means a new section about MCP
 * cannot be forgotten here later.
 */
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const sections = readme.split('\n## ');
const kept = sections.filter((section) => !FORBIDDEN.some((needle) => section.toLowerCase().includes(needle.toLowerCase())));
const dropped = sections.length - kept.length;
const trimmed = kept.join('\n## ');
writeFileSync(
  path.join(target, 'README.md'),
  trimmed.replace(
    '# ReqForge',
    '# ReqForge\n\n> Generated from the ReqForge Studio source repository. This tree contains only\n> the code the restricted profile builds: no MCP client, no third-party model\n> provider, and no multi-agent review. Do not edit it directly — changes belong\n> upstream and arrive here by regeneration.'
  )
);

/* ------------------------------------------------------------- verify it */

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') return [];
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const offenders = [];
for (const file of walk(target)) {
  if (/\.(png|svg|ico|vsix)$/.test(file)) continue;
  if (SCAN_EXEMPT.includes(path.relative(target, file))) continue;
  const text = readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    // package-lock is not exported, and the README's prose about what is
    // absent would otherwise trip the check on the word itself.
    if (text.toLowerCase().includes(needle.toLowerCase())) {
      offenders.push(`${path.relative(target, file)} — ${needle}`);
    }
  }
}

if (offenders.length > 0) {
  console.error('\n  EXPORT FAILED — forbidden references in the exported tree:');
  for (const o of [...new Set(offenders)]) console.error(`    - ${o}`);
  process.exit(1);
}

console.log(`  exported ${copied} files to ${target}`);
console.log(`  dropped ${dropped} README section(s) describing absent features`);
console.log(`  no full-profile references (${FORBIDDEN.length} patterns checked)`);
console.log(`\n  next: cd ${target} && npm install && npm run check`);
