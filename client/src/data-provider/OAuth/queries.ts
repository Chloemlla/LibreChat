import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type {
  SynapseOAuthAuthorizeParams,
  SynapseOAuthAuthorizationContext,
  SynapseOAuthClientsResponse,
  SynapseOAuthGrantsResponse,
  SynapseOAuthScopesResponse,
} from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';

/** The scope catalogue the consent screen and the client editor both group by category. */
export const useSynapseOAuthScopesQuery = (
  config?: UseQueryOptions<SynapseOAuthScopesResponse>,
): QueryObserverResult<SynapseOAuthScopesResponse> =>
  useQuery<SynapseOAuthScopesResponse>(
    [QueryKeys.synapseOAuthScopes],
    () => dataService.getSynapseOAuthScopes(),
    config,
  );

export const useSynapseOAuthClientsQuery = (
  config?: UseQueryOptions<SynapseOAuthClientsResponse>,
): QueryObserverResult<SynapseOAuthClientsResponse> =>
  useQuery<SynapseOAuthClientsResponse>(
    [QueryKeys.synapseOAuthClients],
    () => dataService.listSynapseOAuthClients(),
    config,
  );

export const useSynapseOAuthGrantsQuery = (
  config?: UseQueryOptions<SynapseOAuthGrantsResponse>,
): QueryObserverResult<SynapseOAuthGrantsResponse> =>
  useQuery<SynapseOAuthGrantsResponse>(
    [QueryKeys.synapseOAuthGrants],
    () => dataService.listSynapseOAuthGrants(),
    config,
  );

/**
 * Resolves an authorize query into what the consent screen renders. The answer is a
 * discriminated union rather than an error: "sign in first" and "you may not grant" are
 * both outcomes of a well-formed request, and the second carries the redirect the
 * browser has to follow.
 *
 * `retry: false` — a retried request would mint a second consent nonce, and only the
 * one the screen holds can be spent.
 */
export const useSynapseOAuthAuthorizationQuery = (
  params: SynapseOAuthAuthorizeParams,
  config?: UseQueryOptions<SynapseOAuthAuthorizationContext>,
): QueryObserverResult<SynapseOAuthAuthorizationContext> =>
  useQuery<SynapseOAuthAuthorizationContext>(
    [QueryKeys.synapseOAuthAuthorization, params],
    () => dataService.getSynapseOAuthAuthorizationContext(params),
    { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, ...config },
  );
