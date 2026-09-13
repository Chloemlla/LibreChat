import { useCallback } from 'react';
import type { BaseSystemCapability } from 'librechat-data-provider';
import { useGetUserCapabilitiesQuery } from '~/data-provider';

/**
 * Answers capability questions for the app shell. Every unresolved state —
 * loading, error, signed out — must deny: hiding an entry the user is entitled
 * to is recoverable by a reload, rendering one they are not entitled to is not.
 * The returned function is stable while the response is unchanged so callers can
 * hold it in `useMemo`/dependency arrays.
 */
export default function useHasCapability(): (capability: BaseSystemCapability) => boolean {
  const { data } = useGetUserCapabilitiesQuery();
  const capabilities = data?.capabilities;

  return useCallback(
    (capability: BaseSystemCapability) => capabilities?.includes(capability) === true,
    [capabilities],
  );
}
