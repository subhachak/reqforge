import * as vscode from 'vscode';
import { LlmUnavailableError, type LlmCancellation, type LlmPort, type StructuredRequest } from '../../core/ports';
import { repairPrompt } from '../../core/prompts';

/**
 * Copilot-backed LLM adapter.
 *
 * Structured output is obtained by forcing a single required tool call rather
 * than asking for JSON in prose — prose JSON from these models is not reliable
 * enough to build a pipeline on. One emit-tool per request keeps Required mode
 * unambiguous.
 *
 * There is no fallback provider in the restricted build, so every failure mode
 * here has to produce an actionable message rather than a stack trace.
 */
export class CopilotLlmAdapter implements LlmPort {
  readonly kind = 'copilot' as const;

  private cached: vscode.LanguageModelChat | undefined;

  constructor(private readonly preferredFamily?: string) {}

  private async selectModel(): Promise<vscode.LanguageModelChat> {
    if (this.cached) return this.cached;

    const selector: vscode.LanguageModelChatSelector = { vendor: 'copilot' };
    if (this.preferredFamily) selector.family = this.preferredFamily;

    // selectChatModels returns an empty array until the Copilot extension has
    // finished activating, which routinely loses the race on a cold window.
    // Nudge it awake, then retry briefly before concluding it is absent.
    await activateCopilot();

    let models: vscode.LanguageModelChat[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      models = await vscode.lm.selectChatModels(selector);

      // Fall back to any Copilot model if the requested family is not entitled.
      if (models.length === 0 && this.preferredFamily) {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      }
      if (models.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (models.length === 0) {
      throw new LlmUnavailableError('No GitHub Copilot chat model is available.', copilotHint());
    }

    // Prefer the largest context window — PRDs are long.
    models.sort((a, b) => (b.maxInputTokens ?? 0) - (a.maxInputTokens ?? 0));
    this.cached = models[0];
    return this.cached;
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const model = await this.selectModel();
      return {
        ok: true,
        detail: `${model.vendor}/${model.family} (${model.name}), ${model.maxInputTokens} input tokens`
      };
    } catch (err) {
      const hint = err instanceof LlmUnavailableError ? err.hint : '';
      return { ok: false, detail: `${(err as Error).message} ${hint}`.trim() };
    }
  }

  async contextWindow(): Promise<number> {
    const model = await this.selectModel();
    // Leave headroom for the response and for tool-schema overhead.
    return Math.max(4000, Math.floor((model.maxInputTokens ?? 8000) * 0.75));
  }

  async countTokens(text: string): Promise<number> {
    const model = await this.selectModel();
    return model.countTokens(text);
  }

  async requestStructured<T>(req: StructuredRequest<T>, token?: LlmCancellation): Promise<T> {
    const model = await this.selectModel();
    const cts = toCancellationToken(token);

    const tool: vscode.LanguageModelChatTool = {
      name: req.toolName,
      description: req.toolDescription,
      inputSchema: req.inputSchema
    };

    const messages = req.messages.map((m) =>
      m.role === 'user' ? vscode.LanguageModelChatMessage.User(m.content) : vscode.LanguageModelChatMessage.Assistant(m.content)
    );

    const first = await this.callOnce<T>(model, messages, tool, req, cts);
    if (first.ok) return first.value;

    // One repair attempt, feeding the validation error back in. Beyond one
    // retry the failure is usually the schema, not the model, and burning more
    // premium requests will not fix it.
    const repaired = [
      ...messages,
      vscode.LanguageModelChatMessage.Assistant(`(rejected tool call: ${first.error})`),
      vscode.LanguageModelChatMessage.User(repairPrompt(first.error))
    ];
    const second = await this.callOnce<T>(model, repaired, tool, req, cts);
    if (second.ok) return second.value;

    throw new LlmUnavailableError(
      `The model returned data that did not match the expected schema, twice. Last error: ${second.error}`,
      'This usually means the source document is too unusual for the current prompt. Try a smaller section of the PRD, or check the ReqForge output channel for the raw response.'
    );
  }

  private async callOnce<T>(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    tool: vscode.LanguageModelChatTool,
    req: StructuredRequest<T>,
    cts: vscode.CancellationToken
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(
        messages,
        {
          justification: req.justification,
          tools: [tool],
          toolMode: vscode.LanguageModelChatToolMode.Required
        },
        cts
      );
    } catch (err) {
      throw translateLmError(err);
    }

    let toolInput: unknown;
    let prose = '';
    try {
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelToolCallPart) {
          if (part.name === tool.name) toolInput = part.input;
        } else if (part instanceof vscode.LanguageModelTextPart) {
          prose += part.value;
        }
      }
    } catch (err) {
      throw translateLmError(err);
    }

    if (toolInput === undefined) {
      // The model answered in prose instead of calling the tool. Most often
      // this is a refusal, and the prose says why — surface it verbatim.
      return {
        ok: false,
        error: prose.trim()
          ? `model did not call ${tool.name}; it replied: ${prose.trim().slice(0, 400)}`
          : `model did not call ${tool.name} and returned no text`
      };
    }

    const parsed = req.parse(toolInput);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error };
  }
}

