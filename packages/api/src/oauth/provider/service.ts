import { hashToken } from '@librechat/data-schemas';
import { SystemRoles } from 'librechat-data-provider';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type {
  IOAuthAuthorizationCode,
  IOAuthClient,
  IOAuthGrant,
  IOAuthToken,
  IUser,
  OAuthCodeChallengeMethod,
} from '@librechat/data-schemas';
import type {
  OAuthAccessContext,
  OAuthClientInput,
  OAuthClientResponse,
  OAuthIntrospectionResult,
  OAuthModels,
  OAuthProviderMetadata,
  OAuthUserInfo,
  TokenExchangeResult,
} from './types';
import { defaultOAuthScopes, getUnknownScopes, oauthScopes } from './scopes';
import { OAuthProviderError, oauthError } from './errors';

const ACCESS_TOKEN_EXPIRES_IN = 2 * 60 * 60;
const REFRESH_TOKEN_EXPIRES_IN = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_EXPIRES_IN = 10 * 60;
const DEFAULT_RATE_LIMIT = 60;
const MAX_RATE_LIMIT = 10_000;

function now(): Date {
  return new Date();
}

function toDateSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

export function randomOAuthToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function normalizeScopes(input?: string | string[] | null): string[] {
  const raw = Array.isArray(input) ? input.join(' ') : input;
  const scopes = raw?.trim() ? raw.trim().split(/\s+/) : defaultOAuthScopes;
  return [...new Set(scopes.filter(Boolean))];
}

export function serializeClient(client: IOAuthClient): OAuthClientResponse {
  return {
    clientId: client.clientId,
    type: client.type,
    name: client.name,
    description: client.description,
    homepageUrl: client.homepageUrl,
    logoUrl: client.logoUrl,
    redirectUris: client.redirectUris,
    allowedScopes: client.allowedScopes,
    rateLimitPerMinute: client.rateLimitPerMinute,
    enabled: client.enabled,
    hasClientSecret: Boolean(client.secretHash),
    createdAt: client.createdAt?.toISOString(),
    updatedAt: client.updatedAt?.toISOString(),
  };
}

function normalizeRole(role?: string): string {
  return role?.toLowerCase() ?? '';
}

export function isGrantingUser(user: IUser | null | undefined): boolean {
  const role = normalizeRole(user?.role);
  return role === SystemRoles.ADMIN.toLowerCase() || role === 'admin' || role === 'trusted';
}

export function isAdminUser(user: IUser | null | undefined): boolean {
  const role = normalizeRole(user?.role);
  return role === SystemRoles.ADMIN.toLowerCase() || role === 'admin';
}

export function isTrustedUser(user: IUser | null | undefined): boolean {
  return normalizeRole(user?.role) === 'trusted';
}

export function getUserId(user: IUser): string {
  return user.id || user._id.toString();
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim());
}

function isLocalHttpRedirect(url: URL): boolean {
  if (url.protocol !== 'http:') {
    return false;
  }
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]'
  );
}

function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    oauthError('invalid_client_metadata', `Invalid redirect URI: ${uri}`);
  }

  if (parsed.protocol === 'https:' || isLocalHttpRedirect(parsed)) {
    return;
  }

  oauthError('invalid_client_metadata', `Redirect URI must use HTTPS: ${uri}`);
}

function validateHttpsMetadataUrl(name: string, value?: string): void {
  if (!value) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    oauthError('invalid_client_metadata', `${name} is not a valid URL`);
  }

  if (parsed.protocol !== 'https:') {
    oauthError('invalid_client_metadata', `${name} must use HTTPS`);
  }
}

function validateScopeList(scopes: string[]): void {
  const unknown = getUnknownScopes(scopes);
  if (unknown.length > 0) {
    oauthError('invalid_scope', `Unknown scope: ${unknown.join(', ')}`);
  }
  if (scopes.includes('*')) {
    oauthError('invalid_scope', 'Wildcard scope is not allowed for OAuth clients');
  }
}

