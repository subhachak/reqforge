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

  createAtlassian(ctx: AdapterContext): AtlassianPort {
    if (ctx.transport === 'mcp') {
      throw new Error(
        'The MCP transport is not implemented yet. See src/registry.full.ts for the intended shape, and use "rest" in the meantime.'
      );
    }
    return new AtlassianRestAdapter({ baseUrl: ctx.baseUrl, email: ctx.email, apiToken: ctx.apiToken });
  },

  createLlm(ctx: AdapterContext): LlmPort {
    switch (ctx.llmProvider) {
      case 'anthropic':
        throw new Error(
          'The Anthropic provider is not implemented yet. See src/registry.full.ts for the intended shape, and use "copilot" in the meantime.'
        );
      case 'fixture':
        return new FixtureLlmAdapter(ctx.fixtures ?? {});
      case 'copilot':
      default:
        return new CopilotLlmAdapter(ctx.modelFamily || undefined);
    }
  }
};
