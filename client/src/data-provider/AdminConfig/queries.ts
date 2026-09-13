import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, DynamicQueryKeys, MutationKeys, QueryKeys } from 'librechat-data-provider';
import type {
  TConfigPrincipalType,
  TAdminConfigPrincipal,
  TAdminConfigListResponse,
  TAdminConfigResponse,
  TAdminConfigWriteResponse,
  TAdminConfigDeleteResponse,
  TAdminBaseConfigResponse,
  TAdminConfigOverridesRequest,
  TAdminConfigFieldsRequest,
  TAdminConfigTombstoneRequest,
  TAdminConfigFieldRequest,
  TAdminConfigActiveRequest,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';

/**
 * A write to the base principal changes what `GET /base` resolves to, and a
 * write's target is not distinguishable at this layer, so all three caches drop.
 */
function invalidateAdminConfigQueries(queryClient: QueryClient): void {
  queryClient.invalidateQueries([QueryKeys.adminConfigs]);
  queryClient.invalidateQueries([QueryKeys.adminConfig]);
  queryClient.invalidateQueries([QueryKeys.adminBaseConfig]);
}

export function useAdminConfigsQuery(enabled = true) {
  return useQuery<TAdminConfigListResponse>(
    [QueryKeys.adminConfigs],
    () => dataService.getAdminConfigs(),
    { enabled, refetchOnWindowFocus: false },
  );
}

export function useAdminBaseConfigQuery(baseOnly = false, enabled = true) {
  return useQuery<TAdminBaseConfigResponse>(
    [QueryKeys.adminBaseConfig, baseOnly],
    () => dataService.getAdminBaseConfig(baseOnly),
    { enabled, refetchOnWindowFocus: false },
  );
}

export function useAdminConfigQuery(
  principalType: TConfigPrincipalType,
  principalId: string,
  enabled = true,
) {
  return useQuery<TAdminConfigResponse>(
    DynamicQueryKeys.adminConfigPrincipal(principalType, principalId),
    () => dataService.getAdminConfig({ principalType, principalId }),
    { enabled: enabled && principalId.length > 0, refetchOnWindowFocus: false, retry: false },
  );
}

export function useUpsertAdminConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation<TAdminConfigWriteResponse, Error, TAdminConfigOverridesRequest>(
    [MutationKeys.upsertAdminConfig],
    dataService.upsertAdminConfig,
    {
      onSuccess: () => invalidateAdminConfigQueries(queryClient),
    },
  );
}

export function usePatchAdminConfigFieldsMutation() {
  const queryClient = useQueryClient();
  return useMutation<TAdminConfigWriteResponse, Error, TAdminConfigFieldsRequest>(
    [MutationKeys.patchAdminConfigFields],
    dataService.patchAdminConfigFields,
    {
      onSuccess: () => invalidateAdminConfigQueries(queryClient),
    },
  );
}

export function useTombstoneAdminConfigFieldMutation() {
  const queryClient = useQueryClient();
  return useMutation<TAdminConfigWriteResponse, Error, TAdminConfigTombstoneRequest>(
    [MutationKeys.tombstoneAdminConfigField],
    dataService.tombstoneAdminConfigField,
    {
      onSuccess: () => invalidateAdminConfigQueries(queryClient),
    },
  );
}

export function useDeleteAdminConfigFieldMutation() {
  const queryClient = useQueryClient();
  return useMutation<TAdminConfigResponse, Error, TAdminConfigFieldRequest>(
    [MutationKeys.deleteAdminConfigField],
    dataService.deleteAdminConfigField,
    {
      onSuccess: () => invalidateAdminConfigQueries(queryClient),
    },
  );
}

export function useDeleteAdminConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation<TAdminConfigDeleteResponse, Error, TAdminConfigPrincipal>(
    [MutationKeys.deleteAdminConfig],
    dataService.deleteAdminConfig,
    {
      onSuccess: () => invalidateAdminConfigQueries(queryClient),
    },
  );
}

export function useToggleAdminConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation<TAdminConfigResponse, Error, TAdminConfigActiveRequest>(
    [MutationKeys.toggleAdminConfig],
    dataService.toggleAdminConfig,
    {
      onSuccess: () => invalidateAdminConfigQueries(queryClient),
    },
  );
}
