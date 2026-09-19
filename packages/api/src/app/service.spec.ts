import type { AppConfig } from '@librechat/data-schemas';
import type { ConfigInvalidationChannelOptions } from '~/cache/invalidation';
import {
  createAppConfigService,
  _resetOverrideStrictCache,
  getAppConfigOptionsFromUser,
} from './service';
import { CONFIG_INVALIDATION_CHANNEL } from '~/cache/invalidation';

/** Extends AppConfig with mock fields used by merge behavior tests. */
interface TestConfig extends AppConfig {
  restricted?: boolean;
  x?: string;
}

/**
 * Creates a mock cache that simulates Keyv's namespace behavior.
 * Keyv stores keys internally as `namespace:key` but its API (get/set/delete)
 * accepts un-namespaced keys and auto-prepends the namespace.
 */
function createMockCache(namespace = 'app_config') {
  const store = new Map();
  return {
    get: jest.fn((key) => Promise.resolve(store.get(`${namespace}:${key}`))),
    set: jest.fn((key, value) => {
      store.set(`${namespace}:${key}`, value);
      return Promise.resolve(undefined);
    }),
    delete: jest.fn((key) => {
      store.delete(`${namespace}:${key}`);
      return Promise.resolve(true);
    }),
    /** Mimic Keyv's opts.store structure for key enumeration in clearOverrideCache */
    opts: { store: { keys: () => store.keys() } } as {
      store?: { keys: () => IterableIterator<string> };
    },
    _store: store,
  };
}

function createDeps(overrides = {}) {
  const cache = createMockCache();
  const baseConfig = { interfaceConfig: { modelSelect: true }, endpoints: ['openAI'] };

  return {
    loadBaseConfig: jest.fn().mockResolvedValue(baseConfig),
    setCachedTools: jest.fn().mockResolvedValue(undefined),
    getCache: jest.fn().mockReturnValue(cache),
    cacheKeys: { APP_CONFIG: 'app_config' },
    getApplicableConfigs: jest.fn().mockResolvedValue([]),
    getUserPrincipals: jest.fn().mockResolvedValue([
      { principalType: 'role', principalId: 'USER' },
      { principalType: 'user', principalId: 'uid1' },
    ]),
    _cache: cache,
    _baseConfig: baseConfig,
    ...overrides,
  };
}

/** Stand-in for a deployment's pub/sub bus, so a test can both emit peer events
 *  and observe what this instance broadcast. */
function createInvalidationHarness({ throttleMs = 0 } = {}) {
  const published: Array<{ channel: string; payload: string }> = [];
  const listeners: Array<(channel: string, payload: string) => void> = [];
  let peerMessageId = 0;

  const subscriber = {
    subscribe: jest.fn().mockResolvedValue(1),
    on: jest.fn((event: string, listener: (channel: string, payload: string) => void) => {
      if (event === 'message') {
        listeners.push(listener);
      }
    }),
    disconnect: jest.fn(),
  };

  const bus = {
    publish: jest.fn(async (channel: string, payload: string) => {
      published.push({ channel, payload });
      return 1;
    }),
  };

  const deliverRaw = (payload: string) => {
    for (const listener of listeners) {
      listener(CONFIG_INVALIDATION_CHANNEL, payload);
    }
  };

  const config: ConfigInvalidationChannelOptions = {
    bus,
    createSubscriber: () => subscriber,
    throttleMs,
    dedupeLimit: 8,
  };

  return {
    bus,
    subscriber,
    published,
    config,
    deliverRaw,
    deliverPeer: (request: { scope: 'base' | 'overrides'; tenantId?: string }) => {
      peerMessageId += 1;
      deliverRaw(
        JSON.stringify({ messageId: `peer-${peerMessageId}`, originId: 'peer', ...request }),
      );
    },
  };
}

/** Lets a queued invalidation batch flush. */
function settleInvalidations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

