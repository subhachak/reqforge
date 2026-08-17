import type { findDuplicates } from './core/pipeline/duplicates';
import type { runPanel } from './core/agents/panel';
import type { ReviewerDef } from './core/agents/types';
import type { AtlassianPort, LlmPort } from './core/ports';

export type Transport = 'rest' | 'mcp';
export type LlmProvider = 'copilot' | 'anthropic' | 'fixture';

export interface AdapterContext {
  transport: Transport;
  baseUrl: string;
  email: string;
  apiToken: string;
  llmProvider: LlmProvider;
  modelFamily: string;
  fixtures?: Record<string, unknown[]>;
  /** Full profile only; undefined in the restricted build. */
  anthropicApiKey?: string;
  mcpEndpoint?: string;
  /**
   * Called when a request fails transiently and will be retried. Lets the UI
   * explain a pause rather than appearing to hang.
   */
  onLlmRetry?: (attempt: number, delayMs: number, reason: string) => void;
  /** Called per model request, so premium-request consumption is visible. */
  onLlmCall?: (info: { n: number; tool: string; inputTokens: number }) => void;
}

/**
 * The seam between the two builds. `@registry` is aliased by esbuild to either
 * registry.restricted.ts or registry.full.ts, so the adapters a profile does
 * not use are never pulled into the dependency graph at all — they are absent
 * from the bundle, not merely unreachable.
 */
export interface AdapterRegistry {
  profile: 'restricted' | 'full';
  availableTransports: Transport[];
  availableLlmProviders: LlmProvider[];
  createAtlassian(ctx: AdapterContext): AtlassianPort;
  createLlm(ctx: AdapterContext): LlmPort;
  /**
   * The multi-agent surface, present only in the full profile.
   *
   * Reached through the registry rather than imported directly and guarded by
   * `registry.profile === 'full'`, because a runtime branch leaves the code in
   * the bundle. The same reasoning that keeps the MCP client out of the
   * restricted build applies here: "absent" and "unreachable" are different
   * claims, and only the first one can be checked from the outside.
   */
  agents?: {
    reviewers: ReviewerDef[];
    runPanel: typeof runPanel;
    findDuplicates: typeof findDuplicates;
  };
}
