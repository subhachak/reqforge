import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
/**
 * Profile comes from the flag, then the environment, then the safe default.
 *
 * The environment matters because `vsce package` runs `vscode:prepublish`
 * itself, with no way to pass it a flag. When that hook was hardcoded to
 * restricted it rebuilt `dist/` on top of a full build, and `package:full`
 * shipped a restricted bundle under a full name.
 */
const profile =
  (args.find((a) => a.startsWith('--profile=')) ?? `--profile=${process.env.REQFORGE_PROFILE ?? 'restricted'}`).split(
    '='
  )[1];
const watch = args.includes('--watch');
const minify = args.includes('--minify');

if (!['restricted', 'full'].includes(profile)) {
  throw new Error(`Unknown profile "${profile}". Expected "restricted" or "full".`);
}

/**
 * Strings that must never appear in a restricted bundle. The client's security
 * review will unzip the VSIX and grep it; better that our own build fails first.
 */
const FORBIDDEN_IN_RESTRICTED = [
  'api.anthropic.com',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
  'mcp.atlassian.com',
  'api.openai.com',
  // Protocol-level strings rather than package names. A bundler could in
  // principle drop the specifier while keeping the code; these are wire
  // constants the MCP client cannot function without, so they survive
  // minification and cannot be renamed away.
  'notifications/initialized',
  'tools/call',
  // Lowercase: the wire field name in every JSON-RPC envelope. The uppercase
  // `JSONRPC` used to be here and was inert — it is an identifier prefix, and
  // packaging minifies, so it was renamed away before the guard ever saw it.
  'jsonrpc',
  // Not a policy rule — the reviewer panel only ever talks to Copilot, which
  // the client permits. This is the architectural invariant: full-profile code
  // must be absent from the restricted bundle rather than merely unreachable
  // behind a runtime branch, because only absence can be checked from outside.
  // These are emit-tool names, which survive minification and cannot be
  // renamed away.
  'emit_conflicts',
  'emit_duplicate_verdicts'
];

/** Fails the build if a restricted bundle contains anything it should not. */
const complianceGuard = {
  name: 'compliance-guard',
  setup(build) {
    build.onEnd((result) => {
      if (profile !== 'restricted' || result.errors.length > 0) return;
      const outfile = build.initialOptions.outfile;
      if (!outfile) return;
      const bundle = readFileSync(outfile, 'utf8');
      const hits = FORBIDDEN_IN_RESTRICTED.filter((needle) => bundle.includes(needle));
      if (hits.length > 0) {
        console.error(
          `\n  COMPLIANCE GUARD FAILED\n  Restricted bundle contains forbidden references:\n` +
            hits.map((h) => `    - ${h}`).join('\n') +
            `\n  Something imported a full-profile adapter. Check src/registry.restricted.ts.\n`
        );
        process.exitCode = 1;
      } else {
        console.log(`  compliance guard: clean (${FORBIDDEN_IN_RESTRICTED.length} patterns checked)`);
      }
    });
  }
};

// The single seam between the two builds. Only the registry files import
// adapters, so the unused ones are never pulled into the graph at all.
const alias = { '@registry': path.join(root, `src/registry.${profile}.ts`) };

/** Runs in the extension host: Node, CJS, `vscode` provided by the runtime. */
const extensionOptions = {
  entryPoints: [path.join(root, 'src/extension.ts')],
  bundle: true,
  outfile: path.join(root, 'dist/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !minify,
  minify,
  treeShaking: true,
  logLevel: 'info',
  define: { 'process.env.REQFORGE_PROFILE': JSON.stringify(profile) },
  alias,
  plugins: [complianceGuard]
};

/** Runs in the webview: a browser sandbox with no Node and no network. */
const webviewOptions = {
  entryPoints: [path.join(root, 'src/webview/index.tsx')],
  bundle: true,
  outfile: path.join(root, 'dist/webview.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: !minify,
  minify,
  treeShaking: true,
  logLevel: 'info',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': JSON.stringify(minify ? 'production' : 'development') },
  alias,
  plugins: [complianceGuard]
};

if (watch) {
  for (const options of [extensionOptions, webviewOptions]) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log(`watching (profile: ${profile})`);
} else {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
  console.log(`built profile: ${profile}`);
}
