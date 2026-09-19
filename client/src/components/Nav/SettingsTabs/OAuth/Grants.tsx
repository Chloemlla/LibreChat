import { Button, Chip, Spinner, useToastContext } from '@librechat/client';
import type { SynapseOAuthGrant } from 'librechat-data-provider';
import { useRevokeSynapseOAuthGrantMutation, useSynapseOAuthGrantsQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';

interface GrantRowProps {
  grant: SynapseOAuthGrant;
  pending: boolean;
  onRevoke: (grant: SynapseOAuthGrant) => void;
}

function GrantRow({ grant, pending, onRevoke }: GrantRowProps) {
  const localize = useLocalize();
  const revoked = grant.revokedAt != null;
  const subject = grant.username || grant.email || grant.userId;
  const client = grant.clientName || grant.clientId;

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border-light px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-text-primary">
          {client} · {subject}
        </span>
        <span className="truncate text-xs text-text-secondary">{grant.scopes.join(', ')}</span>
        <span className="truncate text-xs text-text-tertiary">
          {new Date(grant.createdAt).toLocaleString()}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {revoked && <Chip tone="neutral">{localize('com_ui_oauth_grant_revoked')}</Chip>}
        <Button
          type="button"
          variant="subtle"
          size="sm"
          disabled={revoked || pending}
          onClick={() => onRevoke(grant)}
        >
          {localize('com_ui_revoke')}
        </Button>
      </div>
    </li>
  );
}

export default function Grants() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const grantsQuery = useSynapseOAuthGrantsQuery();
  const revokeMutation = useRevokeSynapseOAuthGrantMutation();
  const grants = grantsQuery.data?.grants ?? [];

  const revoke = (grant: SynapseOAuthGrant): void => {
    revokeMutation.mutate(grant.grantId, {
      onSuccess: () =>
        showToast({ message: localize('com_ui_oauth_grant_revoked_toast'), status: 'success' }),
      onError: () =>
        showToast({ message: localize('com_ui_oauth_grant_revoke_error'), status: 'error' }),
    });
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="oauth-grants-heading">
      <h4 id="oauth-grants-heading" className="text-sm font-medium text-text-primary">
        {localize('com_ui_oauth_grants_title')}
      </h4>

      <p className="text-xs text-text-secondary">{localize('com_ui_oauth_grants_text')}</p>

      {grantsQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner />
          {localize('com_ui_loading')}
        </div>
      )}

      {grantsQuery.isError && (
        <p className="text-sm text-text-destructive">{localize('com_ui_oauth_grants_error')}</p>
      )}

      {!grantsQuery.isLoading && !grantsQuery.isError && grants.length === 0 && (
        <p className="text-sm text-text-secondary">{localize('com_ui_oauth_grants_empty')}</p>
      )}

      {grants.length > 0 && (
        <ul className="flex flex-col gap-2">
          {grants.map((grant) => (
            <GrantRow
              key={grant.grantId}
              grant={grant}
              pending={revokeMutation.isLoading}
              onRevoke={revoke}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
