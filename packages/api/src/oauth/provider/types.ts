import type {
  IOAuthAuthorizationCode,
  IOAuthClient,
  IOAuthGrant,
  IOAuthToken,
  IUser,
  OAuthClientType,
} from '@librechat/data-schemas';
import type { Model, Types } from 'mongoose';

export interface OAuthModels {
  OAuthAuthorizationCode: Model<IOAuthAuthorizationCode>;
  OAuthClient: Model<IOAuthClient>;
  OAuthGrant: Model<IOAuthGrant>;
  OAuthToken: Model<IOAuthToken>;
  User: Model<IUser>;
}

export interface OAuthClientInput {
  name?: string;
  type?: OAuthClientType;
  description?: string;
  homepageUrl?: string;
  logoUrl?: string;
  redirectUris?: string[];
  allowedScopes?: string[];
  rateLimitPerMinute?: number;
  enabled?: boolean;
}

export interface OAuthAuthenticatedClient {
  client: IOAuthClient;
  clientId: string;
}

export interface OAuthAccessContext {
  client: IOAuthClient;
  grant: IOAuthGrant;
  token: IOAuthToken;
  user: IUser;
}

export interface OAuthUserInfo {
  sub?: string;
  id?: string;
  username?: string;
  name?: string;
  avatarUrl?: string;
  avatar_url?: string;
  role?: string;
  roles?: string[];
  isAdmin?: boolean;
  is_admin?: boolean;
  admin?: boolean;
  synapseAdmin?: boolean;
  synapse_admin?: boolean;
  isTrusted?: boolean;
  is_trusted?: boolean;
  authProvider?: string;
  createdAt?: string;
  created_at?: string;
  accountStatus?: string;
  account_status?: string;
  email?: string;
  emailVerified?: boolean;
  email_verified?: boolean;
}

export interface OAuthGrantListItem {
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
}

/** One scope as the consent screen describes it, rather than as the token carries it. */
export interface OAuthAuthorizationScope {
  key: string;
  label: string;
  description: string;
}

/** Everything a consent screen renders, resolved server-side so the client holds no
 *  authorization state of its own beyond the single-use `nonce`. */
export interface OAuthAuthorizationContext {
  clientId: string;
  name: string;
  description?: string;
  logoUrl?: string;
  homepageUrl?: string;
  redirectUri: string;
  scopes: OAuthAuthorizationScope[];
  username: string;
  nonce: string;
}

/** The three ways resolving an authorization request can end. `login_required` and
 *  `access_denied` are not OAuth errors: the first has no redirect target yet, and the
 *  second is decided before the request is validated into a consent. */
export type OAuthAuthorizationOutcome =
  | { kind: 'ok'; draft: OAuthConsentDraft }
  | { kind: 'login_required'; loginUrl: string }
  | { kind: 'access_denied'; message: string; redirect: string };

/** A validated authorization request, before the single-use nonce is minted. */
export interface OAuthConsentDraft {
  client: IOAuthClient;
  scopes: string[];
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  user: IUser;
}

/** The three ways spending a consent nonce can end. */
export type OAuthConsentOutcome =
  | { kind: 'ok'; redirect: string }
  | { kind: 'login_required'; loginUrl: string }
  | { kind: 'invalid' };

export interface OAuthClientResponse {
  clientId: string;
  type: OAuthClientType;
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
}

export interface TokenIssueResult {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface TokenExchangeResult extends TokenIssueResult {
  scopes: string[];
  user: IUser;
}

export interface OAuthProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  introspection_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  scopes_supported: string[];
}

export type OAuthIntrospectionResult =
  | { active: false }
  | {
      active: true;
      client_id: string;
      sub: string;
      username: string | undefined;
      scope: string;
      exp: number;
      token_type: string;
      role: string | undefined;
      roles: string[] | undefined;
      isAdmin: boolean | undefined;
      is_admin: boolean | undefined;
      admin: boolean | undefined;
      synapseAdmin: boolean | undefined;
      synapse_admin: boolean | undefined;
      isTrusted: boolean | undefined;
      is_trusted: boolean | undefined;
    };

export type ObjectIdLike = Types.ObjectId | string;
