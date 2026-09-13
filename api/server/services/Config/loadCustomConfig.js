const path = require('path');
const axios = require('axios');
const yaml = require('js-yaml');
const keyBy = require('lodash/keyBy');
const { loadYaml, redactConfigSecretMaps, resolveConfigEnvPath } = require('@librechat/api');
const { Providers } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const {
  configSchema,
  paramSettings,
  EModelEndpoint,
  EImageOutputType,
  setMaxSubagents,
  agentParamSettings,
  validateSettingDefinitions,
} = require('librechat-data-provider');

const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
const defaultConfigPath = path.resolve(projectRoot, 'librechat.yaml');

let i = 0;

const OPENROUTER_PROMPT_CACHE_DEFAULT = {
  key: 'promptCache',
  default: true,
};

function includesOpenRouter(value) {
  return typeof value === 'string' && value.toLowerCase().includes(Providers.OPENROUTER);
}

function isOpenRouterEndpoint(endpoint) {
  return includesOpenRouter(endpoint.name) || includesOpenRouter(endpoint.baseURL);
}

function shouldPreserveCustomParams(customParams) {
  const defaultEndpoint = customParams?.defaultParamsEndpoint;
  return (
    defaultEndpoint && defaultEndpoint !== 'custom' && defaultEndpoint !== Providers.OPENROUTER
  );
}

function addOpenRouterDefaults(endpoint) {
  if (!isOpenRouterEndpoint(endpoint)) {
    return;
  }

  if (shouldPreserveCustomParams(endpoint.customParams)) {
    return;
  }

  const customParams = endpoint.customParams ?? {};
  const paramDefinitions = customParams.paramDefinitions ?? [];
  const hasPromptCache = paramDefinitions.some((param) => param.key === 'promptCache');

  endpoint.customParams = {
    ...customParams,
    defaultParamsEndpoint: Providers.OPENROUTER,
    paramDefinitions: hasPromptCache
      ? paramDefinitions
      : [...paramDefinitions, OPENROUTER_PROMPT_CACHE_DEFAULT],
  };
}

/**
 * Map of environment variable names to config paths
 * Format: LIBRECHAT_<PATH> where path segments are separated by underscores
 * Examples:
 *   LIBRECHAT_CACHE=true -> cache: true
 *   LIBRECHAT_INTERFACE_CUSTOMWELCOME="Hello" -> interface.customWelcome: "Hello"
 *   LIBRECHAT_INTERFACE_FILESEARCH=false -> interface.fileSearch: false
 *   LIBRECHAT_TURNSTILE_SITEKEY="key" -> turnstile.siteKey: "key"
 *
 * @type {Map<string, string>}
 */
const envVarMap = new Map();

/**
 * Parse environment variables and build a config object from them
 * Supports nested properties using underscore-separated paths
 * @returns {Object} Config object built from environment variables
 */
function parseEnvVarsToConfig() {
  const envConfig = {};
  envVarMap.clear();

  // Regular expression to match LIBRECHAT_ prefixed environment variables
  const librechatEnvRegex = /^LIBRECHAT_(.+)$/i;

  Object.entries(process.env).forEach(([key, value]) => {
    const match = key.match(librechatEnvRegex);
    if (!match) return;

    const pathParts = resolveConfigEnvPath(match[1]);
    if (!pathParts) return;

    // Navigate/create the nested path
    let current = envConfig;
    for (let i = 0; i < pathParts.length - 1; i++) {
      if (!current[pathParts[i]]) {
        current[pathParts[i]] = {};
      }
      current = current[pathParts[i]];
    }

    const lastKey = pathParts[pathParts.length - 1];

    // Parse the value type based on content
    let parsedValue = value;
    if (value.toLowerCase() === 'true') {
      parsedValue = true;
    } else if (value.toLowerCase() === 'false') {
      parsedValue = false;
    } else if (value.toLowerCase() === 'null') {
      parsedValue = null;
    } else if (!isNaN(value) && value !== '') {
      // Try to parse as number
      parsedValue = Number(value);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Try to parse as JSON array
      try {
        parsedValue = JSON.parse(value);
      } catch (_e) {
        // Keep as string if JSON parse fails
      }
    } else if (value.startsWith('{') && value.endsWith('}')) {
      // Try to parse as JSON object
      try {
        parsedValue = JSON.parse(value);
      } catch (_e) {
        // Keep as string if JSON parse fails
      }
    }

    current[lastKey] = parsedValue;
    envVarMap.set(key, pathParts.join('.'));
  });

  return envConfig;
}