describe('createAppConfigService', () => {
  describe('getAppConfig', () => {
    it('loads base config on first call', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig();

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
      expect(config).toEqual(deps._baseConfig);
    });

    it('caches base config — does not reload on second call', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig();
      await getAppConfig();

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
    });

    it('baseOnly folds in the deployment-wide overrides without resolving principals', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockResolvedValue([
          {
            priority: 10,
            isActive: true,
            principalId: '__base__',
            overrides: { interface: { modelSelect: false } },
          },
        ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ baseOnly: true, role: 'ADMIN', userId: 'uid1' });

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
      expect(deps.getUserPrincipals).not.toHaveBeenCalled();
      /** An empty principal list is the request for the `__base__` document alone:
       *  a pre-tenant caller must never observe one principal's overrides. */
      expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
      expect((config as TestConfig).interfaceConfig?.modelSelect).toBe(false);
    });

    it('baseOnly leaves the `_BASE_` entry free of deployment overrides', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, isActive: true, overrides: { x: 'base-doc' } }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = (await getAppConfig({ baseOnly: true })) as TestConfig;

      expect(config.x).toBe('base-doc');
      /** The merge is cached beside the base, never inside it: pre-folding the
       *  `__base__` document would make it a floor, and a per-principal document
       *  with a LOWER priority could no longer be outranked by it. */
      expect(deps._cache._store.get('app_config:_BASE_')).toEqual(deps._baseConfig);
      expect(deps._cache._store.get('app_config:_BASE_EFFECTIVE_:__default__')).toEqual(
        expect.objectContaining({ x: 'base-doc' }),
      );
    });

    it('scopes the deployment config to the tenant that produced it', async () => {
      const { tenantStorage, getTenantId } = jest.requireActual('@librechat/data-schemas');
      const deps = createDeps({
        /** Each tenant's `__base__` document supplies its own marker. */
        getApplicableConfigs: jest
          .fn()
          .mockImplementation(async () => [
            { priority: 10, isActive: true, overrides: { whoami: getTenantId() } },
          ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const configA = (await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        getAppConfig({ baseOnly: true }),
      )) as TestConfig & { whoami?: string };
      const configB = (await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
        getAppConfig({ baseOnly: true }),
      )) as TestConfig & { whoami?: string };

      expect(configA.whoami).toBe('tenant-a');
      expect(configB.whoami).toBe('tenant-b');
      // A shared entry would short-circuit the second tenant's DB read.
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
    });

    it('keeps ordering the `__base__` document by priority for scoped readers', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockResolvedValue([
          { priority: 1, isActive: true, principalId: '__base__', overrides: { x: 'base' } },
          { priority: 100, isActive: true, principalId: 'ADMIN', overrides: { x: 'principal' } },
        ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = (await getAppConfig({ role: 'ADMIN' })) as TestConfig;

      expect(config.x).toBe('principal');
    });

    it('serves the deployment config from cache instead of re-reading the DB', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, isActive: true, overrides: { x: 'base-doc' } }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ baseOnly: true });
      await getAppConfig({ baseOnly: true });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });

    it('re-reads the deployment config when refresh is true', async () => {
      const getApplicableConfigs = jest
        .fn()
        .mockResolvedValue([{ priority: 10, isActive: true, overrides: { x: 'first' } }]);
      const deps = createDeps({ getApplicableConfigs });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ baseOnly: true });
      getApplicableConfigs.mockResolvedValueOnce([
        { priority: 10, isActive: true, overrides: { x: 'second' } },
      ]);
      const refreshed = (await getAppConfig({ baseOnly: true, refresh: true })) as TestConfig;

      expect(getApplicableConfigs).toHaveBeenCalledTimes(2);
      expect(refreshed.x).toBe('second');
    });

    it('falls back to the YAML base when the deployment override read fails', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockRejectedValue(new Error('DB down')),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ baseOnly: true });

      expect(config).toEqual(deps._baseConfig);
    });

    it('propagates deployment override failures for fail-closed callers', async () => {
      const error = new Error('override authorization unavailable');
      const deps = createDeps({ getApplicableConfigs: jest.fn().mockRejectedValue(error) });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ baseOnly: true, failClosed: true })).rejects.toBe(error);
    });

    it('reloads base config when refresh is true', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig();
      await getAppConfig({ refresh: true });

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
    });

    it('queries DB for applicable configs', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN' });

      expect(deps.getApplicableConfigs).toHaveBeenCalled();
    });

    it('materializes inferred model-spec endpoints in the base config', async () => {
      const deps = createDeps({
        loadBaseConfig: jest.fn().mockResolvedValue({
          modelSpecs: {
            enforce: false,
            prioritize: true,
            list: [{ name: 'agent-spec', label: 'Agent Spec', preset: { agent_id: 'agent_abc' } }],
          },
        }),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ baseOnly: true });

      expect(config.modelSpecs?.list?.[0]?.preset?.endpoint).toBe('agents');
    });

    /**
     * Admin-panel specs arrive through DB override documents the base config
     * never saw, so materialization must also run on the merged result.
     */
    it('materializes inferred model-spec endpoints contributed by DB overrides', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockResolvedValue([
          {
            priority: 10,
            isActive: true,
            overrides: {
              modelSpecs: {
                list: [
                  { name: 'agent-spec', label: 'Agent Spec', preset: { agent_id: 'agent_abc' } },
                ],
              },
            },
          },
        ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = (await getAppConfig({ role: 'USER' })) as TestConfig;

      expect(config.modelSpecs?.list?.[0]?.preset?.endpoint).toBe('agents');
      expect(config.modelSpecs?.list?.[0]?.preset?.agent_id).toBe('agent_abc');
    });

    it('caches empty result — does not re-query DB on second call', async () => {
      const deps = createDeps({ getApplicableConfigs: jest.fn().mockResolvedValue([]) });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER' });
      await getAppConfig({ role: 'USER' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });

    it('merges DB configs when found', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([
            { priority: 10, overrides: { interface: { modelSelect: false } }, isActive: true },
          ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'ADMIN' });

      const merged = config as TestConfig;
      expect(merged.interfaceConfig?.modelSelect).toBe(false);
      expect(merged.endpoints).toEqual(['openAI']);
    });

    it('caches merged result with TTL', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN' });
      await getAppConfig({ role: 'ADMIN' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });

    it('uses separate cache keys per userId (no cross-user contamination)', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([
            { priority: 100, overrides: { x: 'user-specific' }, isActive: true },
          ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ userId: 'uid1' });
      await getAppConfig({ userId: 'uid2' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
    });

    it('userId without role gets its own cache key', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 100, overrides: { y: 1 }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ userId: 'uid1' });

      const cachedKeys = [...deps._cache._store.keys()];
      const overrideKey = cachedKeys.find((k) => k.includes('_OVERRIDE_:'));
      expect(overrideKey).toBe('app_config:_OVERRIDE_:__default__:uid1');
    });

    it('tenantId is included in cache key to prevent cross-tenant contamination', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
    });

    it('base-only empty result does not block subsequent scoped queries with results', async () => {
      const mockGetConfigs = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ getApplicableConfigs: mockGetConfigs });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig();

      mockGetConfigs.mockResolvedValueOnce([
        { priority: 10, overrides: { restricted: true }, isActive: true },
      ]);
      const config = await getAppConfig({ role: 'ADMIN' });

      expect(mockGetConfigs).toHaveBeenCalledTimes(2);
      expect((config as TestConfig).restricted).toBe(true);
    });

    it('does not short-circuit other users when one user has no overrides', async () => {
      const mockGetConfigs = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ getApplicableConfigs: mockGetConfigs });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER' });
      expect(mockGetConfigs).toHaveBeenCalledTimes(1);

      mockGetConfigs.mockResolvedValueOnce([
        { priority: 10, overrides: { x: 'admin-only' }, isActive: true },
      ]);
      const config = await getAppConfig({ role: 'ADMIN' });

      expect(mockGetConfigs).toHaveBeenCalledTimes(2);
      expect((config as TestConfig).x).toBe('admin-only');
    });

    it('passes empty principals to getApplicableConfigs when buildPrincipals returns empty', async () => {
      const deps = createDeps({
        getUserPrincipals: jest.fn().mockResolvedValue([]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ userId: 'uid1', role: 'USER' });

      expect(deps.getUserPrincipals).toHaveBeenCalledWith({ userId: 'uid1', role: 'USER' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
      expect(config).toEqual(deps._baseConfig);
    });

    describe('strict mode (TENANT_ISOLATION_STRICT=true)', () => {
      beforeEach(() => {
        process.env.TENANT_ISOLATION_STRICT = 'true';
        _resetOverrideStrictCache();
      });
      afterEach(() => {
        delete process.env.TENANT_ISOLATION_STRICT;
        _resetOverrideStrictCache();
      });

      it('skips DB query for empty principals without tenantId and does not cache', async () => {
        const deps = createDeps();
        const { getAppConfig } = createAppConfigService(deps);

        const config = await getAppConfig();

        expect(deps.getApplicableConfigs).not.toHaveBeenCalled();
        expect(config).toEqual(deps._baseConfig);

        const setCalls = deps._cache.set.mock.calls.filter(
          ([key]: [string, unknown]) => key !== '_BASE_',
        );
        expect(setCalls).toHaveLength(0);
      });

      it('queries DB when tenantId is present', async () => {
        const deps = createDeps();
        const { getAppConfig } = createAppConfigService(deps);

        await getAppConfig({ tenantId: 'tenant-a' });

        expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
      });

      it('warns once when non-empty principals proceed without tenantId', async () => {
        const { logger } = jest.requireActual('@librechat/data-schemas');
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        const deps = createDeps();
        const { getAppConfig } = createAppConfigService(deps);

        await getAppConfig({ role: 'USER' });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No tenantId in strict mode'));
        const warnCount = warnSpy.mock.calls.length;

        await getAppConfig({ role: 'ADMIN' });
        expect(warnSpy).toHaveBeenCalledTimes(warnCount);

        warnSpy.mockRestore();
      });

      it('falls through to getApplicableConfigs when ALS has tenant context despite no tenantId param', async () => {
        const { tenantStorage } = jest.requireActual('@librechat/data-schemas');
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockResolvedValue([{ priority: 5, overrides: { restricted: true }, isActive: true }]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        const config = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          getAppConfig(),
        );

        expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
        expect((config as TestConfig).restricted).toBe(true);
      });
    });

    describe('non-strict mode (TENANT_ISOLATION_STRICT unset)', () => {
      beforeEach(() => {
        delete process.env.TENANT_ISOLATION_STRICT;
        _resetOverrideStrictCache();
      });
      afterEach(() => {
        _resetOverrideStrictCache();
      });

      it('passes empty principals through to getApplicableConfigs', async () => {
        const deps = createDeps();
        const { getAppConfig } = createAppConfigService(deps);

        await getAppConfig();

        expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
      });

      it('scopes the override cache key to the ALS tenant when no tenantId param is given', async () => {
        const { tenantStorage } = jest.requireActual('@librechat/data-schemas');
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          getAppConfig({ role: 'USER' }),
        );

        const overrideKey = [...deps._cache._store.keys()].find((k: string) =>
          k.includes('_OVERRIDE_:'),
        );
        expect(overrideKey).toBe('app_config:_OVERRIDE_:tenant-a:USER');
        expect(overrideKey).not.toContain('__default__');
      });

      it('does not serve one tenant a cached config built for another tenant', async () => {
        const { tenantStorage, getTenantId } = jest.requireActual('@librechat/data-schemas');
        // Each tenant's DB overrides carry a marker derived from the active ALS tenant.
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockImplementation(async () => [
              { priority: 10, overrides: { whoami: getTenantId() }, isActive: true },
            ]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        const configA = (await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          getAppConfig({ role: 'USER' }),
        )) as TestConfig & { whoami?: string };
        const configB = (await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
          getAppConfig({ role: 'USER' }),
        )) as TestConfig & { whoami?: string };

        expect(configA.whoami).toBe('tenant-a');
        expect(configB.whoami).toBe('tenant-b');
        // A cache collision would short-circuit the second tenant's DB read.
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
      });
    });

    it('does not cache on buildPrincipals error — retries on next request', async () => {
      const deps = createDeps({
        getUserPrincipals: jest
          .fn()
          .mockRejectedValueOnce(new Error('transient'))
          .mockResolvedValue([{ principalType: 'role', principalId: 'USER' }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const first = await getAppConfig({ userId: 'uid1', role: 'USER' });
      expect(first).toEqual(deps._baseConfig);
      expect(deps.getApplicableConfigs).not.toHaveBeenCalled();

      await getAppConfig({ userId: 'uid1', role: 'USER' });
      expect(deps.getUserPrincipals).toHaveBeenCalledTimes(2);
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });

    it('falls back to base config on getApplicableConfigs error', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockRejectedValue(new Error('DB down')),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'ADMIN' });

      expect(config).toEqual(deps._baseConfig);
    });

    it('calls getUserPrincipals when userId is provided', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER', userId: 'uid1' });

      expect(deps.getUserPrincipals).toHaveBeenCalledWith({
        userId: 'uid1',
        role: 'USER',
      });
    });

    it('reuses caller-resolved principals without querying them again', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);
      const resolvedPrincipals = [
        { principalType: 'role', principalId: 'USER' },
        { principalType: 'user', principalId: 'uid1' },
      ];

      await getAppConfig({ role: 'USER', userId: 'uid1', resolvedPrincipals });

      expect(deps.getUserPrincipals).not.toHaveBeenCalled();
      expect(deps.getApplicableConfigs).toHaveBeenCalledWith(resolvedPrincipals);
    });

    it('re-runs mutable principal config augmentation without rebuilding cached overrides', async () => {
      const augmentConfig = jest.fn(async ({ appConfig, principals }) => ({
        ...appConfig,
        principalCount: principals.length,
      }));
      const deps = createDeps({ augmentConfig });
      const { getAppConfig } = createAppConfigService(deps);

      const first = await getAppConfig({ role: 'USER', userId: 'uid1' });
      const second = await getAppConfig({ role: 'USER', userId: 'uid1' });

      expect(first).toEqual(expect.objectContaining({ principalCount: 2 }));
      expect(second).toEqual(expect.objectContaining({ principalCount: 2 }));
      expect(deps.getUserPrincipals).toHaveBeenCalledTimes(2);
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
      expect(augmentConfig).toHaveBeenCalledTimes(2);
      expect(augmentConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          baseConfig: deps._baseConfig,
          principals: [
            { principalType: 'role', principalId: 'USER' },
            { principalType: 'user', principalId: 'uid1' },
          ],
          options: expect.objectContaining({ role: 'USER', userId: 'uid1' }),
        }),
      );
    });

    it('skips mutable runtime augmentation when the caller already loaded it', async () => {
      const augmentConfig = jest.fn(async ({ appConfig }) => appConfig);
      const deps = createDeps({ augmentConfig });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({
        role: 'USER',
        userId: 'uid1',
        skipRuntimeAugmentation: true,
      });

      expect(augmentConfig).not.toHaveBeenCalled();
    });

    it('preserves resolved principal restrictions when optional augmentation fails', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockResolvedValue([
          {
            priority: 10,
            overrides: { endpoints: ['untrusted-override'] },
            isActive: true,
          },
        ]),
        augmentConfig: jest.fn().mockRejectedValue(new Error('authorization unavailable')),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'USER', userId: 'uid1' });

      expect(config).toEqual(
        expect.objectContaining({
          endpoints: ['untrusted-override'],
        }),
      );
    });

    it('propagates principal resolution failures for fail-closed callers', async () => {
      const error = new Error('principal authorization unavailable');
      const deps = createDeps({ getUserPrincipals: jest.fn().mockRejectedValue(error) });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ role: 'USER', userId: 'uid1', failClosed: true })).rejects.toBe(
        error,
      );
    });

    it('propagates override resolution failures for fail-closed callers', async () => {
      const error = new Error('override authorization unavailable');
      const deps = createDeps({ getApplicableConfigs: jest.fn().mockRejectedValue(error) });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ role: 'USER', userId: 'uid1', failClosed: true })).rejects.toBe(
        error,
      );
    });

    it('propagates principal augmentation failures for fail-closed callers', async () => {
      const error = new Error('environment authorization unavailable');
      const deps = createDeps({ augmentConfig: jest.fn().mockRejectedValue(error) });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ role: 'USER', userId: 'uid1', failClosed: true })).rejects.toBe(
        error,
      );
    });

    it('passes local identity through to getUserPrincipals when provided', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER', userId: 'uid1', idOnTheSource: null });

      expect(deps.getUserPrincipals).toHaveBeenCalledWith({
        userId: 'uid1',
        role: 'USER',
        idOnTheSource: null,
      });
    });

    it('uses the same override cache entry when source identity changes for a user', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER', userId: 'uid1', idOnTheSource: null });
      await getAppConfig({ role: 'USER', userId: 'uid1', idOnTheSource: 'source-user-1' });

      expect(deps.getUserPrincipals).toHaveBeenCalledTimes(2);
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
      expect([...deps._cache._store.keys()]).toEqual(
        expect.arrayContaining(['app_config:_OVERRIDE_:__default__:USER:uid1']),
      );
    });

    it('does not call getUserPrincipals when only role is provided', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN' });

      expect(deps.getUserPrincipals).not.toHaveBeenCalled();
    });
  });

  describe('clearAppConfigCache', () => {
    it('clears base config so it reloads on next call', async () => {
      const deps = createDeps();
      const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);

      await getAppConfig();
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);

      await clearAppConfigCache();
      await getAppConfig();
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
    });

    it('drops every tenant entry so baseOnly re-reads the DB', async () => {
      const { tenantStorage } = jest.requireActual('@librechat/data-schemas');
      const getApplicableConfigs = jest
        .fn()
        .mockResolvedValue([{ priority: 10, isActive: true, overrides: { x: 'base-doc' } }]);
      const deps = createDeps({ getApplicableConfigs });
      const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        getAppConfig({ baseOnly: true }),
      );
      expect(getApplicableConfigs).toHaveBeenCalledTimes(1);

      await clearAppConfigCache();

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        getAppConfig({ baseOnly: true }),
      );
      expect(getApplicableConfigs).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearOverrideCache', () => {
    it('clears all override caches when no tenantId is provided', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
      });
      const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);

      await clearOverrideCache();

      // After clearing, both tenants should re-query DB
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(4);
    });

    it('clears only specified tenant override caches', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
      });
      const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);

      await clearOverrideCache('tenant-a');

      // tenant-a should re-query, tenant-b should be cached
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(3);
    });

    it('does not clear base config', async () => {
      const deps = createDeps();
      const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);

      await getAppConfig();
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);

      await clearOverrideCache();

      await getAppConfig();
      // Base config should still be cached
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
    });

    it('does not throw when store.keys is unavailable (Redis fallback to TTL expiry)', async () => {
      const deps = createDeps();
      // Remove store.keys to simulate Redis-backed cache
      deps._cache.opts = {};
      const { clearOverrideCache } = createAppConfigService(deps);

      // Should not throw — logs warning and relies on TTL expiry
      await expect(clearOverrideCache()).resolves.toBeUndefined();
    });
  });

  describe('cross-instance invalidation', () => {
    it('broadcasts a base invalidation to peers', async () => {
      const harness = createInvalidationHarness();
      const deps = createDeps({ invalidation: harness.config });
      const { clearAppConfigCache } = createAppConfigService(deps);

      await clearAppConfigCache();

      expect(harness.published).toHaveLength(1);
      expect(harness.published[0].channel).toBe(CONFIG_INVALIDATION_CHANNEL);
      expect(JSON.parse(harness.published[0].payload)).toEqual(
        expect.objectContaining({ scope: 'base' }),
      );
    });

    it('scopes an override broadcast to the tenant being cleared', async () => {
      const harness = createInvalidationHarness();
      const deps = createDeps({ invalidation: harness.config });
      const { clearOverrideCache } = createAppConfigService(deps);

      await clearOverrideCache('tenant-a');

      expect(JSON.parse(harness.published[0].payload)).toEqual(
        expect.objectContaining({ scope: 'overrides', tenantId: 'tenant-a' }),
      );
    });

    it('still clears locally when the broadcast fails', async () => {
      const harness = createInvalidationHarness();
      harness.bus.publish.mockRejectedValueOnce(new Error('redis down'));
      const deps = createDeps({
        invalidation: harness.config,
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, isActive: true, overrides: { x: 'base-doc' } }]),
      });
      const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);
      await getAppConfig({ baseOnly: true });

      await expect(clearAppConfigCache()).resolves.toBeUndefined();

      await getAppConfig({ baseOnly: true });
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
    });

    it('applies a peer base invalidation to this instance', async () => {
      const harness = createInvalidationHarness();
      const deps = createDeps({
        invalidation: harness.config,
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, isActive: true, overrides: { x: 'base-doc' } }]),
      });
      const { getAppConfig } = createAppConfigService(deps);
      await getAppConfig({ baseOnly: true });
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);

      harness.deliverPeer({ scope: 'base' });
      await settleInvalidations();

      // Both the YAML base and the deployment merge over it are gone.
      await getAppConfig({ baseOnly: true });
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
    });

    it('applies a peer override invalidation only for the named tenant', async () => {
      const harness = createInvalidationHarness();
      const deps = createDeps({
        invalidation: harness.config,
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, isActive: true, overrides: { x: 1 } }]),
      });
      const { getAppConfig } = createAppConfigService(deps);
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);

      harness.deliverPeer({ scope: 'overrides', tenantId: 'tenant-a' });
      await settleInvalidations();

      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(3);
    });

    it('ignores its own broadcast echo', async () => {
      const harness = createInvalidationHarness();
      const deps = createDeps({ invalidation: harness.config });
      const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);
      await clearAppConfigCache();
      await getAppConfig({ baseOnly: true });
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);

      // Redis delivers a published message back to the publishing connection.
      harness.deliverRaw(harness.published[0].payload);
      await settleInvalidations();

      await getAppConfig({ baseOnly: true });
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
    });

    it('applies a redelivered peer event once', async () => {
      const harness = createInvalidationHarness({ throttleMs: 10 });
      const deps = createDeps({ invalidation: harness.config });
      const { getAppConfig } = createAppConfigService(deps);
      await getAppConfig({ baseOnly: true });
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);

      const payload = JSON.stringify({ messageId: 'm-1', originId: 'peer', scope: 'base' });
      harness.deliverRaw(payload);
      await settleInvalidations();
      harness.deliverRaw(payload);
      await settleInvalidations();

      await getAppConfig({ baseOnly: true });
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
    });

    it('collapses a burst of peer events into a single cache clear', async () => {
      const harness = createInvalidationHarness({ throttleMs: 10 });
      const deps = createDeps({ invalidation: harness.config });
      createAppConfigService(deps);
      deps._cache.delete.mockClear();

      harness.deliverPeer({ scope: 'base' });
      harness.deliverPeer({ scope: 'base' });
      harness.deliverPeer({ scope: 'base' });
      await settleInvalidations();

      /** One apply drops the two base keys; three applies would drop six. */
      expect(deps._cache.delete).toHaveBeenCalledTimes(2);
    });

    it('ignores a payload that is not an invalidation event', async () => {
      const harness = createInvalidationHarness();
      const deps = createDeps({ invalidation: harness.config });
      createAppConfigService(deps);
      deps._cache.delete.mockClear();

      harness.deliverRaw('not json');
      harness.deliverRaw(JSON.stringify({ scope: 'base' }));
      await settleInvalidations();

      expect(deps._cache.delete).not.toHaveBeenCalled();
    });
  });
});

