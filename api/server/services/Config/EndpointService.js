const { isUserProvided, isEnabled } = require('@librechat/api');
const { EModelEndpoint } = require('librechat-data-provider');
const { generateConfig } = require('~/server/utils/handleText');

const firstNonEmpty = (...values) => values.find((value) => value != null && value !== '');

/**
 * The configuration the environment offers each built-in endpoint. Computed per call
 * rather than captured at module load: env is the bootstrap and fallback source for
 * endpoint configuration, so a snapshot taken at startup must not be what decides
 * which endpoints can serve a request once the effective app config has changed.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {EndpointServiceConfig}
 */
function getEndpointEnvironmentConfig(env = process.env) {
  const {
    OPENAI_API_KEY: openAIApiKey,
    AZURE_ASSISTANTS_API_KEY: azureAssistantsApiKey,
    ASSISTANTS_API_KEY: assistantsApiKey,
    AZURE_API_KEY: azureOpenAIApiKey,
    ANTHROPIC_API_KEY: anthropicApiKey,
    GOOGLE_KEY: googleKey,
    OPENAI_REVERSE_PROXY,
    AZURE_OPENAI_BASEURL,
    ASSISTANTS_BASE_URL,
    AZURE_ASSISTANTS_BASE_URL,
  } = env ?? {};

  const userProvidedOpenAI = isUserProvided(openAIApiKey);
  const anthropicUsesVertex = isEnabled(env?.ANTHROPIC_USE_VERTEX);
  const bedrockUserProvidedCredential = [
    env?.BEDROCK_AWS_BEARER_TOKEN,
    env?.BEDROCK_AWS_ACCESS_KEY_ID,
    env?.BEDROCK_AWS_SECRET_ACCESS_KEY,
    env?.BEDROCK_AWS_SESSION_TOKEN,
  ].find(isUserProvided);

  return {
    googleKey,
    openAIApiKey,
    azureOpenAIApiKey,
    userProvidedOpenAI,
    [EModelEndpoint.anthropic]: generateConfig(anthropicUsesVertex ? 'true' : anthropicApiKey),
    [EModelEndpoint.openAI]: generateConfig(openAIApiKey, OPENAI_REVERSE_PROXY),
    [EModelEndpoint.azureOpenAI]: generateConfig(azureOpenAIApiKey, AZURE_OPENAI_BASEURL),
    [EModelEndpoint.assistants]: generateConfig(
      assistantsApiKey,
      ASSISTANTS_BASE_URL,
      EModelEndpoint.assistants,
    ),
    [EModelEndpoint.azureAssistants]: generateConfig(
      azureAssistantsApiKey,
      AZURE_ASSISTANTS_BASE_URL,
      EModelEndpoint.azureAssistants,
    ),
    [EModelEndpoint.bedrock]: generateConfig(
      bedrockUserProvidedCredential ??
        firstNonEmpty(
          env?.BEDROCK_AWS_BEARER_TOKEN,
          env?.BEDROCK_AWS_SECRET_ACCESS_KEY,
          env?.BEDROCK_AWS_PROFILE,
          env?.BEDROCK_AWS_DEFAULT_REGION,
        ),
    ),
    /* key will be part of separate config */
    [EModelEndpoint.agents]: generateConfig('true', undefined, EModelEndpoint.agents),
  };
}

module.exports = {
  getEndpointEnvironmentConfig,
  get config() {
    return getEndpointEnvironmentConfig();
  },
};
