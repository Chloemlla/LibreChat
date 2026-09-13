import { Providers } from '@librechat/agents';
import type { ServerRequest, EndpointDbMethods } from '~/types';

const mockInvoke = jest.fn();
const mockInitializeModel = jest.fn(() => ({ invoke: mockInvoke }));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  initializeModel: (...args: unknown[]) => mockInitializeModel(...(args as [])),
}));

const mockGetOptions = jest.fn();
const mockGetProviderConfig = jest.fn(() => ({
  getOptions: mockGetOptions,
  overrideProvider: 'openAI',
}));

jest.mock('~/endpoints/config/providers', () => ({
  getProviderConfig: (...args: unknown[]) => mockGetProviderConfig(...(args as [])),
}));

import {
  WIDGET_COMPILE_TIMEOUT_MS,
  WIDGET_MAX_OUTPUT_TOKENS,
  generateWidgetCode,
  resolveWidgetCompileModel,
} from './generate';

const SPEC = '**Objective:** plot the series\n**Data State:** 1, 2, 3';
const COMPONENT = 'function Widget() { return <div>ok</div>; }';

const createRequest = (): ServerRequest =>
  ({
    query: {},
    body: {},
    config: {},
    user: { id: 'user-id', role: 'USER', tenantId: 'tenant-a' },
  }) as ServerRequest;

const db: EndpointDbMethods = {
  getUserKey: jest.fn(),
  getUserKeyValues: jest.fn(),
};

const baseParams = (model: string) => ({
  req: createRequest(),
  endpoint: 'openAI',
  model,
  db,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOptions.mockResolvedValue({ llmConfig: {}, provider: 'openAI' });
  mockInvoke.mockResolvedValue({ content: COMPONENT });
});

describe('generateWidgetCode', () => {
  it('sends the codegen prompt and the specification to the provider', async () => {
    await generateWidgetCode({ ...baseParams('gpt-4o-mini'), spec: SPEC });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [prompt] = mockInvoke.mock.calls[0] as [string];
    expect(prompt).toContain('# Specification');
    expect(prompt).toContain(SPEC);
    expect(prompt).toContain('Widget');
  });

  it('builds the client non-streaming', async () => {
    await generateWidgetCode({ ...baseParams('gpt-4o-mini'), spec: SPEC });

    expect(mockInitializeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOptions: expect.objectContaining({ streaming: false }),
      }),
    );
  });

  it('returns text from block-array content', async () => {
    mockInvoke.mockResolvedValue({ content: [{ type: 'text', text: COMPONENT }] });

    await expect(generateWidgetCode({ ...baseParams('gpt-4o-mini'), spec: SPEC })).resolves.toBe(
      COMPONENT,
    );
  });

  it('bounds the call with a timeout signal', async () => {
    await generateWidgetCode({ ...baseParams('gpt-4o-mini'), spec: SPEC });

    const [, config] = mockInvoke.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(config.signal.aborted).toBe(false);
  });

  it('rejects once the provider outlives the compile timeout', async () => {
    mockInvoke.mockImplementation(
      (_input: string, config: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          config.signal.addEventListener('abort', () => reject(config.signal.reason));
        }),
    );

    await expect(
      generateWidgetCode({ ...baseParams('gpt-4o-mini'), spec: SPEC, timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(DOMException);
  });

  it('propagates a provider failure', async () => {
    mockInvoke.mockRejectedValue(new Error('provider unavailable'));

    await expect(generateWidgetCode({ ...baseParams('gpt-4o-mini'), spec: SPEC })).rejects.toThrow(
      'provider unavailable',
    );
  });
});