/**
 * Deep merge environment config into YAML config
 * Environment variables take precedence over YAML config
 * @param {Object} yamlConfig - Configuration from YAML file
 * @param {Object} envConfig - Configuration from environment variables
 * @returns {Object} Merged configuration
 */
function mergeEnvConfig(yamlConfig, envConfig) {
  if (!yamlConfig || typeof yamlConfig !== 'object') {
    return envConfig || yamlConfig;
  }

  const merged = { ...yamlConfig };

  Object.entries(envConfig).forEach(([key, value]) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively merge objects
      merged[key] = mergeEnvConfig(merged[key], value);
    } else {
      // Override with environment variable value
      merged[key] = value;
      if (envVarMap.get(`LIBRECHAT_${key.toUpperCase()}`)) {
        logger.debug(
          `[loadCustomConfig] Env var override: ${key.toUpperCase()} = ${JSON.stringify(value)}`,
        );
      }
    }
  });

  return merged;
}

/**
 * Load custom configuration files and caches the object if the `cache` field at root is true.
 * Validation via parsing the config file with the config schema.
 * Supports environment variable overrides via LIBRECHAT_* environment variables
 * @function loadCustomConfig
 * @returns {Promise<TCustomConfig | null>} A promise that resolves to null or the custom config object.
 * */
async function loadCustomConfig(printConfig = true) {
  // Use CONFIG_PATH if set, otherwise fallback to defaultConfigPath
  const configPath = process.env.CONFIG_PATH || defaultConfigPath;

  let customConfig;

  if (/^https?:\/\//.test(configPath)) {
    try {
      const response = await axios.get(configPath);
      customConfig = response.data;
    } catch (error) {
      i === 0 && logger.error(`Failed to fetch the remote config file from ${configPath}`, error);
      i === 0 && i++;
      return null;
    }
  } else {
    customConfig = loadYaml(configPath);
    if (!customConfig) {
      i === 0 &&
        logger.info(
          'Custom config file missing or YAML format invalid.\n\nCheck out the latest config file guide for configurable options and features.\nhttps://www.librechat.ai/docs/configuration/librechat_yaml\n\n',
        );
      i === 0 && i++;
      return null;
    }

    if (customConfig.code === 'ENOENT') {
      i === 0 &&
        logger.info(
          `Custom config file not found at ${configPath}; running on environment configuration alone.`,
        );
      i === 0 && i++;
      return null;
    }

    if (customConfig.reason || customConfig.stack) {
      i === 0 && logger.error('Config file YAML format is invalid:', customConfig);
      i === 0 && i++;
      return null;
    }
  }

  if (typeof customConfig === 'string') {
    try {
      customConfig = yaml.load(customConfig);
    } catch (parseError) {
      i === 0 && logger.info(`Failed to parse the YAML config from ${configPath}`, parseError);
      i === 0 && i++;
      return null;
    }
  }

  // Parse environment variables and merge them into the config
  const envConfig = parseEnvVarsToConfig();
  if (Object.keys(envConfig).length > 0) {
    customConfig = mergeEnvConfig(customConfig, envConfig);
    if (printConfig) {
      logger.info(
        '[loadCustomConfig] Environment variables applied:',
        Array.from(envVarMap.keys()),
      );
    }
  }

  // Applied before parsing so specs validated in the same pass (whose subagent
  // presets share the cap) check against the configured limit. Invalid values
  // are ignored here and rejected by the schema parse below.
  setMaxSubagents(customConfig?.endpoints?.[EModelEndpoint.agents]?.maxSubagents);

  const result = configSchema.strict().safeParse(customConfig);
  if (result?.error?.errors?.some((err) => err?.path && err.path?.includes('imageOutputType'))) {
    throw new Error(
      `
Please specify a correct \`imageOutputType\` value (case-sensitive).

      The available options are:
      - ${EImageOutputType.JPEG}
      - ${EImageOutputType.PNG}
      - ${EImageOutputType.WEBP}
      
      Refer to the latest config file guide for more information:
      https://www.librechat.ai/docs/configuration/librechat_yaml`,
    );
  }
  if (!result.success) {
    let errorMessage = `Invalid custom config file at ${configPath}:
${JSON.stringify(result.error, null, 2)}`;

    logger.error(errorMessage);
    const speechError = result.error.errors.find(
      (err) =>
        err.code === 'unrecognized_keys' &&
        (err.message?.includes('stt') || err.message?.includes('tts')),
    );

    if (speechError) {
      logger.warn(`
The Speech-to-text and Text-to-speech configuration format has recently changed.
If you're getting this error, please refer to the latest documentation:

https://www.librechat.ai/docs/configuration/stt_tts`);
    }

    if (process.env.CONFIG_BYPASS_VALIDATION === 'true') {
      logger.warn(
        'CONFIG_BYPASS_VALIDATION is enabled. Continuing with default configuration despite validation errors.',
      );
      return null;
    }

    logger.error(
      'Exiting due to invalid configuration. Set CONFIG_BYPASS_VALIDATION=true to bypass this check.',
    );
    process.exit(1);
  } else {
    if (printConfig) {
      // Masks map-valued secrets (e.g. `langfuse.headers`) so literal gateway
      // credentials are not copied into application logs on every startup.
      const loggableConfig = redactConfigSecretMaps(customConfig);
      logger.info('Custom config file loaded:');
      logger.info(JSON.stringify(loggableConfig, null, 2));
      logger.debug('Custom config:', loggableConfig);
    }
  }

  (customConfig.endpoints?.custom ?? []).forEach(addOpenRouterDefaults);

  (customConfig.endpoints?.custom ?? [])
    .filter((endpoint) => endpoint.customParams)
    .forEach((endpoint) => parseCustomParams(endpoint.name, endpoint.customParams));

  if (result.data.modelSpecs) {
    customConfig.modelSpecs = result.data.modelSpecs;
  }

  return customConfig;
}