function validateRequestedScopes(client: IOAuthClient, requestedScopes: string[]): void {
  validateScopeList(requestedScopes);
  const allowed = new Set(client.allowedScopes);
  const denied = requestedScopes.filter((scope) => !allowed.has(scope));
  if (denied.length > 0) {
    oauthError('invalid_scope', `Client has not enabled scope: ${denied.join(', ')}`);
  }
}

function validatePkce(
  client: IOAuthClient,
  codeChallenge?: string,
  codeChallengeMethod?: string,
): void {
  if (!codeChallenge && client.type === 'public') {
    oauthError('invalid_request', 'Public OAuth clients must use PKCE');
  }
  if (!codeChallenge && !codeChallengeMethod) {
    return;
  }
  if (!codeChallenge || !codeChallengeMethod) {
    oauthError('invalid_request', 'PKCE challenge and method must be provided together');
  }
  if (codeChallengeMethod !== 'S256' && codeChallengeMethod !== 'plain') {
    oauthError('invalid_request', 'Unsupported PKCE code_challenge_method');
  }
}

function buildClientInput(input: OAuthClientInput, partial: boolean): Required<OAuthClientInput> {
  const type = input.type ?? 'confidential';
  const name = parseOptionalString(input.name);
  const redirectUris = parseStringArray(input.redirectUris);
  const allowedScopes = input.allowedScopes
    ? normalizeScopes(input.allowedScopes)
    : defaultOAuthScopes;
  const rateLimitPerMinute = Number(input.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT);

  if (!partial && !name) {
    oauthError('invalid_client_metadata', 'Client name is required');
  }
  if (type !== 'confidential' && type !== 'public') {
    oauthError('invalid_client_metadata', 'Client type must be confidential or public');
  }
  if (!partial && redirectUris.length === 0) {
    oauthError('invalid_client_metadata', 'At least one redirect URI is required');
  }
  redirectUris.forEach(validateRedirectUri);
  validateHttpsMetadataUrl('homepageUrl', input.homepageUrl);
  validateHttpsMetadataUrl('logoUrl', input.logoUrl);
  validateScopeList(allowedScopes);
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) {
    oauthError('invalid_client_metadata', 'rateLimitPerMinute must be a positive integer');
  }
  if (rateLimitPerMinute > MAX_RATE_LIMIT) {
    oauthError('invalid_client_metadata', `rateLimitPerMinute must be ${MAX_RATE_LIMIT} or lower`);
  }

  return {
    name: name ?? '',
    type,
    description: parseOptionalString(input.description) ?? '',
    homepageUrl: parseOptionalString(input.homepageUrl) ?? '',
    logoUrl: parseOptionalString(input.logoUrl) ?? '',
    redirectUris,
    allowedScopes,
    rateLimitPerMinute,
    enabled: input.enabled ?? true,
  };
}

async function hashSecret(secret: string): Promise<string> {
  return hashToken(secret);
}

