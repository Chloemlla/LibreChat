const { EModelEndpoint, getEnabledEndpoints } = require('librechat-data-provider');
const { getEndpointEnvironmentConfig } = require('./EndpointService');
const loadAsyncEndpoints = require('./loadAsyncEndpoints');

/**
 * The environment bootstrap for endpoint configuration: the per-endpoint config the
 * environment offers, plus the async Google credential probe. Which of those endpoints
 * are enabled, and the config served for each, is decided per request from the effective
 * app config by `resolveEnabledEndpoints` / `getEndpointsConfig` in `@librechat/api`;
 * this module only reports what the environment can offer them.
 *
 * @param {AppConfig} appConfig - The app configuration object
 * @returns {Promise<Object>} Endpoint name to the config the environment offers it, or a falsy
 * value when the environment offers none.
 */
async function loadEndpointEnvironmentConfig(appConfig) {
  const environmentConfig = getEndpointEnvironmentConfig();
  const { google } = getEnabledEndpoints().includes(EModelEndpoint.google)
    ? await loadAsyncEndpoints(appConfig)
    : { google: false };

  return { ...environmentConfig, [EModelEndpoint.google]: google };
}

module.exports = loadEndpointEnvironmentConfig;
