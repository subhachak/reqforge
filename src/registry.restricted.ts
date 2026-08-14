import * as vscode from 'vscode';
import { AtlassianRestAdapter } from './adapters/atlassian/rest';
import { CopilotLlmAdapter } from './adapters/llm/copilot';
import { FixtureLlmAdapter } from './adapters/llm/fixture';
import type { AtlassianPort, LlmPort } from './core/ports';
import type { AdapterRegistry, AdapterContext } from './registryTypes';

/**
 * RESTRICTED PROFILE.
 *
 * Adapter set for deployments where policy forbids MCP and third-party LLM
 * providers. The only network destinations reachable from this bundle are the
 * customer's own Atlassian tenant and — indirectly, via VS Code's own Copilot
 * client — GitHub Copilot. This file is the single place that decides that,
 * and esbuild's compliance guard fails the build if anything else leaks in.
 */
export const registry: AdapterRegistry = {
  profile: 'restricted',

  availableTransports: ['rest'],
  availableLlmProviders: ['copilot', 'fixture'],

  createAtlassian(ctx: AdapterContext): AtlassianPort {
    if (ctx.transport !== 'rest') {
      throw new Error(
        `Transport "${ctx.transport}" is not available in the restricted build. Set reqforge.atlassian.transport to "rest".`
      );
    }
    return new AtlassianRestAdapter({
      baseUrl: ctx.baseUrl,
      email: ctx.email,
      apiToken: ctx.apiToken
    });
  },

  createLlm(ctx: AdapterContext): LlmPort {
    switch (ctx.llmProvider) {
      case 'copilot':
        return new CopilotLlmAdapter(ctx.modelFamily || undefined);
      case 'fixture':
        return new FixtureLlmAdapter(ctx.fixtures ?? {});
      default:
        vscode.window.showWarningMessage(
          `LLM provider "${ctx.llmProvider}" is not available in the restricted build. Falling back to Copilot.`
        );
        return new CopilotLlmAdapter(ctx.modelFamily || undefined);
    }
  }
};