async function compareHash(raw: string, expectedHash?: string): Promise<boolean> {
  if (!expectedHash) {
    return false;
  }
  const actualHash = await hashSecret(raw);
  const actual = Buffer.from(actualHash);
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function findClient(models: OAuthModels, clientId: string): Promise<IOAuthClient> {
  const client = await models.OAuthClient.findOne({ clientId }).exec();
  if (!client || !client.enabled) {
    oauthError('invalid_client', 'OAuth client not found or disabled', 401);
  }
  return client;
}

async function findClientForAdmin(models: OAuthModels, clientId: string): Promise<IOAuthClient> {
  const client = await models.OAuthClient.findOne({ clientId }).exec();
  if (!client) {
    oauthError('invalid_client', 'OAuth client not found', 404);
  }
  return client;
}

export async function createClient(
  models: OAuthModels,
  input: OAuthClientInput,
  createdBy?: string,
): Promise<{ client: OAuthClientResponse; clientSecret?: string }> {
  const data = buildClientInput(input, false);
  const clientId = randomOAuthToken('syn_client');
  const clientSecret = data.type === 'confidential' ? randomOAuthToken('syn_secret') : undefined;
  const secretHash = clientSecret ? await hashSecret(clientSecret) : undefined;

  const client = await models.OAuthClient.create({
    clientId,
    type: data.type,
    name: data.name,
    description: data.description,
    homepageUrl: data.homepageUrl,
    logoUrl: data.logoUrl,
    redirectUris: data.redirectUris,
    allowedScopes: data.allowedScopes,
    rateLimitPerMinute: data.rateLimitPerMinute,
    enabled: data.enabled,
    secretHash,
    createdBy,
  });

  return {
    client: serializeClient(client),
    clientSecret,
  };
}

export async function updateClient(
  models: OAuthModels,
  clientId: string,
  input: OAuthClientInput,
): Promise<OAuthClientResponse> {
  const existing = await findClientForAdmin(models, clientId);
  const data = buildClientInput({ ...serializeClient(existing), ...input }, true);
  const nextEnabled = input.enabled ?? existing.enabled;
  const secretHash = data.type === 'public' ? undefined : existing.secretHash;

  existing.set({
    type: data.type,
    name: data.name || existing.name,
    description: data.description,
    homepageUrl: data.homepageUrl,
    logoUrl: data.logoUrl,
    redirectUris: data.redirectUris.length > 0 ? data.redirectUris : existing.redirectUris,
    allowedScopes: data.allowedScopes,
    rateLimitPerMinute: data.rateLimitPerMinute,
    enabled: nextEnabled,
    secretHash,
  });

  await existing.save();

  if (existing.enabled === false) {
    await revokeClientGrants(models, clientId);
  }

  return serializeClient(existing);
}

export async function listClients(models: OAuthModels): Promise<OAuthClientResponse[]> {
  const clients = await models.OAuthClient.find({}).sort({ createdAt: -1 }).exec();
  return clients.map(serializeClient);
}

export async function getClient(
  models: OAuthModels,
  clientId: string,
): Promise<OAuthClientResponse> {
  const client = await findClientForAdmin(models, clientId);
  return serializeClient(client);
}

export async function rotateClientSecret(
  models: OAuthModels,
  clientId: string,
): Promise<{ client: OAuthClientResponse; clientSecret: string }> {
  const client = await findClientForAdmin(models, clientId);
  if (client.type !== 'confidential') {
    oauthError('invalid_client_metadata', 'Only confidential clients have a secret');
  }
  const clientSecret = randomOAuthToken('syn_secret');
  client.secretHash = await hashSecret(clientSecret);
  await client.save();
  await revokeClientGrants(models, clientId);
  return {
    client: serializeClient(client),
    clientSecret,
  };
}

export async function deleteClient(models: OAuthModels, clientId: string): Promise<void> {
  await revokeClientGrants(models, clientId);
  await models.OAuthClient.deleteOne({ clientId }).exec();
}

export async function revokeClientGrants(models: OAuthModels, clientId: string): Promise<void> {
  await Promise.all([
    models.OAuthGrant.updateMany({ clientId, revokedAt: null }, { revokedAt: now() }).exec(),
    models.OAuthToken.updateMany({ clientId, revokedAt: null }, { revokedAt: now() }).exec(),
  ]);
}

export async function authenticateClient(
  models: OAuthModels,
  clientId?: string,
  clientSecret?: string,
): Promise<IOAuthClient> {
  if (!clientId) {
    oauthError('invalid_client', 'OAuth client authentication is required', 401);
  }

  const client = await findClient(models, clientId);

  if (client.type === 'public') {
    return client;
  }

  if (!clientSecret || !(await compareHash(clientSecret, client.secretHash))) {
    oauthError('invalid_client', 'Invalid OAuth client secret', 401);
  }

  return client;
}

export async function prepareAuthorization(
  models: OAuthModels,
  params: {
    responseType?: string;
    clientId?: string;
    redirectUri?: string;
    scope?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  },
): Promise<{ client: IOAuthClient; scopes: string[] }> {
  if (params.responseType !== 'code') {
    oauthError('unsupported_response_type', 'Only authorization code flow is supported');
  }
  if (!params.clientId || !params.redirectUri) {
    oauthError('invalid_request', 'client_id and redirect_uri are required');
  }

  const client = await findClient(models, params.clientId);
  if (!client.redirectUris.includes(params.redirectUri)) {
    oauthError('invalid_request', 'redirect_uri does not match the OAuth client');
  }

  const scopes = normalizeScopes(params.scope);
  validateRequestedScopes(client, scopes);
  validatePkce(client, params.codeChallenge, params.codeChallengeMethod);

  return { client, scopes };
}

export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function upsertGrant(
  models: OAuthModels,
  clientId: string,
  userId: string,
  scopes: string[],
): Promise<IOAuthGrant> {
  const activeGrant = await models.OAuthGrant.findOne({
    clientId,
    userId,
    revokedAt: null,
  }).exec();

  if (!activeGrant) {
    return models.OAuthGrant.create({ clientId, userId, scopes });
  }

  activeGrant.scopes = scopes;
  await activeGrant.save();
  return activeGrant;
}

export async function createAuthorizationCode(
  models: OAuthModels,
  params: {
    clientId: string;
    user: IUser;
    redirectUri: string;
    scopes: string[];
    codeChallenge?: string;
    codeChallengeMethod?: OAuthCodeChallengeMethod;
  },
): Promise<string> {
  if (!isGrantingUser(params.user)) {
    oauthError('access_denied', 'Authorization user must be admin or trusted', 403);
  }

  const code = randomOAuthToken('syn_oac');
  const grant = await upsertGrant(models, params.clientId, getUserId(params.user), params.scopes);

  await models.OAuthAuthorizationCode.create({
    codeHash: await hashToken(code),
    clientId: params.clientId,
    userId: params.user._id,
    grantId: grant._id,
    redirectUri: params.redirectUri,
    scopes: params.scopes,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    expiresAt: toDateSeconds(AUTHORIZATION_CODE_EXPIRES_IN),
  });

  return code;
}

function verifyCodeChallenge(
  authorizationCode: IOAuthAuthorizationCode,
  codeVerifier?: string,
): void {
  if (!authorizationCode.codeChallenge) {
    return;
  }
  if (!codeVerifier) {
    oauthError('invalid_grant', 'code_verifier is required');
  }

  const expected =
    authorizationCode.codeChallengeMethod === 'S256'
      ? createHash('sha256').update(codeVerifier).digest('base64url')
      : codeVerifier;

  if (expected !== authorizationCode.codeChallenge) {
    oauthError('invalid_grant', 'Invalid code_verifier');
  }
}

async function assertGrantActive(models: OAuthModels, grantId: string): Promise<IOAuthGrant> {
  const grant = await models.OAuthGrant.findById(grantId).exec();
  if (!grant || grant.revokedAt) {
    oauthError('invalid_grant', 'OAuth grant is no longer active');
  }
  return grant;
}

async function assertEligibleUser(models: OAuthModels, userId: string): Promise<IUser> {
  const user = await models.User.findById(userId).exec();
  if (!user || !isGrantingUser(user)) {
    oauthError('access_denied', 'Authorization user is no longer admin or trusted', 403);
  }
  return user;
}

async function issueTokens(
  models: OAuthModels,
  params: {
    clientId: string;
    userId: string;
    grantId: string;
    scopes: string[];
  },
) {
  const accessToken = randomOAuthToken('syn_oat');
  const refreshToken = randomOAuthToken('syn_ort');
  const [accessHash, refreshHash] = await Promise.all([
    hashToken(accessToken),
    hashToken(refreshToken),
  ]);

  await models.OAuthToken.create([
    {
      tokenHash: accessHash,
      kind: 'access',
      clientId: params.clientId,
      userId: params.userId,
      grantId: params.grantId,
      scopes: params.scopes,
      expiresAt: toDateSeconds(ACCESS_TOKEN_EXPIRES_IN),
    },
    {
      tokenHash: refreshHash,
      kind: 'refresh',
      clientId: params.clientId,
      userId: params.userId,
      grantId: params.grantId,
      scopes: params.scopes,
      expiresAt: toDateSeconds(REFRESH_TOKEN_EXPIRES_IN),
    },
  ]);

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
    refreshTokenExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
  };
}

