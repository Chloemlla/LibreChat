import {
  EModelEndpoint,
  WIDGET_COMPILE_TIMEOUT_DEFAULT_MS,
  WIDGET_COMPILE_TIMEOUT_HARD_MAX_MS,
} from 'librechat-data-provider';
import { Providers, initializeModel } from '@librechat/agents';
import type { AppConfig } from '@librechat/data-schemas';
import type { ClientOptions } from '@librechat/agents';
import type { EndpointDbMethods, OpenAIConfiguration, ServerRequest } from '~/types';
import { getProviderConfig } from '~/endpoints/config/providers';
import { resolveRequestTenantId } from '~/middleware/tenant';
import { resolveConfigHeaders } from '~/utils/headers';
import { generateWidgetCodegenPrompt } from '~/prompts';
import { createSafeUser } from '~/utils/env';
import { omitTitleOptions } from '~/agents/client';

/**
 * Generation cap for a compile call — roughly 8x a large component body.
 * `omitTitleOptions` strips the chat caps, so without a replacement a model
 * that ignores the instruction bills its provider-default output instead.
 */
export const WIDGET_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Default budget for the compile call. A hung provider has to surface as a card
 * error rather than a request that never returns, so the call always runs under
 * a bounded signal: `interface.widgetCompileTimeoutMs` moves the budget within
 * the protocol ceiling, and `timeoutMs` moves it for a single caller.
 */
export const WIDGET_COMPILE_TIMEOUT_MS = WIDGET_COMPILE_TIMEOUT_DEFAULT_MS;

export interface ResolveWidgetCompileTimeoutParams {
  /** Explicit budget for one call; wins over the configured one. */
  timeoutMs?: number;
  /** `interface.widgetCompileTimeoutMs` as loaded into the app config. */
  configuredMs?: number;
}

/**
 * Resolves the compile budget by priority: the caller's explicit value, then the
 * operator's `interface.widgetCompileTimeoutMs`, then the default. A delay
 * `AbortSignal.timeout` cannot take is replaced instead of passed through — a
 * non-finite or non-positive one throws a RangeError, and one past the 32-bit
 * timer ceiling fires on the next tick instead of after the requested time, which
 * would turn a mistyped config into a compile that never runs.
 */
export function resolveWidgetCompileTimeoutMs({
  timeoutMs,
  configuredMs,
}: ResolveWidgetCompileTimeoutParams): number {
  const requestedMs = timeoutMs ?? configuredMs;
  if (requestedMs == null || !Number.isFinite(requestedMs)) {
    return WIDGET_COMPILE_TIMEOUT_MS;
  }
  /** Floored before the sign is judged, so a sub-millisecond value falls back
   *  instead of rounding down to a delay that aborts immediately. */
  const roundedMs = Math.floor(requestedMs);
  if (roundedMs <= 0) {
    return WIDGET_COMPILE_TIMEOUT_MS;
  }
  return Math.min(roundedMs, WIDGET_COMPILE_TIMEOUT_HARD_MAX_MS);
}

/** Azure resolution reads an instance name that only some configs carry. */
type MaybeAzureConfig = ClientOptions & {
  azureOpenAIApiInstanceName?: string;
  configuration?: OpenAIConfiguration;
};

/** Azure without an instance name is the OpenAI-compatible surface. */
function resolveProvider({
  endpoint,
  provider,
  overrideProvider,
  clientOptions,
}: {
  endpoint: string;
  provider?: string;
  overrideProvider?: string;
  clientOptions?: MaybeAzureConfig;
}): Providers {
  const resolved = (provider ?? overrideProvider ?? endpoint) as Providers;
  if (endpoint !== EModelEndpoint.azureOpenAI) {
    return resolved;
  }
  return clientOptions?.azureOpenAIApiInstanceName == null ? Providers.OPENAI : Providers.AZURE;
}

/**
 * Replaces the stripped chat caps with a compile-sized one, routed with the
 * same model/API conversion as the OpenAI builder: GPT-5+ rejects
 * `max_tokens` so its cap goes to `modelKwargs` (responses-API aware),
 * o-series models reject it and get no cap at all, and the Google-family
 * wrappers read `maxOutputTokens`.
 */
function applyOutputCap({
  model,
  provider,
  rawOptions,
  clientOptions,
}: {
  model: string;
  provider: Providers;
  rawOptions: MaybeAzureConfig & { useResponsesApi?: boolean };
  clientOptions: MaybeAzureConfig & { modelKwargs?: Record<string, unknown> };
}): void {
  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    (clientOptions as { maxOutputTokens?: number }).maxOutputTokens = WIDGET_MAX_OUTPUT_TOKENS;
    return;
  }
  const isGpt5Plus = /\bgpt-[5-9](?:\.\d+)?\b/i.test(model);
  if (isGpt5Plus) {
    const paramName =
      rawOptions.useResponsesApi === true ? 'max_output_tokens' : 'max_completion_tokens';
    clientOptions.modelKwargs = {
      ...(clientOptions.modelKwargs ?? {}),
      [paramName]: WIDGET_MAX_OUTPUT_TOKENS,
    };
    return;
  }
  if (!/\bo[1-9](?:[-.]|\b)/i.test(model)) {
    (clientOptions as { maxTokens?: number }).maxTokens = WIDGET_MAX_OUTPUT_TOKENS;
  }
}

