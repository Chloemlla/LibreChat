import type { Request, RequestHandler, Response } from 'express';
import type { IUser } from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import type {
  OAuthAccessContext,
  OAuthAuthorizationContext,
  OAuthAuthorizationOutcome,
  OAuthAuthorizationScope,
  OAuthClientInput,
  OAuthConsentOutcome,
  OAuthModels,
} from './types';
import {
  authenticateClient,
  buildMetadata,
  buildRedirect,
  buildUserInfo,
  createAuthorizationCode,
  createClient as createOAuthClient,
  deleteClient as deleteOAuthClient,
  exchangeAuthorizationCode,
  getClient as getOAuthClient,
  getUserId,
  introspectToken,
  isGrantingUser,
  listClients as listOAuthClients,
  listGrants as listOAuthGrants,
  prepareAuthorization,
  refreshOAuthAccessToken,
  revokeGrant as revokeOAuthGrant,
  revokeToken,
  rotateClientSecret,
  updateClient as updateOAuthClient,
  validateAccessToken,
} from './service';
import { consumeConsentRequest, createConsentRequest } from './state';
import { OAuthProviderError } from './errors';
import { oauthScopes } from './scopes';

interface OAuthRequest extends Request {
  oauth?: OAuthAccessContext;
  user?: IUser & { id?: string };
}

export interface OAuthProviderHandlerOptions {
  getIssuer?: (req: Request) => string;
  getLoginRedirect?: (req: Request) => string;
}

export interface OAuthProviderHandlers {
  metadata: RequestHandler;
  scopes: RequestHandler;
  authorizePage: RequestHandler;
  authorizeContext: RequestHandler;
  authorizeDecision: RequestHandler;
  authorizeDecisionJson: RequestHandler;
  token: RequestHandler;
  userinfo: RequestHandler;
  introspect: RequestHandler;
  revoke: RequestHandler;
  listClients: RequestHandler;
  createClient: RequestHandler;
  getClient: RequestHandler;
  updateClient: RequestHandler;
  rotateClientSecret: RequestHandler;
  deleteClient: RequestHandler;
  listGrants: RequestHandler;
  revokeGrant: RequestHandler;
}

function getModels(mongoose: typeof import('mongoose')): OAuthModels {
  return {
    OAuthAuthorizationCode: mongoose.models
      .OAuthAuthorizationCode as OAuthModels['OAuthAuthorizationCode'],
    OAuthClient: mongoose.models.OAuthClient as OAuthModels['OAuthClient'],
    OAuthGrant: mongoose.models.OAuthGrant as OAuthModels['OAuthGrant'],
    OAuthToken: mongoose.models.OAuthToken as OAuthModels['OAuthToken'],
    User: mongoose.models.User as Model<IUser>,
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function defaultIssuer(req: Request): string {
  const configured =
    process.env.BASE_URL ||
    process.env.FRONTEND_URL ||
    process.env.DOMAIN_SERVER ||
    process.env.DOMAIN_CLIENT;

  if (configured) {
    return stripTrailingSlash(configured);
  }

  return `${req.protocol}://${req.get('host')}`;
}

function defaultLoginRedirect(req: Request): string {
  const client = stripTrailingSlash(
    process.env.FRONTEND_URL || process.env.DOMAIN_CLIENT || process.env.BASE_URL || '',
  );
  const path = `/login?redirect_to=${encodeURIComponent(req.originalUrl)}`;
  return client ? `${client}${path}` : path;
}

function readString(source: Request['body'] | Request['query'], key: string): string | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(source: Request['body'], key: string): boolean | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function readStringArray(source: Request['body'], key: string): string[] | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
}

function readNumber(source: Request['body'], key: string): number | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readClientInput(req: Request): OAuthClientInput {
  return {
    name: readString(req.body, 'name'),
    type: readString(req.body, 'type') as OAuthClientInput['type'],
    description: readString(req.body, 'description'),
    homepageUrl: readString(req.body, 'homepageUrl'),
    logoUrl: readString(req.body, 'logoUrl'),
    redirectUris: readStringArray(req.body, 'redirectUris'),
    allowedScopes: readStringArray(req.body, 'allowedScopes'),
    rateLimitPerMinute: readNumber(req.body, 'rateLimitPerMinute'),
    enabled: readBoolean(req.body, 'enabled'),
  };
}

function parseBasicAuth(header?: string): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith('Basic ')) {
    return null;
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) {
    return null;
  }

  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
}