describe('resolveWidgetCompileModel', () => {
  const resolve = (model: string, llmConfig: Record<string, unknown>) => {
    mockGetOptions.mockResolvedValue({ llmConfig, provider: 'openAI' });
    return resolveWidgetCompileModel(baseParams(model));
  };

  it('resolves provider options from the request own endpoint and model', async () => {
    const req = createRequest();
    await resolveWidgetCompileModel({ req, endpoint: 'anthropic', model: 'claude-sonnet-5', db });

    expect(mockGetProviderConfig).toHaveBeenCalledWith({
      provider: 'anthropic',
      appConfig: req.config,
    });
    expect(mockGetOptions).toHaveBeenCalledWith({
      req,
      endpoint: 'anthropic',
      model_parameters: { model: 'claude-sonnet-5' },
      db,
    });
  });

  it('drops the chat caps and applies a codegen-sized default cap', async () => {
    const { clientOptions } = await resolve('gpt-4o-mini', {
      maxTokens: 65_536,
      thinking: { type: 'enabled' },
      maxOutputTokens: 4_096,
    });

    expect(clientOptions).toMatchObject({ maxTokens: WIDGET_MAX_OUTPUT_TOKENS });
    expect(clientOptions).not.toHaveProperty('thinking');
  });

  it('routes the Google cap to maxOutputTokens', async () => {
    mockGetOptions.mockResolvedValue({ llmConfig: { maxTokens: 65_536 }, provider: 'google' });
    const { clientOptions, provider } = await resolveWidgetCompileModel(
      baseParams('gemini-2.5-pro'),
    );

    expect(provider).toBe(Providers.GOOGLE);
    expect(clientOptions).toMatchObject({ maxOutputTokens: WIDGET_MAX_OUTPUT_TOKENS });
    expect(clientOptions).not.toHaveProperty('maxTokens');
  });

  it('routes the GPT-5 cap to modelKwargs', async () => {
    const { clientOptions } = await resolve('gpt-5-mini', {});

    expect(clientOptions).toMatchObject({
      modelKwargs: { max_completion_tokens: WIDGET_MAX_OUTPUT_TOKENS },
    });
    expect(clientOptions).not.toHaveProperty('maxTokens');
  });

  it('routes the GPT-5 responses-API cap to max_output_tokens', async () => {
    const { clientOptions } = await resolve('gpt-5-mini', {
      useResponsesApi: true,
      modelKwargs: { max_completion_tokens: 4_096 },
    });

    expect(clientOptions).toMatchObject({
      modelKwargs: { max_output_tokens: WIDGET_MAX_OUTPUT_TOKENS },
    });
  });

  it('leaves o-series models uncapped', async () => {
    const { clientOptions } = await resolve('o3-mini', {});

    expect(clientOptions).not.toHaveProperty('maxTokens');
    expect(clientOptions).not.toHaveProperty('modelKwargs');
  });

  it('keeps the client-construction carrier the filter would drop', async () => {
    const { clientOptions } = await resolve('gpt-4o-mini', {
      clientOptions: { defaultHeaders: { 'x-proxy-header': 'static-value' } },
    });

    expect(clientOptions).toMatchObject({
      clientOptions: { defaultHeaders: { 'x-proxy-header': 'static-value' } },
    });
  });

  it('keeps the provider configOptions as the client configuration', async () => {
    const configOptions = { defaultHeaders: { 'x-config-header': 'static-value' } };
    mockGetOptions.mockResolvedValue({ llmConfig: {}, provider: 'openAI', configOptions });
    const { clientOptions } = await resolveWidgetCompileModel(baseParams('gpt-4o-mini'));

    expect(clientOptions).toMatchObject({ configuration: configOptions });
  });

  it('forces the OpenAI provider for Azure without an instance name', async () => {
    mockGetOptions.mockResolvedValue({ llmConfig: {}, provider: 'azureOpenAI' });
    const { provider } = await resolveWidgetCompileModel({
      ...baseParams('gpt-4o-mini'),
      endpoint: 'azureOpenAI',
    });

    expect(provider).toBe(Providers.OPENAI);
  });

  /** A hung provider must never hold the request open: an unbounded default
   *  would reintroduce exactly the failure the timeout signal exists for. */
  it('keeps the default compile timeout finite and bounded', () => {
    expect(Number.isFinite(WIDGET_COMPILE_TIMEOUT_MS)).toBe(true);
    expect(WIDGET_COMPILE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WIDGET_COMPILE_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
