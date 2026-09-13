export const identityScopes = [
  {
    key: 'openid',
    label: 'OpenID',
    description: 'Returns the authorized user identifier.',
    category: 'identity',
    endpoints: ['/api/oauth/userinfo'],
    identityScope: true,
  },
  {
    key: 'profile',
    label: 'Profile',
    description: 'Returns profile, role, trusted, and account status fields.',
    category: 'identity',
    endpoints: ['/api/oauth/userinfo'],
    identityScope: true,
  },
  {
    key: 'email',
    label: 'Email',
    description: 'Returns the authorized user email address.',
    category: 'identity',
    endpoints: ['/api/oauth/userinfo'],
    identityScope: true,
  },
  {
    key: 'admin:identity',
    label: 'Admin Identity',
    description: 'Returns explicit Synapse admin compatibility fields.',
    category: 'identity',
    endpoints: ['/api/oauth/userinfo', '/api/oauth/introspect'],
    identityScope: true,
  },
] as const;

export const apiScopes = [
  {
    key: 'tts',
    label: 'TTS',
    description: 'TTS generation and job queries.',
    category: 'api',
    endpoints: ['/api/tts/generate', '/api/tts/jobs/*', '/api/tts/history'],
  },
  {
    key: 'status',
    label: 'Status',
    description: 'Authentication and service status checks.',
    category: 'api',
    endpoints: ['/api/status/status'],
  },
  {
    key: 'shorturl',
    label: 'Short URL',
    description: 'Short URL management.',
    category: 'api',
    endpoints: ['/api/shorturl/shorturls', '/api/shorturl/shorturls/*'],
  },
  {
    key: 'media',
    label: 'Media',
    description: 'Media parsing APIs.',
    category: 'api',
    endpoints: ['/api/media/music163', '/api/media/pipixia'],
  },
  {
    key: 'network',
    label: 'Network',
    description: 'Ping, TCPing, speed test, port scan, and IP lookup tools.',
    category: 'api',
    endpoints: ['/api/network/*'],
  },
  {
    key: 'life',
    label: 'Life',
    description: 'Life information APIs.',
    category: 'api',
    endpoints: ['/api/life/*'],
  },
  {
    key: 'social',
    label: 'Social',
    description: 'Social trend APIs.',
    category: 'api',
    endpoints: ['/api/social/*'],
  },
  {
    key: 'ipfs',
    label: 'IPFS',
    description: 'IPFS uploads.',
    category: 'api',
    endpoints: ['/api/ipfs/upload'],
  },
  {
    key: 'data-process',
    label: 'Data Process',
    description: 'Base64, MD5, and other data processing APIs.',
    category: 'api',
    endpoints: ['/api/data/*'],
  },
] as const;

export const oauthScopes: readonly [...typeof identityScopes, ...typeof apiScopes] = [
  ...identityScopes,
  ...apiScopes,
];
export type OAuthScopeKey = (typeof oauthScopes)[number]['key'];

export const defaultOAuthScopes: OAuthScopeKey[] = ['openid', 'profile', 'admin:identity'];

const validScopeKeys = new Set<string>(oauthScopes.map((scope) => scope.key));

export function isValidOAuthScope(scope: string): scope is OAuthScopeKey {
  return validScopeKeys.has(scope);
}

export function getUnknownScopes(scopes: string[]): string[] {
  return scopes.filter((scope) => !isValidOAuthScope(scope));
}