export async function exchangeAuthorizationCode(
  models: OAuthModels,
  params: {
    client: IOAuthClient;
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
  },
): Promise<TokenExchangeResult> {
  if (!params.code || !params.redirectUri) {
    oauthError('invalid_request', 'code and redirect_uri are required');
  }

  const authorizationCode = await models.OAuthAuthorizationCode.findOne({
    codeHash: await hashToken(params.code),
  }).exec();

  if (!authorizationCode || authorizationCode.usedAt || authorizationCode.expiresAt <= now()) {
    oauthError('invalid_grant', 'Authorization code is invalid or expired');
  }
  if (authorizationCode.clientId !== params.client.clientId) {
    oauthError('invalid_grant', 'Authorization code client does not match');
  }
  if (authorizationCode.redirectUri !== params.redirectUri) {
    oauthError('invalid_grant', 'redirect_uri does not match authorization request');
  }

  verifyCodeChallenge(authorizationCode, params.codeVerifier);
  const grant = await assertGrantActive(models, authorizationCode.grantId.toString());
  const user = await assertEligibleUser(models, authorizationCode.userId.toString());

  authorizationCode.usedAt = now();
  await authorizationCode.save();

  const tokens = await issueTokens(models, {
    clientId: params.client.clientId,
    userId: authorizationCode.userId.toString(),
    grantId: grant._id.toString(),
    scopes: authorizationCode.scopes,
  });

  return {
    ...tokens,
    scopes: authorizationCode.scopes,
    user,
  };
}

