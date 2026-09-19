import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Spinner } from '@librechat/client';
import type { SynapseOAuthAuthorizeParams } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  useSubmitSynapseOAuthAuthorizationMutation,
  useSynapseOAuthAuthorizationQuery,
} from '~/data-provider';
import { useLocalize, useAuthContext } from '~/hooks';

/**
 * Reads the query `GET /oauth/authorize` documents into the shape the context endpoint
 * takes. Absent values stay empty rather than defaulting: `response_type` has no default
 * worth inventing, and passing nothing lets the provider report it the way it would have
 * to a browser that omitted it.
 */
const readParams = (search: URLSearchParams): SynapseOAuthAuthorizeParams => ({
  response_type: search.get('response_type') ?? '',
  client_id: search.get('client_id') ?? '',
  redirect_uri: search.get('redirect_uri') ?? '',
  scope: search.get('scope') ?? undefined,
  state: search.get('state') ?? undefined,
  code_challenge: search.get('code_challenge') ?? undefined,
  code_challenge_method: search.get('code_challenge_method') ?? undefined,
});

/** The provider's redirect is the page's whole answer, so it is followed rather than rendered. */
const followRedirect = (url: string) => window.location.assign(url);

function ConsentShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-secondary p-4 sm:p-8">
      <main
        aria-labelledby="oauth-consent-heading"
        className="w-full max-w-lg rounded-lg bg-surface-primary p-6 shadow-lg sm:p-8"
      >
        {children}
      </main>
    </div>
  );
}

export default function Consent() {
  const localize = useLocalize();
  const { isAuthReady } = useAuthContext();
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  const params = useMemo(() => readParams(new URLSearchParams(search)), [search]);
  const hasRequest = params.client_id !== '' && params.redirect_uri !== '';

  /** Held until the session is restored: asking before the silent refresh has run reports
   *  `login_required` to a visitor who is in fact signed in. */
  const { data, isLoading, isError } = useSynapseOAuthAuthorizationQuery(params, {
    enabled: hasRequest && isAuthReady,
  });
  const decision = useSubmitSynapseOAuthAuthorizationMutation();

  /** `login_required` and `access_denied` both arrive as an answer rather than an error,
   *  and both resolve to a URL the browser has to visit. */
  const redirectTarget =
    data == null || data.success
      ? null
      : data.error === 'login_required'
        ? data.loginUrl
        : data.redirect;

  useEffect(() => {
    if (redirectTarget != null) {
      followRedirect(redirectTarget);
    }
  }, [redirectTarget]);

  const submit = (value: 'approve' | 'deny') => {
    if (data == null || !data.success) {
      return;
    }
    decision.mutate(
      { nonce: data.nonce, decision: value },
      {
        onSuccess: (result) => followRedirect(result.success ? result.redirect : result.loginUrl),
      },
    );
  };

  if (!hasRequest) {
    return (
      <ConsentShell>
        <Alert variant="error">{localize('com_ui_oauth_consent_error_invalid')}</Alert>
      </ConsentShell>
    );
  }

  if (isLoading || isError || data == null || !data.success) {
    return (
      <ConsentShell>
        {isError ? (
          <Alert variant="error">{localize('com_ui_oauth_consent_error_invalid')}</Alert>
        ) : (
          <div className="flex items-center justify-center gap-2 text-sm text-text-secondary">
            <Spinner />
            {localize('com_ui_oauth_consent_redirecting')}
          </div>
        )}
      </ConsentShell>
    );
  }

  const description = data.description || localize('com_ui_oauth_consent_description_default');

  return (
    <ConsentShell>
      <header className="flex items-start gap-4">
        {data.logoUrl != null && (
          <img
            src={data.logoUrl}
            alt=""
            className="h-12 w-12 shrink-0 rounded-lg object-cover"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0">
          <h1 id="oauth-consent-heading" className="text-xl font-semibold text-text-primary">
            {data.name}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{description}</p>
        </div>
      </header>

      {data.homepageUrl != null && (
        <a
          className="mt-2 inline-block text-sm text-text-secondary underline"
          href={data.homepageUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {data.homepageUrl}
        </a>
      )}

      <p className="mt-6 text-sm text-text-secondary">
        {localize('com_ui_oauth_consent_signed_in_as')}{' '}
        <strong className="font-semibold text-text-primary">{data.username}</strong>
      </p>

      <p className="mt-4 text-sm text-text-secondary">
        {localize('com_ui_oauth_consent_redirect_uri')}
      </p>
      <code className="mt-1 block overflow-x-auto rounded bg-surface-tertiary px-2 py-1 text-xs text-text-primary">
        {data.redirectUri}
      </code>

      <h2 className="mt-6 text-sm font-medium text-text-primary">
        {localize('com_ui_oauth_consent_scopes')}
      </h2>
      <ul className="mt-2 flex flex-col gap-2">
        {data.scopes.map((scope) => (
          <li key={scope.key} className="rounded border border-border-light px-3 py-2">
            <span className="text-sm font-medium text-text-primary">{scope.label}</span>
            <span className="ml-2 font-mono text-xs text-text-secondary">{scope.key}</span>
            {scope.description !== '' && (
              <p className="mt-1 text-xs text-text-secondary">{scope.description}</p>
            )}
          </li>
        ))}
      </ul>

      {decision.isError && (
        <div className="mt-4">
          <Alert variant="error">{localize('com_ui_oauth_consent_error_decision')}</Alert>
        </div>
      )}

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={decision.isLoading}
          onClick={() => submit('deny')}
        >
          {localize('com_ui_oauth_consent_deny')}
        </Button>
        <Button
          type="button"
          variant="submit"
          disabled={decision.isLoading}
          onClick={() => submit('approve')}
        >
          {localize('com_ui_oauth_consent_approve')}
        </Button>
      </div>
    </ConsentShell>
  );
}