/** The SDK client surface this module calls — the concrete client type is
 *  provider-specific, so only the invoke contract is named here. The call
 *  config carries the bounded timeout signal. */
interface WidgetInvokableClient {
  invoke: (input: string, config?: object) => Promise<{ content?: unknown }>;
}

/** Resolved provider and construction options for one compile call. */
export interface WidgetCompileModel {
  provider: Providers;
  clientOptions: ClientOptions;
}

export interface ResolveWidgetCompileModelParams {
  req: ServerRequest;
  endpoint: string;
  model: string;
  db: EndpointDbMethods;
}

export interface GenerateWidgetCodeParams extends ResolveWidgetCompileModelParams {
  spec: string;
  /** Overrides the configured timeout for one call; the abort path is exercised with it. */
  timeoutMs?: number;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'string' ? block : ((block as { text?: string })?.text ?? ''),
      )
      .join('')
      .trim();
  }
  return '';
}

/**
 * Resolves what the compile call runs on from the request's own config,
 * mirroring the activity-label path. The endpoint is the *user's* choice, so
 * it can differ from the agent that wrote the spec; the caller supplies the
 * database methods rather than this module reaching for them.
 */
export async function resolveWidgetCompileModel({
  req,
  endpoint,
  model,
  db,
}: ResolveWidgetCompileModelParams): Promise<WidgetCompileModel> {
  const appConfig = req.config as AppConfig | undefined;
  const providerConfig = getProviderConfig({ provider: endpoint, appConfig });
  const options = await providerConfig.getOptions({
    req,
    endpoint,
    model_parameters: { model },
    db,
  });
  const llmConfig = options.llmConfig as MaybeAzureConfig | undefined;
  const provider = resolveProvider({
    endpoint,
    provider: options.provider,
    overrideProvider: providerConfig.overrideProvider,
    clientOptions: llmConfig,
  });
  /** Copied, never mutated: `llmConfig` is shared with the memoized provider
   *  resolution, and the chat caps it carries are sized for a full turn. */
  const rawOptions = { ...(llmConfig ?? {}) } as MaybeAzureConfig & {
    maxTokens?: number;
    modelKwargs?: Record<string, unknown>;
    clientOptions?: { defaultHeaders?: unknown };
    useResponsesApi?: boolean;
  };
  delete rawOptions.maxTokens;
  if (rawOptions.modelKwargs != null) {
    const modelKwargs = { ...rawOptions.modelKwargs };
    delete modelKwargs.max_completion_tokens;
    delete modelKwargs.max_output_tokens;
    rawOptions.modelKwargs = modelKwargs;
  }
  /** The filter drops Anthropic's `clientOptions` carrier, so it is restored
   *  by the same reference whenever it exists — that carrier holds client
   *  CONSTRUCTION options (proxy `defaultHeaders`, and the SSRF-safe
   *  `fetchOptions` for user-supplied base URLs), not generation parameters. */
  const clientOptionsCarrier = rawOptions.clientOptions;
  const clientOptions = Object.fromEntries(
    Object.entries(rawOptions).filter(([key]) => !omitTitleOptions.has(key)),
  ) as MaybeAzureConfig & {
    clientOptions?: { defaultHeaders?: unknown };
    modelKwargs?: Record<string, unknown>;
  };
  if (clientOptionsCarrier != null && clientOptions.clientOptions == null) {
    clientOptions.clientOptions = clientOptionsCarrier;
  }
  applyOutputCap({ model, provider, rawOptions, clientOptions });
  if (options.configOptions) {
    clientOptions.configuration = options.configOptions;
  }
  /** Proxies that key on user or tenant metadata carry placeholders in their
   *  configured headers; they need resolving here exactly as the title and
   *  label paths resolve them. This request has no conversation envelope. */
  resolveConfigHeaders({
    llmConfig: clientOptions,
    user: createSafeUser(req.user),
    tenantId: resolveRequestTenantId(req),
    body: req.body,
  });
  return { provider, clientOptions: clientOptions as ClientOptions };
}

/**
 * One non-streaming call that compiles a specification into a component body.
 * Throws on provider failure and on timeout; the caller maps both to a card
 * error, since a compile that did not finish has nothing to render.
 */
export async function generateWidgetCode({
  req,
  endpoint,
  model,
  spec,
  db,
  timeoutMs,
}: GenerateWidgetCodeParams): Promise<string> {
  /** The operator's budget rides on the loaded app config — the same object the
   *  widget directive is gated on — so no caller has to thread it through. */
  const appConfig = req.config as AppConfig | undefined;
  const compileTimeoutMs = resolveWidgetCompileTimeoutMs({
    timeoutMs,
    configuredMs: appConfig?.interfaceConfig?.widgetCompileTimeoutMs,
  });
  const { provider, clientOptions } = await resolveWidgetCompileModel({
    req,
    endpoint,
    model,
    db,
  });
  const client = initializeModel({
    provider,
    clientOptions: { ...clientOptions, streaming: false } as ClientOptions,
  });
  const signal = AbortSignal.timeout(compileTimeoutMs);
  const response = await (client as WidgetInvokableClient).invoke(
    generateWidgetCodegenPrompt(spec),
    { signal },
  );
  return extractText(response?.content);
}