const COPILOT_EXTENSIONS = ['GitHub.copilot-chat', 'GitHub.copilot'];

function findExtension(id: string): vscode.Extension<unknown> | undefined {
  // Extension ids are matched case-insensitively by the marketplace but not
  // always by getExtension, so try both spellings.
  return vscode.extensions.getExtension(id) ?? vscode.extensions.getExtension(id.toLowerCase());
}

/** Best-effort: activating Copilot is what makes its models resolvable. */
async function activateCopilot(): Promise<void> {
  for (const id of COPILOT_EXTENSIONS) {
    const ext = findExtension(id);
    if (ext && !ext.isActive) {
      await ext.activate().then(undefined, () => undefined);
    }
  }
}

/** Distinguishes "not installed" from "installed but no model", which need different fixes. */
function copilotHint(): string {
  const installed = COPILOT_EXTENSIONS.filter((id) => findExtension(id));
  if (installed.length === 0) {
    return 'The GitHub Copilot extensions are not installed in this VS Code window. Install "GitHub Copilot" and "GitHub Copilot Chat" from the Extensions view, then re-run this command.';
  }
  const active = installed.filter((id) => findExtension(id)?.isActive);
  if (active.length === 0) {
    return `Copilot is installed (${installed.join(', ')}) but did not activate. Open Copilot Chat once in this window, then re-run this command.`;
  }
  return `Copilot is installed and active (${active.join(', ')}) but exposes no chat model. This usually means you are not signed in to GitHub, or the account has no Copilot Chat entitlement. Check the Copilot status in the status bar, then re-run this command.`;
}

function toCancellationToken(token?: LlmCancellation): vscode.CancellationToken {
  if (token && 'isCancellationRequested' in token) {
    return token as unknown as vscode.CancellationToken;
  }
  return new vscode.CancellationTokenSource().token;
}

/** Turns opaque LanguageModelError causes into something a user can act on. */
function translateLmError(err: unknown): Error {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case 'NoPermissions':
        return new LlmUnavailableError(
          'Access to the language model was denied.',
          'ReqForge needs your permission to use Copilot. Re-run the command and choose Allow, or check the Copilot extension is signed in.',
          err
        );
      case 'Blocked':
        return new LlmUnavailableError(
          'Copilot blocked this request.',
          'The content filter rejected the prompt or the response. This is the failure mode to expect on business-heavy PRD text — see README "Model availability spike" for prompt framing that avoids it.',
          err
        );
      case 'NotFound':
        return new LlmUnavailableError(
          'The selected Copilot model is no longer available.',
          'Clear the reqforge.llm.modelFamily setting to let ReqForge pick any available model.',
          err
        );
      default:
        return new LlmUnavailableError(
          `Copilot request failed: ${err.message}`,
          'If this is a rate limit, wait a minute and retry — the pipeline is resumable from the backlog file.',
          err
        );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}
