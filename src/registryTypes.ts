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
}
