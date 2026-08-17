import { runPanel } from './core/agents/panel';
import { REVIEWERS } from './core/agents/reviewers';
import { findDuplicates } from './core/pipeline/duplicates';
import { AnthropicLlmAdapter } from './adapters/llm/anthropic';
import { AtlassianMcpAdapter } from './adapters/atlassian/mcp';
import { AtlassianRestAdapter } from './adapters/atlassian/rest';
import { CopilotLlmAdapter } from './adapters/llm/copilot';
import { FixtureLlmAdapter } from './adapters/llm/fixture';
import type { AtlassianPort, LlmPort } from './core/ports';
import type { AdapterContext, AdapterRegistry } from './registryTypes';

/**
 * FULL PROFILE — for use outside the restricted client.
 *
 * NOT YET IMPLEMENTED: the MCP transport and the Anthropic LLM provider. Both
 * are declared here so the shape of the extension does not change when they
 * land, and so the contract tests have something to target.
 *
 * When you build them:
 *   - src/adapters/atlassian/mcp.ts    — @modelcontextprotocol/sdk client,
 *     listTools() at connect time and route by discovered name rather than
 *     hardcoding, since server tool names drift between versions.
 *   - src/adapters/llm/anthropic.ts    — tool-use for structured output, plus
 *     prompt caching on the PRD across the per-epic story calls.
 * Only this file may import them. The restricted build must stay clean.
 */
export const registry: AdapterRegistry = {
  profile: 'full',

  availableTransports: ['rest', 'mcp'],
  availableLlmProviders: ['copilot', 'anthropic', 'fixture'],

  // Only reachable from here, so the restricted bundle does not contain it.
  agents: { reviewers: REVIEWERS, runPanel, findDuplicates },

  createAtlassian(ctx: AdapterContext): AtlassianPort {
    if (ctx.transport === 'mcp') {
      return new AtlassianMcpAdapter({
        endpoint: ctx.mcpEndpoint ?? '',
        baseUrl: ctx.baseUrl,
        // A bearer token is only sent to an http(s) endpoint the user configured
        // themselves. The usual path is the stdio proxy, which owns its own
        // OAuth flow and never sees this value.
        headers: ctx.apiToken ? { Authorization: `Bearer ${ctx.apiToken}` } : undefined
      });
    }
    return new AtlassianRestAdapter({ baseUrl: ctx.baseUrl, email: ctx.email, apiToken: ctx.apiToken });
  },

  createLlm(ctx: AdapterContext): LlmPort {
    switch (ctx.llmProvider) {
      case 'anthropic':
        return new AnthropicLlmAdapter({
          apiKey: ctx.anthropicApiKey ?? '',
          model: ctx.modelFamily || undefined,
          onRetry: ctx.onLlmRetry,
          onCall: ctx.onLlmCall
        });
      case 'fixture':
        return new FixtureLlmAdapter(ctx.fixtures ?? {});
      case 'copilot':
      default:
        return new CopilotLlmAdapter(ctx.modelFamily || undefined, ctx.onLlmRetry, ctx.onLlmCall);
    }
  }
};