// Validate and fill out missing values for custom parameters
function parseCustomParams(endpointName, customParams) {
  const paramEndpoint = customParams.defaultParamsEndpoint ?? 'custom';
  customParams.defaultParamsEndpoint = paramEndpoint;
  customParams.paramDefinitions = customParams.paramDefinitions || [];

  // Checks if `defaultParamsEndpoint` is a key in `paramSettings`.
  const validEndpoints = new Set([
    ...Object.keys(paramSettings),
    ...Object.keys(agentParamSettings),
  ]);
  if (!validEndpoints.has(paramEndpoint)) {
    throw new Error(
      `defaultParamsEndpoint of "${endpointName}" endpoint is invalid. ` +
        `Valid options are ${Array.from(validEndpoints).join(', ')}`,
    );
  }

  // creates default param maps
  const regularParams = paramSettings[paramEndpoint] ?? [];
  const agentParams = agentParamSettings[paramEndpoint] ?? [];
  const defaultParams = regularParams.concat(agentParams);
  const defaultParamsMap = keyBy(defaultParams, 'key');

  // TODO: Remove this check once we support new parameters not part of default parameters.
  // Checks if every key in `paramDefinitions` is valid.
  const validKeys = new Set(Object.keys(defaultParamsMap));
  const paramKeys = customParams.paramDefinitions.map((param) => param.key);
  if (paramKeys.some((key) => !validKeys.has(key))) {
    throw new Error(
      `paramDefinitions of "${endpointName}" endpoint contains invalid key(s). ` +
        `Valid parameter keys are ${Array.from(validKeys).join(', ')}`,
    );
  }

  // Fill out missing values for custom param definitions
  customParams.paramDefinitions = customParams.paramDefinitions.map((param) => {
    return { ...defaultParamsMap[param.key], ...param, optionType: 'custom' };
  });

  try {
    validateSettingDefinitions(customParams.paramDefinitions);
  } catch (e) {
    throw new Error(
      `Custom parameter definitions for "${endpointName}" endpoint is malformed: ${e.message}`,
    );
  }
}

module.exports = loadCustomConfig;
