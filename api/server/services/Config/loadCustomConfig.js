const path = require('path');
const axios = require('axios');
const {
  loadYaml,
  redactConfigSecretMaps,
  createCustomConfigLoader,
  resolveConfigEnvPath,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
const defaultConfigPath = path.resolve(projectRoot, 'librechat.yaml');

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
 * Folds `LIBRECHAT_*` overrides into a loaded source. Anything that is not a plain
 * object -- a missing file's `Error`, malformed YAML, a remote response that still
 * has to be parsed as a string -- is returned untouched so the loader keeps
 * reporting it exactly as it did before.
 */
function applyEnvOverrides(source) {
  if (
    source == null ||
    typeof source !== 'object' ||
    source instanceof Error ||
    Array.isArray(source)
  ) {
    return source;
  }

  const envConfig = parseEnvVarsToConfig();
  if (Object.keys(envConfig).length === 0) {
    return source;
  }

  return mergeEnvConfig(source, envConfig);
}

/**
 * A missing file is not malformed YAML: `loadYaml` surfaces the `ENOENT` error, which
 * the loader would otherwise report at error level. Report it once, at info level, and
 * let the loader's missing-source path answer with null.
 */
let hasLoggedMissingConfig = false;

function loadLocalWithEnvOverrides(configPath) {
  const source = loadYaml(configPath);
  if (source instanceof Error && source.code === 'ENOENT') {
    if (!hasLoggedMissingConfig) {
      logger.info(
        `Custom config file not found at ${configPath}; running on environment configuration alone.`,
      );
      hasLoggedMissingConfig = true;
    }
    return undefined;
  }

  return applyEnvOverrides(source);
}

async function fetchRemoteWithEnvOverrides(configPath) {
  const response = await axios.get(configPath);
  return applyEnvOverrides(response.data);
}

const loadCustomConfig = createCustomConfigLoader({
  loadLocal: loadLocalWithEnvOverrides,
  fetchRemote: fetchRemoteWithEnvOverrides,
  defaultConfigPath,
  redactConfig: redactConfigSecretMaps,
});

/** Reports the applied overrides under the same `printConfig` gate as the config dump. */
module.exports = async function loadCustomConfigWithEnvReport(printConfig = true, options) {
  envVarMap.clear();
  const config = await loadCustomConfig(printConfig, options);
  if (printConfig && envVarMap.size > 0) {
    logger.info('[loadCustomConfig] Environment variables applied:', Array.from(envVarMap.keys()));
  }
  return config;
};
