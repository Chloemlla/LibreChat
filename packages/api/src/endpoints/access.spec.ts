import { EModelEndpoint, Providers } from 'librechat-data-provider';
import { MAX_MODEL_STRING_LENGTH, checkModelAccess } from './access';
import type { ModelAccessParams } from './access';

function params(overrides: Partial<ModelAccessParams> = {}): ModelAccessParams {
  return {
    endpoint: EModelEndpoint.openAI,
    model: 'gpt-4o',
    getEndpointsConfig: jest.fn().mockResolvedValue({ openAI: { userProvide: false } }),
    getModelsConfig: jest.fn().mockResolvedValue({ openAI: ['gpt-4o', 'gpt-4o-mini'] }),
    ...overrides,
  };
}

describe('checkModelAccess', () => {
  it('accepts a model the endpoint offers, returning the trimmed identifier', async () => {
    await expect(checkModelAccess(params({ model: '  gpt-4o  ' }))).resolves.toEqual({
      ok: true,
      model: 'gpt-4o',
    });
  });

  describe('identifier', () => {
    it.each([undefined, null, 12345, {}])('refuses a non-string model (%p)', async (model) => {
      await expect(checkModelAccess(params({ model }))).resolves.toEqual({
        ok: false,
        rejection: 'model_missing',
      });
    });

    it('refuses an empty model', async () => {
      await expect(checkModelAccess(params({ model: '' }))).resolves.toEqual({
        ok: false,
        rejection: 'model_missing',
      });
    });

    it.each(['   ', 'gpt 4o', '-gpt-4o', 'a'.repeat(MAX_MODEL_STRING_LENGTH + 1)])(
      'refuses a malformed model (%p)',
      async (model) => {
        await expect(checkModelAccess(params({ model }))).resolves.toEqual({
          ok: false,
          rejection: 'model_malformed',
        });
      },
    );

    /**
     * The identifier is settled before any config read, so a malformed request
     * never costs a database round trip.
     */
    it('resolves no config when the identifier is refused', async () => {
      const getEndpointsConfig = jest.fn();
      const getModelsConfig = jest.fn();
      await checkModelAccess(params({ model: '', getEndpointsConfig, getModelsConfig }));

      expect(getEndpointsConfig).not.toHaveBeenCalled();
      expect(getModelsConfig).not.toHaveBeenCalled();
    });
  });

  /**
   * `userProvide` endpoints take their credentials from the user, so the
   * catalog this server holds is not the authority on what they may call.
   */
  it('admits any well-formed model on a user-provided endpoint without reading the catalog', async () => {
    const getModelsConfig = jest.fn();
    await expect(
      checkModelAccess(
        params({
          model: 'anything-goes',
          getEndpointsConfig: jest.fn().mockResolvedValue({ openAI: { userProvide: true } }),
          getModelsConfig,
        }),
      ),
    ).resolves.toEqual({ ok: true, model: 'anything-goes' });

    expect(getModelsConfig).not.toHaveBeenCalled();
  });

  it('refuses when no catalog was loaded at all', async () => {
    await expect(
      checkModelAccess(params({ getModelsConfig: jest.fn().mockResolvedValue(null) })),
    ).resolves.toEqual({ ok: false, rejection: 'models_not_loaded' });
  });

  it('refuses when the catalog carries no entry for the endpoint', async () => {
    await expect(
      checkModelAccess(params({ getModelsConfig: jest.fn().mockResolvedValue({}) })),
    ).resolves.toEqual({ ok: false, rejection: 'endpoint_models_not_loaded' });
  });

  it('refuses a model the endpoint does not offer', async () => {
    await expect(checkModelAccess(params({ model: 'gpt-5' }))).resolves.toEqual({
      ok: false,
      rejection: 'model_not_offered',
    });
  });

  /**
   * A provider whose catalog is filed under a different name is read through
   * the catalog key, so the rule and the model list agree on where to look.
   */
  it('reads a provider-named endpoint through its catalog key', async () => {
    const getModelsConfig = jest.fn().mockResolvedValue({
      [EModelEndpoint.google]: ['gemini-2.0-flash'],
    });

    await expect(
      checkModelAccess(
        params({ endpoint: Providers.VERTEXAI, model: 'gemini-2.0-flash', getModelsConfig }),
      ),
    ).resolves.toEqual({ ok: true, model: 'gemini-2.0-flash' });
  });
});
