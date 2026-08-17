/**
 * Checks what is actually inside a packaged VSIX.
 *
 * The compliance guard runs during the build and inspects `dist/`. That is not
 * the same thing as inspecting the artifact: `vsce package` runs the
 * `vscode:prepublish` hook itself, so anything that hook does lands in the
 * package *after* the guard has already passed. That is not hypothetical — it
 * shipped a restricted bundle inside reqforge-full.vsix, with a clean guard
 * report, because prepublish rebuilt dist on top of the full build.
 *
 * So this verifies the shipped bytes, and it verifies in both directions: the
 * restricted package must not contain full-profile code, and the full package
 * must contain it. A "clean" result that is clean because the feature is
 * missing entirely is the failure this is here to catch.
 *
 *   node scripts/verifyVsix.mjs reqforge-full.vsix full
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [, , vsixPath, expected] = process.argv;
if (!vsixPath || !['restricted', 'full'].includes(expected)) {
  console.error('usage: node scripts/verifyVsix.mjs <file.vsix> <restricted|full>');
  process.exit(2);
}

/** Strings only the full profile's code can produce. */
const FULL_ONLY = [
  'modelcontextprotocol', // the MCP client
  'jsonrpc', // MCP wire envelope — lowercase, because packaging minifies
  'api.anthropic.com', // the Anthropic provider
  'emit_conflicts', // the reviewer panel's reconciler
  'emit_duplicate_verdicts' // Teamwork Graph duplicate detection
];

/**
 * Files that are somebody's content, not the product.
 *
 * A VSIX built in a workspace where the tool had been used shipped that
 * workspace's backlog — a real Jira epic, its quality cache and its panel
 * findings — because .reqforge is gitignored and was therefore invisible to
 * every check that looked at the repository rather than at the package.
 */
const MUST_NOT_SHIP = [/(^|\/)\.reqforge\//, /\.backlog\.yaml$/, /\.quality\.json$/, /\.panel\.json$/];

const dir = mkdtempSync(path.join(tmpdir(), 'reqforge-vsix-'));
let failures = 0;

try {
  execFileSync('unzip', ['-q', path.resolve(vsixPath), '-d', dir]);
  const bundle = readFileSync(path.join(dir, 'extension', 'dist', 'extension.js'), 'utf8');

  const listed = execFileSync('unzip', ['-Z1', path.resolve(vsixPath)], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const leaked = listed.filter((entry) => MUST_NOT_SHIP.some((re) => re.test(entry)));
  if (leaked.length > 0) {
    console.error(`  VSIX VERIFY FAILED — ${vsixPath} contains user content:`);
    for (const entry of leaked) console.error(`    - ${entry}`);
    console.error('  Add it to .vscodeignore. Gitignored is not the same as unpackaged.');
    failures++;
  }

  const found = FULL_ONLY.filter((needle) => bundle.includes(needle));
  const missing = FULL_ONLY.filter((needle) => !bundle.includes(needle));

  if (expected === 'restricted') {
    if (found.length > 0) {
      console.error(`  VSIX VERIFY FAILED — ${vsixPath} is meant to be restricted but contains:`);
      for (const f of found) console.error(`    - ${f}`);
      failures++;
    } else {
      console.log(`  vsix verify: ${path.basename(vsixPath)} is restricted (0 of ${FULL_ONLY.length} markers)`);
    }
  } else {
    // The interesting direction. A full package missing these is not "clean",
    // it is mislabelled — which is exactly how this failed the first time.
    if (missing.length > 0) {
      console.error(`  VSIX VERIFY FAILED — ${vsixPath} is meant to be full but is missing:`);
      for (const m of missing) console.error(`    - ${m}`);
      console.error('  The packaged bundle is not the full build. Check the vscode:prepublish hook.');
      failures++;
    } else {
      console.log(`  vsix verify: ${path.basename(vsixPath)} is full (${FULL_ONLY.length} of ${FULL_ONLY.length} markers)`);
    }
  }

  // Whichever profile it claims, the manifest must agree with the bytes.
  const declared = JSON.parse(readFileSync(path.join(dir, 'extension', 'package.json'), 'utf8'));
  if (!declared.main?.includes('dist/extension.js')) {
    console.error(`  VSIX VERIFY FAILED — unexpected entry point: ${declared.main}`);
    failures++;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
