/**
 * Asks an MCP server what it can do, and shows how ReqForge would route it.
 *
 * The tool-name patterns in mcpRouting.ts are informed guesses — no live
 * Atlassian tenant has been connected to yet. This prints the server's actual
 * tool list beside the resolution ReqForge derives from it, so a mismatch is a
 * visible line rather than a mysterious failure three screens into a demo.
 *
 * Runs standalone: no VS Code, no extension install, no settings.
 *
 *   node scripts/probeMcp.mjs "npx -y mcp-remote https://mcp.atlassian.com/v1/sse"
 *   node scripts/probeMcp.mjs "https://my-self-hosted-server/mcp"
 *
 * The stdio form owns its own OAuth: it opens a browser on first run, and
 * caches credentials under ~/.mcp-auth. Nothing is sent to this script.
 */
import * as esbuild from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const endpoint = process.argv[2] ?? 'npx -y mcp-remote https://mcp.atlassian.com/v1/sse';

const dir = mkdtempSync(path.join(tmpdir(), 'reqforge-probe-'));
const entry = path.join(dir, 'entry.mjs');
writeFileSync(
  entry,
  `
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
export { resolveTools, capabilitiesFrom, describeRouting } from '${path.resolve('src/adapters/atlassian/mcpRouting.ts')}';
`
);

const out = path.join(dir, 'bundle.cjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  outfile: out,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  nodePaths: [path.resolve('node_modules')],
  logLevel: 'error'
});

const {
  Client,
  StdioClientTransport,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  resolveTools,
  capabilitiesFrom,
  describeRouting
} = createRequire(import.meta.url)(out);

function makeTransport() {
  const trimmed = endpoint.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return /\/sse\b/i.test(url.pathname) ? new SSEClientTransport(url) : new StreamableHTTPClientTransport(url);
  }
  const parts = trimmed.replace(/^stdio:/, '').split(/\s+/);
  const command = parts.shift();
  return new StdioClientTransport({ command, args: parts });
}

console.log(`\nConnecting to: ${endpoint}`);
console.log('A browser may open for sign-in on first run.\n');

const client = new Client({ name: 'reqforge-probe', version: '0.1.0' }, { capabilities: {} });

try {
  await client.connect(makeTransport());
} catch (err) {
  console.error(`Could not connect: ${err.message}`);
  process.exit(1);
}

const { tools } = await client.listTools();
console.log(`Server exposes ${tools.length} tool(s):\n`);
for (const t of tools) {
  const args = Object.keys(t.inputSchema?.properties ?? {});
  console.log(`  ${t.name}`);
  if (args.length) console.log(`      args: ${args.join(', ')}`);
}

const routing = resolveTools(
  tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
);

console.log('\nReqForge would route them as:\n');
console.log(describeRouting(routing));

const caps = [...capabilitiesFrom(routing)].sort();
console.log(`\nCapabilities granted: ${caps.length ? caps.join(', ') : '(none)'}`);

if (routing.unresolved.length > 0) {
  console.log(`\nUnresolved operations: ${routing.unresolved.join(', ')}`);
  console.log('  Add a name pattern for these to OP_PATTERNS in src/adapters/atlassian/mcpRouting.ts.');
}
if (routing.unused.length > 0) {
  console.log(`\nTools ReqForge made no use of:\n  ${routing.unused.join('\n  ')}`);
}
if (!caps.includes('graph.search')) {
  console.log('\nNo Teamwork Graph search tool matched — "Check existing" will be unavailable.');
}

await client.close();
process.exit(0);
