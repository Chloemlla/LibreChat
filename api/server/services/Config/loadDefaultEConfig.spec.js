const mockGetEnabledEndpoints = jest.fn();
const mockGetEndpointEnvironmentConfig = jest.fn();
const mockLoadAsyncEndpoints = jest.fn();

function mockOptionalModule(moduleName, factory) {
  try {
    require.resolve(moduleName);
    jest.doMock(moduleName, factory);
  } catch {
    jest.doMock(moduleName, factory, { virtual: true });
  }
}

function mockDependencies() {
  mockOptionalModule('librechat-data-provider', () => ({
    EModelEndpoint: {
      agents: 'agents',
      anthropic: 'anthropic',
      assistants: 'assistants',
      azureAssistants: 'azureAssistants',
      azureOpenAI: 'azureOpenAI',
      bedrock: 'bedrock',
      google: 'google',
      openAI: 'openAI',
    },
    getEnabledEndpoints: mockGetEnabledEndpoints,
  }));

  jest.doMock('./loadAsyncEndpoints', () => mockLoadAsyncEndpoints);

  jest.doMock('./EndpointService', () => ({
    getEndpointEnvironmentConfig: mockGetEndpointEnvironmentConfig,
  }));
}

describe('loadEndpointEnvironmentConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockGetEndpointEnvironmentConfig.mockReturnValue({
      agents: { userProvide: false },
      anthropic: false,
      assistants: false,
      azureAssistants: false,
      azureOpenAI: false,
      bedrock: false,
      openAI: { userProvide: false },
    });
    mockDependencies();
  });

  it('reports the environment config for every endpoint the environment offers', async () => {
    mockGetEnabledEndpoints.mockReturnValue(['openAI', 'google']);
    mockLoadAsyncEndpoints.mockResolvedValue({ google: { userProvide: false } });
    const loadEndpointEnvironmentConfig = require('./loadDefaultEConfig');

    const result = await loadEndpointEnvironmentConfig();

    expect(mockLoadAsyncEndpoints).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      agents: { userProvide: false },
      anthropic: false,
      assistants: false,
      azureAssistants: false,
      azureOpenAI: false,
      bedrock: false,
      openAI: { userProvide: false },
      google: { userProvide: false },
    });
  });

  it('does not probe async Google credentials when Google is excluded', async () => {
    mockGetEnabledEndpoints.mockReturnValue(['openAI']);
    const loadEndpointEnvironmentConfig = require('./loadDefaultEConfig');

    const result = await loadEndpointEnvironmentConfig();

    expect(mockLoadAsyncEndpoints).not.toHaveBeenCalled();
    expect(result.google).toBe(false);
  });

  it('re-reads the environment config per call rather than at module load', async () => {
    mockGetEnabledEndpoints.mockReturnValue(['openAI']);
    const loadEndpointEnvironmentConfig = require('./loadDefaultEConfig');
    await loadEndpointEnvironmentConfig();

    mockGetEndpointEnvironmentConfig.mockReturnValue({
      agents: { userProvide: false },
      openAI: { userProvide: true },
    });
    const result = await loadEndpointEnvironmentConfig();

    expect(mockGetEndpointEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(result.openAI).toEqual({ userProvide: true });
  });
});
