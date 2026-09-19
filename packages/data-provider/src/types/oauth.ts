export type SynapseOAuthClientType = 'confidential' | 'public';

export type SynapseOAuthScope = {
  key: string;
  label: string;
  description: string;
  category: string;
  endpoints: string[];
  identityScope?: boolean;
};

export type SynapseOAuthClient = {
  clientId: string;
  type: SynapseOAuthClientType;
  name: string;
  description?: string;
  homepageUrl?: string;
  logoUrl?: string;
  redirectUris: string[];
  allowedScopes: string[];
  rateLimitPerMinute: number;
  enabled: boolean;
  hasClientSecret: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type SynapseOAuthClientInput = {
  name?: string;
  type?: SynapseOAuthClientType;
  description?: string;
  homepageUrl?: string;
  logoUrl?: string;
  redirectUris?: string[];
  allowedScopes?: string[];
  rateLimitPerMinute?: number;
  enabled?: boolean;
};

export type SynapseOAuthClientResponse = {
  success: boolean;
  client: SynapseOAuthClient;
  clientSecret?: string;
  message?: string;
};

export type SynapseOAuthClientsResponse = {
  success: boolean;
  clients: SynapseOAuthClient[];
};

export type SynapseOAuthScopesResponse = {
  scopes: SynapseOAuthScope[];
};

export type SynapseOAuthGrant = {
  grantId: string;
  clientId: string;
  clientName?: string;
  userId: string;
  username?: string;
  email?: string;
  scopes: string[];
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SynapseOAuthGrantsResponse = {
  success: boolean;
  grants: SynapseOAuthGrant[];
};

export type SynapseOAuthMutationResponse = {
  success: boolean;
};

/** One scope as the consent screen describes it, rather than as the token carries it. */
export type SynapseOAuthAuthorizationScope = {
  key: string;
  label: string;
  description: string;
};

/** The query `GET /oauth/authorize` documents, as the consent screen sends it back. */
export type SynapseOAuthAuthorizeParams = {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
};

export type SynapseOAuthAuthorizationGranted = {
  success: true;
  clientId: string;
  name: string;
  description?: string;
  logoUrl?: string;
  homepageUrl?: string;
  redirectUri: string;
  scopes: SynapseOAuthAuthorizationScope[];
  username: string;
  nonce: string;
};

/** The signed-in user has no session yet; `loginUrl` carries them back here afterwards. */
export type SynapseOAuthAuthorizationLoginRequired = {
  success: false;
  error: 'login_required';
  loginUrl: string;
};

/** The user cannot grant, so there is nothing to consent to — only a redirect to follow. */
export type SynapseOAuthAuthorizationDenied = {
  success: false;
  error: 'access_denied';
  message: string;
  redirect: string;
};

export type SynapseOAuthAuthorizationContext =
  | SynapseOAuthAuthorizationGranted
  | SynapseOAuthAuthorizationLoginRequired
  | SynapseOAuthAuthorizationDenied;

export type SynapseOAuthAuthorizationDecision =
  | { success: true; redirect: string }
  | { success: false; error: 'login_required'; loginUrl: string };

export type SynapseOAuthAuthorizationDecisionRequest = {
  nonce: string;
  decision: 'approve' | 'deny';
};
