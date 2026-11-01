// ── Mocks ──────────────────────────────────────────────────────────────

const mockClearAppConfigCache = jest.fn().mockResolvedValue(undefined);
const mockClearOverrideCache = jest.fn().mockResolvedValue(undefined);
const mockGetAppConfig = jest.fn().mockResolvedValue({ availableTools: {} });
const mockApplyMCPBootConfig = jest.fn();

jest.mock('~/cache/getLogStores', () => {
  return jest.fn(() => ({}));
});

jest.mock('~/server/services/start/tools', () => ({
  loadAndFormatTools: jest.fn(() => ({})),
}));

jest.mock('../loadCustomConfig', () => jest.fn().mockResolvedValue({}));

jest.mock('@librechat/data-schemas', () => {
  return {
    AppService: jest.fn(() => ({ availableTools: {} })),
    logger: { error: jest.fn() },
  };
});

jest.mock('~/models', () => ({
  initializeMessageBudget: jest.fn(),
  getApplicableConfigs: jest.fn().mockResolvedValue([]),
  getUserPrincipals: jest.fn().mockResolvedValue([]),
}));

const mockInvalidateCachedTools = jest.fn().mockResolvedValue(undefined);
jest.mock('../getCachedTools', () => ({
  setCachedTools: jest.fn().mockResolvedValue(undefined),
  invalidateCachedTools: mockInvalidateCachedTools,
}));

const mockClearMcpConfigCache = jest.fn().mockResolvedValue(undefined);
const mockCreateRedisPubSub = jest.fn(() => undefined);
/** The invalidation the module composes; its own behavior is covered in packages/api. */
const mockCreateConfigCacheInvalidation = jest.fn(({ clears }) => ({
  invalidate: async (tenantId) => {
    await Promise.allSettled(clears.map(({ clear }) => clear(tenantId)));
  },
  close: async () => undefined,
}));
jest.mock('@librechat/api', () => ({
  isEnabled: (value) => value === 'true',
  expandCustomEndpoint: jest.fn((endpoint) => endpoint),
  createAppConfigService: jest.fn(() => ({
    getAppConfig: mockGetAppConfig,
    clearAppConfigCache: mockClearAppConfigCache,
    clearOverrideCache: mockClearOverrideCache,
  })),
  applyMCPBootConfig: mockApplyMCPBootConfig,
  clearMcpConfigCache: mockClearMcpConfigCache,
  createConfigCacheInvalidation: mockCreateConfigCacheInvalidation,
  createRedisConfigInvalidationPubSub: mockCreateRedisPubSub,
  ioredisClient: null,
  cacheConfig: { USE_REDIS: false, REDIS_KEY_PREFIX: 'deploy-a' },
  createCodeEnvironmentRegistry: jest.fn(() => ({})),
  mergeAccessibleCodeEnvironments: jest.fn(({ appConfig }) => appConfig),
}));

// ── Tests ──────────────────────────────────────────────────────────────

const { getAppConfig, invalidateConfigCaches } = require('../app');
const { initializeMessageBudget } = require('~/models');
// Capture module-composition calls before clearMocks resets the spy history.
const budgetInitializations = [...initializeMessageBudget.mock.calls];
const invalidationOptions = mockCreateConfigCacheInvalidation.mock.calls[0][0];
const pubSubOptions = mockCreateRedisPubSub.mock.calls[0][0];

test('Config supplies its actual reader exactly once during composition', () => {
  expect(budgetInitializations).toEqual([[getAppConfig]]);
});

describe('invalidateConfigCaches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears the YAML base config, the override caches and the MCP config caches', async () => {
    await invalidateConfigCaches();

    const labels = invalidationOptions.clears.map(({ label }) => label);
    expect(labels).toHaveLength(3);
    expect(labels).toEqual(
      expect.arrayContaining(['clearAppConfigCache', 'clearOverrideCache', 'clearMcpConfigCache']),
    );
    expect(mockClearAppConfigCache).toHaveBeenCalledTimes(1);
    expect(mockClearOverrideCache).toHaveBeenCalledTimes(1);
    expect(mockClearMcpConfigCache).toHaveBeenCalledTimes(1);
  });

  it('leaves the global tool cache for the base reload to republish', async () => {
    await invalidateConfigCaches('tenant-a');

    expect(mockClearAppConfigCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCachedTools).not.toHaveBeenCalled();
  });

  it('passes tenantId through to clearOverrideCache', async () => {
    await invalidateConfigCaches('tenant-a');

    expect(mockClearOverrideCache).toHaveBeenCalledWith('tenant-a');
  });

  it('asks for the Redis pub/sub with the deployment settings, and broadcasts nothing without it', () => {
    expect(pubSubOptions).toEqual({ useRedis: false, client: null, namespace: 'deploy-a' });
    expect(invalidationOptions.pubsub).toBeUndefined();
  });

  it('re-applies the MCP boot settings from a config read after the caches settle', async () => {
    const order = [];
    mockClearAppConfigCache.mockImplementation(async () => {
      order.push('clear');
    });
    mockGetAppConfig.mockImplementation(async () => {
      order.push('read');
      return { availableTools: {}, mcpSettings: { allowedDomains: ['yaml.com'] } };
    });

    await invalidateConfigCaches();

    // Reading inside the batch would resolve from the cache being invalidated and install
    // the pre-change allowlists over the ones the mutation just wrote.
    expect(order).toEqual(['clear', 'read']);
    expect(mockApplyMCPBootConfig).toHaveBeenCalledWith({ allowedDomains: ['yaml.com'] });
  });

  it('resolves when the MCP boot refresh fails', async () => {
    mockGetAppConfig.mockRejectedValueOnce(new Error('config read failed'));

    await expect(invalidateConfigCaches()).resolves.not.toThrow();

    expect(mockApplyMCPBootConfig).not.toHaveBeenCalled();
  });
});