export async function refreshOAuthAccessToken(
  models: OAuthModels,
  params: {
    client: IOAuthClient;
    refreshToken?: string;
  },
): Promise<TokenExchangeResult> {
  if (!params.refreshToken) {
    oauthError('invalid_request', 'refresh_token is required');
  }

  const token = await models.OAuthToken.findOne({
    tokenHash: await hashToken(params.refreshToken),
    kind: 'refresh',
  }).exec();

  if (!token || token.revokedAt || token.expiresAt <= now()) {
    oauthError('invalid_grant', 'Refresh token is invalid or expired');
  }
  if (token.clientId !== params.client.clientId) {
    oauthError('invalid_grant', 'Refresh token client does not match');
  }

  const grant = await assertGrantActive(models, token.grantId.toString());
  const user = await assertEligibleUser(models, token.userId.toString());
  const revokedAt = now();

  await models.OAuthToken.updateMany(
    { clientId: token.clientId, grantId: token.grantId, revokedAt: null },
    { revokedAt },
  ).exec();

  const tokens = await issueTokens(models, {
    clientId: token.clientId,
    userId: token.userId.toString(),
    grantId: grant._id.toString(),
    scopes: token.scopes,
  });

  return {
    ...tokens,
    scopes: token.scopes,
    user,
  };
}

export async function validateAccessToken(
  models: OAuthModels,
  tokenValue?: string,
  requiredScope?: string,
): Promise<OAuthAccessContext> {
  if (!tokenValue) {
    oauthError('invalid_token', 'Bearer access token is required', 401);
  }

  const token = await models.OAuthToken.findOne({
    tokenHash: await hashToken(tokenValue),
    kind: 'access',
  }).exec();

  if (!token || token.revokedAt || token.expiresAt <= now()) {
    oauthError('invalid_token', 'Access token is invalid or expired', 401);
  }

  const [client, grant, user] = await Promise.all([
    findClient(models, token.clientId),
    assertGrantActive(models, token.grantId.toString()),
    assertEligibleUser(models, token.userId.toString()),
  ]);

  if (requiredScope && !token.scopes.includes(requiredScope)) {
    throw new OAuthProviderError(
      'insufficient_scope',
      `Missing required scope: ${requiredScope}`,
      403,
    );
  }

  return { client, grant, token, user };
}

