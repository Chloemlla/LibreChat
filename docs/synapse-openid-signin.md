# Signing in with Synapse

This deployment authenticates users against **Synapse**, a self-hosted OAuth 2.0 / OpenID
Connect provider at `https://tts.chloemlla.com`. LibreChat acts as a standard OIDC client
through its generic `openid` Passport strategy; no Synapse-specific code is involved.

The provider's own third-party integration guide lives in
[`synapse-oauth-integration.md`](./synapse-oauth-integration.md). That document is a
verbatim copy of the provider's guide — it covers Synapse's API scopes, token exchange and
admin APIs, none of which LibreChat uses for sign-in. Keep it unmodified so it can be
refreshed from upstream; LibreChat-side configuration belongs here.

## Configuration

| Variable | Value | Notes |
| --- | --- | --- |
| `OPENID_ISSUER` | `https://tts.chloemlla.com` | Must match the `issuer` in the discovery document character for character. |
| `OPENID_CLIENT_ID` | from the Synapse admin UI | Create the client at `/admin?tab=oauth` on the provider. |
| `OPENID_CLIENT_SECRET` | from the Synapse admin UI | Shown only once at creation. |
| `OPENID_SCOPE` | `openid profile email` | Must include `openid`. The email scope is what lets LibreChat match an account by address. |
| `OPENID_CALLBACK_URL` | `/oauth/openid/callback` | Concatenated onto `DOMAIN_SERVER`. |
| `OPENID_SESSION_SECRET` | any long random string | Required. Without it the strategy is never registered and the login button never renders. |
| `OPENID_BUTTON_LABEL` | `Sign in with Synapse` | Login-page button text. |
| `OPENID_AUTO_REDIRECT` | `false` | Set to `true` to skip the login form entirely; only when Synapse is the sole method. |
| `ALLOW_SOCIAL_LOGIN` | `true` | Required. This gate hides every social login button, OpenID included. |

## What the provider must expose

LibreChat starts through `openid-client`'s discovery flow, so Synapse must serve:

- `GET https://tts.chloemlla.com/.well-known/openid-configuration` — the standard OIDC
  discovery path. The `/api/oauth/.well-known/openid-configuration` endpoint in the
  provider guide is a different route and is not read here.
- An `issuer` in that document equal to `OPENID_ISSUER`. `openid-client` validates this and
  refuses to start otherwise. Trailing slashes are tolerated.
- `jwks_uri`, `authorization_endpoint`, `token_endpoint` and `userinfo_endpoint` in the
  discovery document, plus a reachable JWKS endpoint for token signature validation.
- An `id_token` in the authorization-code token response. LibreChat's session and role
  mapping both depend on it; an opaque access token alone cannot complete a login.

## Redirect URI to register

Register this as a redirect URI on the Synapse OAuth client:

```text
${DOMAIN_SERVER}/oauth/openid/callback
```

With `DOMAIN_SERVER=https://chat.example.com` that is
`https://chat.example.com/oauth/openid/callback`. The provider requires an exact match. If
the admin panel SSO is also used, register
`${DOMAIN_SERVER}/api/admin/oauth/openid/callback` as well.

## Role mapping

Synapse emits a top-level `role` claim in both the `id_token` and the userinfo response.
With the shipped configuration —

```text
OPENID_ADMIN_ROLE=admin
OPENID_ADMIN_ROLE_PARAMETER_PATH=role
OPENID_ADMIN_ROLE_TOKEN_KIND=id
```

— a user whose `role` claim is `admin` receives the LibreChat `ADMIN` role at login.

Two consequences are worth knowing before enabling it:

- **The provider becomes authoritative for admin.** While this configuration is active, an
  existing LibreChat `ADMIN` whose Synapse `role` is not `admin` is demoted to `USER` on the
  next login. Admins promoted by hand inside LibreChat do not survive.
- `OPENID_ADMIN_ROLE_TOKEN_KIND` accepts only `access`, `id` or `userinfo`. Any other value,
  including `id_token`, throws `Invalid admin role token kind` and fails every login.

`OPENID_REQUIRED_ROLE` is a separate, stricter gate that blocks login outright rather than
assigning a role. Leave it empty unless a Synapse user without the listed role should be
refused entry.

## Verifying the login page

The button is rendered by the existing client code, with no fork-specific changes:

- `client/src/components/Auth/SocialLoginRender.tsx:81` builds the `openid` entry from
  `openidLoginEnabled` / `openidLabel` / `openidImageUrl`.
- `client/src/components/Auth/AuthLayout.tsx:93` mounts `SocialLoginRender` on the login and
  registration routes.
- `client/src/components/Auth/Login.tsx:77` handles `openidAutoRedirect`.

If the button does not appear, check in this order: `ALLOW_SOCIAL_LOGIN=true`, a non-empty
`OPENID_SESSION_SECRET`, and that `openid` is present in
`registration.socialLogins` in `librechat.yaml` if that key is set at all — the default list
in `packages/data-provider/src/config.ts:51` already includes it, but an explicit list
replaces the default rather than extending it.
