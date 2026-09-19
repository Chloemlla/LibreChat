import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type {
  SynapseOAuthAuthorizationDecision,
  SynapseOAuthAuthorizationDecisionRequest,
  SynapseOAuthClientInput,
  SynapseOAuthClientResponse,
  SynapseOAuthMutationResponse,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

/** A client edit changes what the list shows and may add or drop its grants. */
const invalidateClients = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries([QueryKeys.synapseOAuthClients]);
  queryClient.invalidateQueries([QueryKeys.synapseOAuthGrants]);
};

export const useCreateSynapseOAuthClientMutation = (): UseMutationResult<
  SynapseOAuthClientResponse,
  Error,
  SynapseOAuthClientInput
> => {
  const queryClient = useQueryClient();
  return useMutation<SynapseOAuthClientResponse, Error, SynapseOAuthClientInput>(
    [MutationKeys.createSynapseOAuthClient],
    (payload) => dataService.createSynapseOAuthClient(payload),
    { onSuccess: () => invalidateClients(queryClient) },
  );
};

export const useUpdateSynapseOAuthClientMutation = (): UseMutationResult<
  SynapseOAuthClientResponse,
  Error,
  { clientId: string; payload: SynapseOAuthClientInput }
> => {
  const queryClient = useQueryClient();
  return useMutation<
    SynapseOAuthClientResponse,
    Error,
    { clientId: string; payload: SynapseOAuthClientInput }
  >(
    [MutationKeys.updateSynapseOAuthClient],
    ({ clientId, payload }) => dataService.updateSynapseOAuthClient(clientId, payload),
    { onSuccess: () => invalidateClients(queryClient) },
  );
};

/** The new secret is returned once and never again, so it is the caller's to display. */
export const useRotateSynapseOAuthClientSecretMutation = (): UseMutationResult<
  SynapseOAuthClientResponse,
  Error,
  string
> => {
  const queryClient = useQueryClient();
  return useMutation<SynapseOAuthClientResponse, Error, string>(
    [MutationKeys.rotateSynapseOAuthClientSecret],
    (clientId) => dataService.rotateSynapseOAuthClientSecret(clientId),
    { onSuccess: () => invalidateClients(queryClient) },
  );
};

export const useDeleteSynapseOAuthClientMutation = (): UseMutationResult<
  SynapseOAuthMutationResponse,
  Error,
  string
> => {
  const queryClient = useQueryClient();
  return useMutation<SynapseOAuthMutationResponse, Error, string>(
    [MutationKeys.deleteSynapseOAuthClient],
    (clientId) => dataService.deleteSynapseOAuthClient(clientId),
    { onSuccess: () => invalidateClients(queryClient) },
  );
};

export const useRevokeSynapseOAuthGrantMutation = (): UseMutationResult<
  SynapseOAuthMutationResponse,
  Error,
  string
> => {
  const queryClient = useQueryClient();
  return useMutation<SynapseOAuthMutationResponse, Error, string>(
    [MutationKeys.revokeSynapseOAuthGrant],
    (grantId) => dataService.revokeSynapseOAuthGrant(grantId),
    {
      onSuccess: () => {
        queryClient.invalidateQueries([QueryKeys.synapseOAuthGrants]);
        queryClient.invalidateQueries([QueryKeys.synapseOAuthClients]);
      },
    },
  );
};

export const useSubmitSynapseOAuthAuthorizationMutation = (): UseMutationResult<
  SynapseOAuthAuthorizationDecision,
  Error,
  SynapseOAuthAuthorizationDecisionRequest
> =>
  useMutation<SynapseOAuthAuthorizationDecision, Error, SynapseOAuthAuthorizationDecisionRequest>(
    [MutationKeys.submitSynapseOAuthAuthorization],
    (payload) => dataService.submitSynapseOAuthAuthorizationDecision(payload),
  );
