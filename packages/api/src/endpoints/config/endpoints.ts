import {
  AuthType,
  CODE_APPROVAL_MODES,
  EModelEndpoint,
  getEnabledEndpoints,
  isAgentsEndpoint,
  orderEndpointsConfig,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { AgentCapabilities, TEndpointsConfig, TConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest, TCustomEndpointsConfig } from '~/types';
import type { GetAppConfigOptions } from '~/app/service';
import { loadCustomEndpointsConfig as defaultLoadCustomEndpoints } from '~/endpoints/custom';
import { getAppConfigOptionsFromUser } from '~/app/service';

type PartialEndpointEntry = Partial<TConfig> & Record<string, unknown>;
type DefaultEndpointsResult = Record<string, PartialEndpointEntry | false | null>;
type MutableEndpointsConfig = Record<string, PartialEndpointEntry | false | null | undefined>;

/** One endpoint's bootstrap config from the environment, or a falsy value when it offers none. */
export type EndpointEnvironmentEntry = Partial<TConfig> | false | null | undefined;

/** What the environment offers each built-in endpoint: the bootstrap and fallback for the app config. */
export type EndpointEnvironmentConfig = { [endpoint: string]: EndpointEnvironmentEntry };

/** Every built-in endpoint a served config can be assembled for; `custom` comes from the config itself. */
const BUILT_IN_ENDPOINTS: readonly EModelEndpoint[] = [
  EModelEndpoint.openAI,
  EModelEndpoint.google,
  EModelEndpoint.anthropic,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
  EModelEndpoint.agents,
  EModelEndpoint.bedrock,
];

const isBuiltInEndpoint = (endpoint: string): boolean =>
  BUILT_IN_ENDPOINTS.includes(endpoint as EModelEndpoint);

/**
 * Which endpoints the client should be offered, in the order it should offer them.
 *
 * The `ENDPOINTS` environment list decides every endpoint the environment bootstraps — an
 * operator still hides one by omitting it — and an endpoint the assembled config derives on
 * its own is kept even when that list omits it, so what an admin config declares is not vetoed
 * by the environment. `custom` keeps its environment position; its entries are configured and
 * ordered on their own.
 */
export function resolveEnabledEndpoints({
  configuredEndpoints,
  environmentConfig,
  environmentEndpoints = getEnabledEndpoints(),
}: {
  configuredEndpoints: string[];
  environmentConfig?: EndpointEnvironmentConfig;
  environmentEndpoints?: string[];
}): string[] {
  const enabledEndpoints = environmentEndpoints.filter(
    (endpoint) => endpoint === EModelEndpoint.custom || Boolean(environmentConfig?.[endpoint]),
  );

  configuredEndpoints.filter(isBuiltInEndpoint).forEach((endpoint) => {
    const isEnvironmentEndpoint = Boolean(environmentConfig?.[endpoint]);
    if (!isEnvironmentEndpoint && !enabledEndpoints.includes(endpoint)) {
      enabledEndpoints.push(endpoint);
    }
  });

  return enabledEndpoints;
}

/** The endpoints the environment bootstraps: its own config, or nothing where it offers none. */
function resolveDefaultEndpointsConfig({
  environmentConfig,
}: {
  environmentConfig?: EndpointEnvironmentConfig;
}): DefaultEndpointsResult {
  return BUILT_IN_ENDPOINTS.reduce<DefaultEndpointsResult>((config, endpoint) => {
    const environmentEntry = environmentConfig?.[endpoint];
    if (!environmentEntry) {
      return config;
    }
    config[endpoint] = { ...environmentEntry };
    return config;
  }, {});
}

export interface EndpointsConfigDeps {
  getAppConfig: (params: GetAppConfigOptions) => Promise<AppConfig>;
  /** The environment's endpoint bootstrap (EndpointService env plus the async Google probe). */
  loadDefaultEndpointsConfig: (appConfig: AppConfig) => Promise<EndpointEnvironmentConfig>;
  loadCustomEndpointsConfig?: (custom: unknown) => TCustomEndpointsConfig | undefined;
}

export function createEndpointsConfigService(deps: EndpointsConfigDeps): {
  getEndpointsConfig: (req: ServerRequest) => Promise<TEndpointsConfig>;
  checkCapability: (req: ServerRequest, capability: AgentCapabilities) => Promise<boolean>;
} {
  const {
    getAppConfig,
    loadDefaultEndpointsConfig,
    loadCustomEndpointsConfig = defaultLoadCustomEndpoints,
  } = deps;

  async function getEndpointsConfig(req: ServerRequest): Promise<TEndpointsConfig> {
    const appConfig = req.config ?? (await getAppConfig(getAppConfigOptionsFromUser(req.user)));
    const environmentConfig = await loadDefaultEndpointsConfig(appConfig);
    const defaultEndpointsConfig = resolveDefaultEndpointsConfig({ environmentConfig });
    const customEndpointsConfig = loadCustomEndpointsConfig(appConfig?.endpoints?.custom);

    const mergedConfig: MutableEndpointsConfig = {
      ...defaultEndpointsConfig,
      ...customEndpointsConfig,
    };

    if (appConfig.endpoints?.[EModelEndpoint.azureOpenAI]) {
      mergedConfig[EModelEndpoint.azureOpenAI] = { userProvide: false };
    }

    if (appConfig.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig?.enabled) {
      mergedConfig[EModelEndpoint.anthropic] = { userProvide: false };
    }

    if (appConfig.endpoints?.[EModelEndpoint.azureOpenAI]?.assistants) {
      mergedConfig[EModelEndpoint.azureAssistants] = { userProvide: false };
    }

    if (
      mergedConfig[EModelEndpoint.assistants] &&
      appConfig?.endpoints?.[EModelEndpoint.assistants]
    ) {
      const { disableBuilder, retrievalModels, capabilities, version } =
        appConfig.endpoints[EModelEndpoint.assistants];
      mergedConfig[EModelEndpoint.assistants] = {
        ...mergedConfig[EModelEndpoint.assistants],
        version: version != null ? String(version) : undefined,
        retrievalModels,
        disableBuilder,
        capabilities,
      };
    }

    if (mergedConfig[EModelEndpoint.agents] && appConfig?.endpoints?.[EModelEndpoint.agents]) {
      const { disableBuilder, capabilities, allowedProviders, statefulCodeSessions, maxSubagents } =
        appConfig.endpoints[EModelEndpoint.agents];
      const toolApproval = appConfig.endpoints[EModelEndpoint.agents].toolApproval;
      /** Only advertise Accept edits when the endpoint fallback cannot force every
       * unmatched tool back to Ask/Deny. Explicit rules and hooks remain free to
       * tighten individual actions after the user selects the broader mode. */
      let approvalModes = [...CODE_APPROVAL_MODES];
      if (toolApproval?.enabled === false) {
        approvalModes = [];
      } else if (toolApproval?.enabled === true && toolApproval.mode !== 'bypass') {
        approvalModes = ['ask'];
      }
      const clientStatefulCodeSessions = statefulCodeSessions
        ? {
            allowedEnvironments: statefulCodeSessions.allowedEnvironments,
            approvalsEnabled: toolApproval?.enabled !== false,
            approvalModes,
            environments: statefulCodeSessions.environments
              ?.filter(
                (environment) =>
                  !(
                    environment.pairing?.allowPrincipalWorkers === true &&
                    environment.pairing.workerId == null &&
                    environment.workerId == null
                  ),
              )
              .map(({ id, name, type, default: isDefault, configSchema, settings }) => ({
                id,
                name,
                type,
                default: isDefault,
                configSchema,
                settings,
              })),
          }
        : undefined;
      mergedConfig[EModelEndpoint.agents] = {
        ...mergedConfig[EModelEndpoint.agents],
        allowedProviders,
        disableBuilder,
        capabilities,
        statefulCodeSessions: clientStatefulCodeSessions,
        maxSubagents,
      };
    }

    if (
      mergedConfig[EModelEndpoint.azureAssistants] &&
      appConfig?.endpoints?.[EModelEndpoint.azureAssistants]
    ) {
      const { disableBuilder, retrievalModels, capabilities, version } =
        appConfig.endpoints[EModelEndpoint.azureAssistants];
      mergedConfig[EModelEndpoint.azureAssistants] = {
        ...mergedConfig[EModelEndpoint.azureAssistants],
        version: version != null ? String(version) : undefined,
        retrievalModels,
        disableBuilder,
        capabilities,
      };
    }

    if (mergedConfig[EModelEndpoint.bedrock] && appConfig?.endpoints?.[EModelEndpoint.bedrock]) {
      const { availableRegions } = appConfig.endpoints[EModelEndpoint.bedrock] as {
        availableRegions?: string[];
      };
      mergedConfig[EModelEndpoint.bedrock] = {
        ...mergedConfig[EModelEndpoint.bedrock],
        availableRegions,
      };
    }

    if (mergedConfig[EModelEndpoint.bedrock]) {
      mergedConfig[EModelEndpoint.bedrock] = {
        ...mergedConfig[EModelEndpoint.bedrock],
        userProvideAccessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID === AuthType.USER_PROVIDED,
        userProvideSecretAccessKey:
          process.env.BEDROCK_AWS_SECRET_ACCESS_KEY === AuthType.USER_PROVIDED,
        userProvideSessionToken: process.env.BEDROCK_AWS_SESSION_TOKEN === AuthType.USER_PROVIDED,
        userProvideBearerToken: process.env.BEDROCK_AWS_BEARER_TOKEN === AuthType.USER_PROVIDED,
      };
    }

    const enabledEndpoints = resolveEnabledEndpoints({
      configuredEndpoints: Object.keys(mergedConfig),
      environmentConfig,
    });

    return orderEndpointsConfig(mergedConfig as TEndpointsConfig, enabledEndpoints);
  }

  async function checkCapability(
    req: ServerRequest,
    capability: AgentCapabilities,
  ): Promise<boolean> {
    const isAgents = isAgentsEndpoint(req.body?.endpointType || req.body?.endpoint);
    const endpointsConfig = await getEndpointsConfig(req);
    const capabilities =
      isAgents || endpointsConfig?.[EModelEndpoint.agents]?.capabilities != null
        ? (endpointsConfig?.[EModelEndpoint.agents]?.capabilities ?? [])
        : defaultAgentCapabilities;
    return capabilities.includes(capability);
  }

  return { getEndpointsConfig, checkCapability };
}
