import { useState } from 'react';
import {
  Button,
  Chip,
  OGDialog,
  OGDialogTemplate,
  Spinner,
  useToastContext,
} from '@librechat/client';
import type { SynapseOAuthClient } from 'librechat-data-provider';
import {
  useDeleteSynapseOAuthClientMutation,
  useRotateSynapseOAuthClientSecretMutation,
  useSynapseOAuthClientsQuery,
} from '~/data-provider';
import { CLIENT_TYPE_LABELS } from './form';
import ClientDialog from './ClientDialog';
import SecretDialog from './SecretDialog';
import { useLocalize } from '~/hooks';

interface ClientRowProps {
  client: SynapseOAuthClient;
  onEdit: (client: SynapseOAuthClient) => void;
  onRotate: (client: SynapseOAuthClient) => void;
  onDelete: (client: SynapseOAuthClient) => void;
}

function ClientRow({ client, onEdit, onRotate, onDelete }: ClientRowProps) {
  const localize = useLocalize();

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border-light px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-text-primary">{client.name}</span>
        <span className="truncate font-mono text-xs text-text-secondary">{client.clientId}</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <Chip tone="neutral">{localize(CLIENT_TYPE_LABELS[client.type])}</Chip>
        <Chip tone={client.enabled ? 'success' : 'neutral'}>
          {localize(client.enabled ? 'com_ui_enabled' : 'com_ui_disabled')}
        </Chip>
        <Button type="button" variant="subtle" size="sm" onClick={() => onEdit(client)}>
          {localize('com_ui_edit')}
        </Button>
        <Button type="button" variant="subtle" size="sm" onClick={() => onRotate(client)}>
          {localize('com_ui_oauth_client_rotate')}
        </Button>
        <Button type="button" variant="subtle" size="sm" onClick={() => onDelete(client)}>
          {localize('com_ui_delete')}
        </Button>
      </div>
    </li>
  );
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  selectText: string;
  isLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

function ConfirmDialog({
  title,
  description,
  selectText,
  isLoading,
  open,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={title}
        description={description}
        selection={{ selectHandler: onConfirm, selectText, isLoading }}
      />
    </OGDialog>
  );
}

export default function Clients() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const clientsQuery = useSynapseOAuthClientsQuery();
  const rotateMutation = useRotateSynapseOAuthClientSecretMutation();
  const deleteMutation = useDeleteSynapseOAuthClientMutation();
  const [editing, setEditing] = useState<SynapseOAuthClient | null>(null);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<SynapseOAuthClient | null>(null);
  const [removing, setRemoving] = useState<SynapseOAuthClient | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const clients = clientsQuery.data?.clients ?? [];

  const rotate = (): void => {
    if (rotating == null) {
      return;
    }
    const name = rotating.name;
    rotateMutation.mutate(rotating.clientId, {
      onSuccess: (result) => {
        setRotating(null);
        if (result.clientSecret != null) {
          setSecret({ name, value: result.clientSecret });
        }
      },
      onError: () =>
        showToast({ message: localize('com_ui_oauth_client_rotate_error'), status: 'error' }),
    });
  };

  const remove = (): void => {
    if (removing == null) {
      return;
    }
    deleteMutation.mutate(removing.clientId, {
      onSuccess: () => {
        showToast({ message: localize('com_ui_oauth_client_deleted'), status: 'success' });
        setRemoving(null);
      },
      onError: () =>
        showToast({ message: localize('com_ui_oauth_client_delete_error'), status: 'error' }),
    });
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="oauth-clients-heading">
      <div className="flex items-center justify-between gap-3">
        <h4 id="oauth-clients-heading" className="text-sm font-medium text-text-primary">
          {localize('com_ui_oauth_clients_title')}
        </h4>
        <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
          {localize('com_ui_create')}
        </Button>
      </div>

      <p className="text-xs text-text-secondary">{localize('com_ui_oauth_clients_text')}</p>

      {clientsQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner />
          {localize('com_ui_loading')}
        </div>
      )}

      {clientsQuery.isError && (
        <p className="text-sm text-text-destructive">{localize('com_ui_oauth_clients_error')}</p>
      )}

      {!clientsQuery.isLoading && !clientsQuery.isError && clients.length === 0 && (
        <p className="text-sm text-text-secondary">{localize('com_ui_oauth_clients_empty')}</p>
      )}

      {clients.length > 0 && (
        <ul className="flex flex-col gap-2">
          {clients.map((client) => (
            <ClientRow
              key={client.clientId}
              client={client}
              onEdit={setEditing}
              onRotate={setRotating}
              onDelete={setRemoving}
            />
          ))}
        </ul>
      )}

      {creating && (
        <ClientDialog
          key="new"
          client={null}
          open
          onOpenChange={setCreating}
          onSecret={(name, value) => setSecret({ name, value })}
        />
      )}

      {editing != null && (
        <ClientDialog
          key={editing.clientId}
          client={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          onSecret={(name, value) => setSecret({ name, value })}
        />
      )}

      {secret != null && (
        <SecretDialog
          clientName={secret.name}
          secret={secret.value}
          open
          onOpenChange={(open) => !open && setSecret(null)}
        />
      )}

      <ConfirmDialog
        open={rotating != null}
        isLoading={rotateMutation.isLoading}
        title={localize('com_ui_oauth_client_rotate_title')}
        description={localize('com_ui_oauth_client_rotate_text', { 0: rotating?.name ?? '' })}
        selectText={localize('com_ui_oauth_client_rotate')}
        onOpenChange={(open) => !open && setRotating(null)}
        onConfirm={rotate}
      />

      <ConfirmDialog
        open={removing != null}
        isLoading={deleteMutation.isLoading}
        title={localize('com_ui_oauth_client_delete_title')}
        description={localize('com_ui_oauth_client_delete_text', { 0: removing?.name ?? '' })}
        selectText={localize('com_ui_delete')}
        onOpenChange={(open) => !open && setRemoving(null)}
        onConfirm={remove}
      />
    </section>
  );
}