function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

function sendOAuthError(res: Response, error: unknown): void {
  if (error instanceof OAuthProviderError) {
    if (error.code === 'insufficient_scope') {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer error="${error.code}", error_description="${error.message}"`,
      );
    }
    res.status(error.status).json({
      error: error.code,
      error_description: error.message,
    });
    return;
  }

  res.status(500).json({
    error: 'server_error',
    error_description: 'Internal server error',
  });
}

function escapeHtml(value: string | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAuthorizationPage(params: {
  clientName: string;
  description?: string;
  logoUrl?: string;
  redirectUri: string;
  scopes: string[];
  username: string;
  nonce: string;
}): string {
  const scopeItems = params.scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join('');
  const logo = params.logoUrl
    ? `<img src="${escapeHtml(params.logoUrl)}" alt="" style="height:48px;width:48px;border-radius:8px;object-fit:cover" />`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Synapse OAuth Authorization</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f7f7f8; color: #111827; }
    main { max-width: 640px; margin: 48px auto; padding: 24px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; }
    header { display: flex; gap: 16px; align-items: center; }
    h1 { font-size: 22px; margin: 0; }
    p, li { color: #374151; line-height: 1.5; }
    code { background: #f3f4f6; padding: 2px 4px; border-radius: 4px; }
    form { display: flex; gap: 12px; margin-top: 24px; }
    button { border: 0; border-radius: 6px; padding: 10px 16px; font-weight: 600; cursor: pointer; }
    button[name="decision"][value="approve"] { background: #0f766e; color: #fff; }
    button[name="decision"][value="deny"] { background: #e5e7eb; color: #111827; }
  </style>
</head>
<body>
  <main>
    <header>
      ${logo}
      <div>
        <h1>${escapeHtml(params.clientName)}</h1>
        <p>${escapeHtml(params.description || 'This application is requesting Synapse access.')}</p>
      </div>
    </header>
    <p>Signed in as <strong>${escapeHtml(params.username)}</strong>.</p>
    <p>Redirect URI: <code>${escapeHtml(params.redirectUri)}</code></p>
    <p>Requested scopes:</p>
    <ul>${scopeItems}</ul>
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="nonce" value="${escapeHtml(params.nonce)}" />
      <button type="submit" name="decision" value="approve">Authorize</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </main>
</body>
</html>`;
}

/**
 * Names each granted scope for a consent screen. An unknown key still gets an entry
 * rather than being dropped: the scope already cleared the client's allow-list, so
 * omitting it would understate what the authorization actually carries.
 */
function describeScopes(scopes: string[]): OAuthAuthorizationScope[] {
  return scopes.map((scope) => {
    const known = oauthScopes.find((entry) => entry.key === scope);
    return known
      ? { key: known.key, label: known.label, description: known.description }
      : { key: scope, label: scope, description: '' };
  });
}

function withErrors(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((error) => sendOAuthError(res, error));
  };
}

async function getAuthenticatedClient(models: OAuthModels, req: Request) {
  const basic = parseBasicAuth(req.headers.authorization);
  return authenticateClient(
    models,
    basic?.clientId ?? readString(req.body, 'client_id'),
    basic?.clientSecret ?? readString(req.body, 'client_secret'),
  );
}

function getRequestUser(req: OAuthRequest): IUser | null {
  return req.user ?? null;
}

export function createOAuthProviderHandlers(
  mongoose: typeof import('mongoose'),
  options: OAuthProviderHandlerOptions = {},
): OAuthProviderHandlers {
  const models = getModels(mongoose);
  const getIssuer = options.getIssuer ?? defaultIssuer;
  const getLoginRedirect = options.getLoginRedirect ?? defaultLoginRedirect;

  /**
   * Turns the authorize query into either a validated request or one of the two
   * outcomes that are not OAuth errors. The order matters and matches the rendered
   * page: the request is validated before the caller's right to grant is judged, so a
   * malformed request is reported as such even to a user who could not have granted it.
   */
  const resolveAuthorization = async (req: OAuthRequest): Promise<OAuthAuthorizationOutcome> => {
    const user = getRequestUser(req);
    if (!user) {
      return { kind: 'login_required', loginUrl: getLoginRedirect(req) };
    }

    const { client, scopes } = await prepareAuthorization(models, {
      responseType: readString(req.query, 'response_type'),
      clientId: readString(req.query, 'client_id'),
      redirectUri: readString(req.query, 'redirect_uri'),
      scope: readString(req.query, 'scope'),
      codeChallenge: readString(req.query, 'code_challenge'),
      codeChallengeMethod: readString(req.query, 'code_challenge_method'),
    });
    const redirectUri = readString(req.query, 'redirect_uri') ?? '';
    const state = readString(req.query, 'state');

    if (!isGrantingUser(user)) {
      const message = 'Authorization user must be admin or trusted';
      return {
        kind: 'access_denied',
        message,
        redirect: buildRedirect(redirectUri, {
          error: 'access_denied',
          error_description: message,
          state,
        }),
      };
    }

    return {
      kind: 'ok',
      draft: {
        client,
        scopes,
        redirectUri,
        state,
        codeChallenge: readString(req.query, 'code_challenge'),
        codeChallengeMethod: readString(req.query, 'code_challenge_method') as
          | 'S256'
          | 'plain'
          | undefined,
        user,
      },
    };
  };

  /**
   * Spends the single-use nonce a consent screen was given. The nonce is consumed
   * whether or not the decision is to approve, so a denied request cannot be replayed
   * into an approval by resubmitting the same form.
   */
  const resolveConsent = async (req: OAuthRequest): Promise<OAuthConsentOutcome> => {
    const user = getRequestUser(req);
    if (!user) {
      return { kind: 'login_required', loginUrl: getLoginRedirect(req) };
    }

    const nonce = readString(req.body, 'nonce');
    const consent = nonce ? consumeConsentRequest(nonce) : null;
    if (!consent || consent.userId !== getUserId(user)) {
      return { kind: 'invalid' };
    }

    if (readString(req.body, 'decision') !== 'approve') {
      return {
        kind: 'ok',
        redirect: buildRedirect(consent.redirectUri, {
          error: 'access_denied',
          error_description: 'Authorization user denied the request',
          state: consent.state,
        }),
      };
    }

    const code = await createAuthorizationCode(models, {
      clientId: consent.clientId,
      user,
      redirectUri: consent.redirectUri,
      scopes: consent.scopes,
      codeChallenge: consent.codeChallenge,
      codeChallengeMethod: consent.codeChallengeMethod,
    });

    return {
      kind: 'ok',
      redirect: buildRedirect(consent.redirectUri, { code, state: consent.state }),
    };
  };

  return {
    metadata: withErrors(async (req, res) => {
      res.json(buildMetadata(getIssuer(req)));
    }),

    scopes: withErrors(async (_req, res) => {
      res.json({ scopes: oauthScopes });
    }),

    authorizePage: withErrors(async (req, res) => {
      const outcome = await resolveAuthorization(req as OAuthRequest);

      if (outcome.kind === 'login_required') {
        res.redirect(outcome.loginUrl);
        return;
      }

      if (outcome.kind === 'access_denied') {
        res.redirect(outcome.redirect);
        return;
      }

      const { draft } = outcome;
      const nonce = createConsentRequest({
        clientId: draft.client.clientId,
        redirectUri: draft.redirectUri,
        scopes: draft.scopes,
        state: draft.state,
        codeChallenge: draft.codeChallenge,
        codeChallengeMethod: draft.codeChallengeMethod,
        userId: getUserId(draft.user),
      });

      res.type('html').send(
        renderAuthorizationPage({
          clientName: draft.client.name,
          description: draft.client.description,
          logoUrl: draft.client.logoUrl,
          redirectUri: draft.redirectUri,
          scopes: draft.scopes,
          username: draft.user.username || draft.user.name || draft.user.email,
          nonce,
        }),
      );
    }),

    authorizeContext: withErrors(async (req, res) => {
      const outcome = await resolveAuthorization(req as OAuthRequest);

      /**
       * Both of these are answers to a well-formed request, not failures of it, so they
       * carry 200: a 401 would be answered by the client's generic session recovery,
       * whose login redirect drops the `redirect_to` this one preserves.
       */
      if (outcome.kind === 'login_required') {
        res.json({ success: false, error: 'login_required', loginUrl: outcome.loginUrl });
        return;
      }

      if (outcome.kind === 'access_denied') {
        res.json({
          success: false,
          error: 'access_denied',
          message: outcome.message,
          redirect: outcome.redirect,
        });
        return;
      }

      const { draft } = outcome;
      const nonce = createConsentRequest({
        clientId: draft.client.clientId,
        redirectUri: draft.redirectUri,
        scopes: draft.scopes,
        state: draft.state,
        codeChallenge: draft.codeChallenge,
        codeChallengeMethod: draft.codeChallengeMethod,
        userId: getUserId(draft.user),
      });

      const context: OAuthAuthorizationContext = {
        clientId: draft.client.clientId,
        name: draft.client.name,
        description: draft.client.description,
        logoUrl: draft.client.logoUrl,
        homepageUrl: draft.client.homepageUrl,
        redirectUri: draft.redirectUri,
        scopes: describeScopes(draft.scopes),
        username: draft.user.username || draft.user.name || draft.user.email,
        nonce,
      };

      res.json({ success: true, ...context });
    }),

    authorizeDecision: withErrors(async (req, res) => {
      const outcome = await resolveConsent(req as OAuthRequest);

      if (outcome.kind === 'login_required') {
        res.redirect(outcome.loginUrl);
        return;
      }

      if (outcome.kind === 'invalid') {
        res.status(400).send('Invalid or expired authorization request');
        return;
      }

      res.redirect(outcome.redirect);
    }),

    authorizeDecisionJson: withErrors(async (req, res) => {
      const outcome = await resolveConsent(req as OAuthRequest);

      if (outcome.kind === 'login_required') {
        res.json({ success: false, error: 'login_required', loginUrl: outcome.loginUrl });
        return;
      }

      if (outcome.kind === 'invalid') {
        res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'Invalid or expired authorization request',
        });
        return;
      }

      res.json({ success: true, redirect: outcome.redirect });
    }),

    token: withErrors(async (req, res) => {
      const grantType = readString(req.body, 'grant_type');
      const client = await getAuthenticatedClient(models, req);

      if (grantType === 'authorization_code') {
        const result = await exchangeAuthorizationCode(models, {
          client,
          code: readString(req.body, 'code'),
          redirectUri: readString(req.body, 'redirect_uri'),
          codeVerifier: readString(req.body, 'code_verifier'),
        });

        res.json({
          access_token: result.accessToken,
          token_type: 'Bearer',
          expires_in: result.accessTokenExpiresIn,
          refresh_token: result.refreshToken,
          refresh_expires_in: result.refreshTokenExpiresIn,
          scope: result.scopes.join(' '),
          user: buildUserInfo(result.user, result.scopes),
        });
        return;
      }

      if (grantType === 'refresh_token') {
        const result = await refreshOAuthAccessToken(models, {
          client,
          refreshToken: readString(req.body, 'refresh_token'),
        });

        res.json({
          access_token: result.accessToken,
          token_type: 'Bearer',
          expires_in: result.accessTokenExpiresIn,
          refresh_token: result.refreshToken,
          refresh_expires_in: result.refreshTokenExpiresIn,
          scope: result.scopes.join(' '),
          user: buildUserInfo(result.user, result.scopes),
        });
        return;
      }

      throw new OAuthProviderError(
        'unsupported_grant_type',
        'grant_type must be authorization_code or refresh_token',
      );
    }),

    userinfo: withErrors(async (req, res) => {
      const context = await validateAccessToken(models, extractBearer(req));
      res.json(buildUserInfo(context.user, context.token.scopes));
    }),

    introspect: withErrors(async (req, res) => {
      const client = await getAuthenticatedClient(models, req);
      res.json(await introspectToken(models, { client, token: readString(req.body, 'token') }));
    }),

    revoke: withErrors(async (req, res) => {
      const client = await getAuthenticatedClient(models, req);
      await revokeToken(models, { client, token: readString(req.body, 'token') });
      res.json({ success: true });
    }),

    listClients: withErrors(async (_req, res) => {
      res.json({ success: true, clients: await listOAuthClients(models) });
    }),

    createClient: withErrors(async (req, res) => {
      const oauthReq = req as OAuthRequest;
      const result = await createOAuthClient(
        models,
        readClientInput(oauthReq),
        oauthReq.user ? getUserId(oauthReq.user) : undefined,
      );
      res.status(201).json({
        success: true,
        client: result.client,
        clientSecret: result.clientSecret,
        message: result.clientSecret
          ? 'Save clientSecret now. It will not be shown again.'
          : undefined,
      });
    }),

    getClient: withErrors(async (req, res) => {
      res.json({ success: true, client: await getOAuthClient(models, req.params.clientId) });
    }),

    updateClient: withErrors(async (req, res) => {
      res.json({
        success: true,
        client: await updateOAuthClient(models, req.params.clientId, readClientInput(req)),
      });
    }),

    rotateClientSecret: withErrors(async (req, res) => {
      const result = await rotateClientSecret(models, req.params.clientId);
      res.json({
        success: true,
        client: result.client,
        clientSecret: result.clientSecret,
        message: 'Save clientSecret now. It will not be shown again.',
      });
    }),

    deleteClient: withErrors(async (req, res) => {
      await deleteOAuthClient(models, req.params.clientId);
      res.json({ success: true });
    }),

    listGrants: withErrors(async (_req, res) => {
      const grants = await listOAuthGrants(models);
      const clientIds = [...new Set(grants.map((grant) => grant.clientId))];
      const userIds = [...new Set(grants.map((grant) => grant.userId.toString()))];
      const [clients, users] = await Promise.all([
        models.OAuthClient.find({ clientId: { $in: clientIds } }).exec(),
        models.User.find({ _id: { $in: userIds } }).exec(),
      ]);
      const clientsById = new Map(clients.map((client) => [client.clientId, client]));
      const usersById = new Map(users.map((user) => [user._id.toString(), user]));

      res.json({
        success: true,
        grants: grants.map((grant) => {
          const user = usersById.get(grant.userId.toString());
          const client = clientsById.get(grant.clientId);
          return {
            grantId: grant._id.toString(),
            clientId: grant.clientId,
            clientName: client?.name,
            userId: grant.userId.toString(),
            username: user?.username,
            email: user?.email,
            scopes: grant.scopes,
            revokedAt: grant.revokedAt?.toISOString(),
            createdAt: grant.createdAt.toISOString(),
            updatedAt: grant.updatedAt.toISOString(),
          };
        }),
      });
    }),

    revokeGrant: withErrors(async (req, res) => {
      await revokeOAuthGrant(models, req.params.grantId);
      res.json({ success: true });
    }),
  };
}
