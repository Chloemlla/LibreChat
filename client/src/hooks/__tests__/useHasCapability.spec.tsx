import React from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BASE_SYSTEM_CAPABILITIES, QueryKeys, dataService } from 'librechat-data-provider';
import useHasCapability from '../useHasCapability';
import store from '~/store';

/** `dataService` methods are non-configurable, so the HTTP boundary is mocked at
 *  the module seam; react-query, recoil and the query hook stay real. */
jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getUserCapabilities: jest.fn(),
    },
  };
});

const getUserCapabilities = dataService.getUserCapabilities as jest.Mock;

/** Names come from the shared constant so the fixture cannot drift from the contract. */
const [held, notHeld] = BASE_SYSTEM_CAPABILITIES;

const renderHasCapability = (queriesEnabled = true) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, queriesEnabled)}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
  return { queryClient, ...renderHook(() => useHasCapability(), { wrapper }) };
};

/** Reads the cache directly: the hook surfaces no status, so this is the only way
 *  to prove the request actually settled into the state under test. */
const capabilityQueryStatus = (queryClient: QueryClient) =>
  queryClient.getQueryState([QueryKeys.userCapabilities])?.status;

describe('useHasCapability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses two distinct capabilities as its fixture', () => {
    expect(held).toBeDefined();
    expect(notHeld).toBeDefined();
    expect(notHeld).not.toBe(held);
  });

  it('grants a capability present in the response and denies one absent from it', async () => {
    getUserCapabilities.mockResolvedValue({ capabilities: [held] });
    const { result } = renderHasCapability();

    await waitFor(() => expect(result.current(held)).toBe(true));
    expect(result.current(notHeld)).toBe(false);
  });

  it('denies every capability while the response is still loading', async () => {
    getUserCapabilities.mockReturnValue(new Promise(() => {}));
    const { queryClient, result } = renderHasCapability();

    await waitFor(() => expect(capabilityQueryStatus(queryClient)).toBe('loading'));
    expect(result.current(held)).toBe(false);
    expect(result.current(notHeld)).toBe(false);
  });

  it('denies every capability when the request errors', async () => {
    getUserCapabilities.mockRejectedValue(new Error('capabilities unavailable'));
    const { queryClient, result } = renderHasCapability();

    await waitFor(() => expect(capabilityQueryStatus(queryClient)).toBe('error'));
    expect(result.current(held)).toBe(false);
    expect(result.current(notHeld)).toBe(false);
  });

  it('denies every capability without issuing a request when signed out', () => {
    getUserCapabilities.mockResolvedValue({ capabilities: [held] });
    const { result } = renderHasCapability(false);

    expect(getUserCapabilities).not.toHaveBeenCalled();
    expect(result.current(held)).toBe(false);
    expect(result.current(notHeld)).toBe(false);
  });

  it('keeps the checker referentially stable while the response is unchanged', async () => {
    getUserCapabilities.mockResolvedValue({ capabilities: [held] });
    const { result, rerender } = renderHasCapability();

    await waitFor(() => expect(result.current(held)).toBe(true));
    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
