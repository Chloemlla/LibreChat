import { resolveConfigEnvPath } from './environment';

describe('resolveConfigEnvPath', () => {
  it.each<[string, string[]]>([
    ['CACHE', ['cache']],
    ['INTERFACE_CUSTOMWELCOME', ['interface', 'customWelcome']],
    ['INTERFACE_FILESEARCH', ['interface', 'fileSearch']],
    ['TURNSTILE_SITEKEY', ['turnstile', 'siteKey']],
    ['TURNSTILE_OPTIONS_THEME', ['turnstile', 'options', 'theme']],
    ['ENDPOINTS_AGENTS_MAXSUBAGENTS', ['endpoints', 'agents', 'maxSubagents']],
  ])('preserves the schema spelling of %s', (input, expected) => {
    expect(resolveConfigEnvPath(input)).toEqual(expected);
  });

  it.each([
    'CODE_API_KEY',
    'CODE_BASEURL_STATEFUL',
    'CODE_SANDBOX_OUTPUT_MAX_SIZE',
    'GRAPH_ACCESS_TOKEN',
    'INTERFACE_UNKNOWN',
    'CACHE_VALUE',
    'CONSTRUCTOR_PROTOTYPE',
    '__PROTO___POLLUTED',
    '',
  ])('ignores runtime settings and invalid paths: %s', (input) => {
    expect(resolveConfigEnvPath(input)).toBeUndefined();
  });
});