export async function introspectToken(
  models: OAuthModels,
  params: {
    client: IOAuthClient;
    token?: string;
  },
): Promise<OAuthIntrospectionResult> {
  if (!params.token) {
    oauthError('invalid_request', 'token is required');
  }

  const token = await models.OAuthToken.findOne({
    tokenHash: await hashToken(params.token),
  }).exec();
  if (
    !token ||
    token.clientId !== params.client.clientId ||
    token.revokedAt ||
    token.expiresAt <= now()
  ) {
    return { active: false as const };
  }

  try {
    await assertGrantActive(models, token.grantId.toString());
    const user = await assertEligibleUser(models, token.userId.toString());
    const userInfo = buildUserInfo(user, token.scopes);
    return {
      active: true as const,
      client_id: token.clientId,
      sub: getUserId(user),
      username: userInfo.username,
      scope: token.scopes.join(' '),
      exp: Math.floor(token.expiresAt.getTime() / 1000),
      token_type: token.kind === 'access' ? 'Bearer' : token.kind,
      role: userInfo.role,
      roles: userInfo.roles,
      isAdmin: userInfo.isAdmin,
      is_admin: userInfo.is_admin,
      admin: userInfo.admin,
      synapseAdmin: userInfo.synapseAdmin,
      synapse_admin: userInfo.synapse_admin,
      isTrusted: userInfo.isTrusted,
      is_trusted: userInfo.is_trusted,
    };
  } catch (error) {
    if (error instanceof OAuthProviderError) {
      return { active: false as const };
    }
    throw error;
  }
}

export async function revokeToken(
  models: OAuthModels,
  params: {
    client: IOAuthClient;
    token?: string;
  },
): Promise<void> {
  if (!params.token) {
    return;
  }
  await models.OAuthToken.updateOne(
    {
      tokenHash: await hashToken(params.token),
      clientId: params.client.clientId,
      revokedAt: null,
    },
    { revokedAt: now() },
  ).exec();
}

export async function listGrants(models: OAuthModels): Promise<IOAuthGrant[]> {
  return models.OAuthGrant.find({}).sort({ createdAt: -1 }).exec();
}

export async function revokeGrant(models: OAuthModels, grantId: string): Promise<void> {
  const revokedAt = now();
  await Promise.all([
    models.OAuthGrant.updateOne({ _id: grantId, revokedAt: null }, { revokedAt }).exec(),
    models.OAuthToken.updateMany({ grantId, revokedAt: null }, { revokedAt }).exec(),
  ]);
}

export async function getAuthorizationCode(
  models: OAuthModels,
  code: string,
): Promise<IOAuthAuthorizationCode | null> {
  return models.OAuthAuthorizationCode.findOne({ codeHash: await hashToken(code) }).exec();
}

export function buildUserInfo(user: IUser, scopes: string[]): OAuthUserInfo {
  const id = getUserId(user);
  const role = normalizeRole(user.role) || 'user';
  const isAdmin = isAdminUser(user);
  const isTrusted = isTrustedUser(user);
  const response: OAuthUserInfo = {};
  const granted = new Set(scopes);

  if (granted.has('openid')) {
    response.sub = id;
    response.id = id;
  }

  if (granted.has('profile') || granted.has('admin:identity')) {
    response.username = user.username || user.name || user.email;
    response.name = user.name || user.username || user.email;
    response.avatarUrl = user.avatar;
    response.avatar_url = user.avatar;
    response.role = role;
    response.roles = [role];
    response.isTrusted = isTrusted;
    response.is_trusted = isTrusted;
    response.authProvider = user.provider;
    response.createdAt = user.createdAt?.toISOString();
    response.created_at = response.createdAt;
    response.accountStatus = 'active';
    response.account_status = 'active';
  }

  if (granted.has('admin:identity') || granted.has('profile')) {
    response.isAdmin = isAdmin;
    response.is_admin = isAdmin;
    response.admin = isAdmin;
    response.synapseAdmin = isAdmin;
    response.synapse_admin = isAdmin;
  }

  if (granted.has('email')) {
    response.email = user.email;
    response.emailVerified = user.emailVerified;
    response.email_verified = user.emailVerified;
  }

  return response;
}

export function buildMetadata(issuer: string): OAuthProviderMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    userinfo_endpoint: `${issuer}/api/oauth/userinfo`,
    introspection_endpoint: `${issuer}/api/oauth/introspect`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: oauthScopes.map((scope) => scope.key),
  };
}
