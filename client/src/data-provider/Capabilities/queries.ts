import { useRecoilValue } from 'recoil';
import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type { TUserCapabilitiesResponse } from 'librechat-data-provider';
import store from '~/store';

/**
 * Reads the capabilities the signed-in user holds. The three `refetchOn*`
 * switches are off, as on `useGetUserQuery`: the answer changes only through an
 * administrative grant, and the login and logout mutations already drop the
 * whole cache, so the grant is picked up on the next sign-in.
 *
 * `queriesEnabled` keeps the request off the login page, where there is no
 * bearer token to authenticate it.
 */
export const useGetUserCapabilitiesQuery = (
  config?: UseQueryOptions<TUserCapabilitiesResponse>,
): QueryObserverResult<TUserCapabilitiesResponse> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<TUserCapabilitiesResponse>(
    [QueryKeys.userCapabilities],
    () => dataService.getUserCapabilities(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: (config?.enabled ?? true) === true && queriesEnabled,
    },
  );
};