describe('getAppConfigOptionsFromUser', () => {
  it('maps resolved request users to app config principal options', () => {
    expect(
      getAppConfigOptionsFromUser({
        id: 'uid1',
        role: 'USER',
        tenantId: 'tenant-a',
        idOnTheSource: 'source-user-1',
      }),
    ).toEqual({
      role: 'USER',
      userId: 'uid1',
      idOnTheSource: 'source-user-1',
      tenantId: 'tenant-a',
    });
  });

  it('preserves omitted source identity for partial users so fallback lookup can run', () => {
    expect(getAppConfigOptionsFromUser({ id: 'uid1', role: 'USER' })).toEqual({
      role: 'USER',
      userId: 'uid1',
      idOnTheSource: undefined,
      tenantId: undefined,
    });
  });

  it('marks explicitly normalized local users with null idOnTheSource', () => {
    expect(getAppConfigOptionsFromUser({ id: 'uid1', role: 'USER', idOnTheSource: null })).toEqual({
      role: 'USER',
      userId: 'uid1',
      idOnTheSource: null,
      tenantId: undefined,
    });
  });

  it('omits source identity when no user id is available', () => {
    expect(getAppConfigOptionsFromUser({ role: 'USER', tenantId: 'tenant-a' })).toEqual({
      role: 'USER',
      userId: undefined,
      idOnTheSource: undefined,
      tenantId: 'tenant-a',
    });
  });
});
