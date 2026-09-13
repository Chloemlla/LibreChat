import { useState } from 'react';
import { Alert, Button, Chip, Spinner } from '@librechat/client';
import type { TAdminConfigPrincipal } from 'librechat-data-provider';
import type { FieldOperation } from './Dialogs';
import type { TranslationKeys } from '~/hooks';
import { DeleteSetDialog, FieldDialog, ReplaceDialog } from './Dialogs';
import { PRINCIPAL_LABELS, formatJson } from './values';
import { useAdminConfigQuery } from '~/data-provider';
import { isNotFoundError } from '~/utils';
import { useLocalize } from '~/hooks';

const FIELD_ACTIONS: Array<{ operation: FieldOperation; label: TranslationKeys }> = [
  { operation: 'patch', label: 'com_ui_admin_config_patch' },
  { operation: 'tombstone', label: 'com_ui_admin_config_tombstone' },
  { operation: 'delete', label: 'com_ui_admin_config_delete_field' },
];

interface DetailProps {
  principal: TAdminConfigPrincipal;
}

export default function Detail({ principal }: DetailProps) {
  const localize = useLocalize();
  const query = useAdminConfigQuery(principal.principalType, principal.principalId);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [operation, setOperation] = useState<FieldOperation | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const label = `${localize(PRINCIPAL_LABELS[principal.principalType])} · ${principal.principalId}`;
  const config = query.data?.config;
  const overrides = config?.overrides ?? {};
  const tombstones = config?.tombstones ?? [];
  const missing = query.isError && isNotFoundError(query.error);
  const noneMessage = localize('com_ui_admin_config_none_stored');
  const errorMessage = localize('com_ui_admin_config_detail_error');
  const meta = localize('com_ui_admin_config_meta', {
    0: String(config?.priority ?? 0),
    1: String(config?.configVersion ?? 0),
  });
  const tombstoneItems = tombstones.map((path) => (
    <li key={path} className="truncate text-xs text-text-primary">
      {path}
    </li>
  ));

  const openReplace = (): void => setReplaceOpen(true);
  const openDelete = (): void => setDeleteOpen(true);
  const closeOperation = (next: boolean): void => {
    if (!next) {
      setOperation(null);
    }
  };

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <Spinner />
        {localize('com_ui_loading')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-medium p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{label}</p>
          {config != null && <p className="truncate text-xs text-text-secondary">{meta}</p>}
        </div>
        {config != null && (
          <Chip tone={config.isActive ? 'success' : 'neutral'}>
            {localize(config.isActive ? 'com_ui_active' : 'com_ui_admin_config_inactive')}
          </Chip>
        )}
      </div>

      {missing && <Alert variant="info">{noneMessage}</Alert>}

      {query.isError && !missing && <Alert variant="error">{errorMessage}</Alert>}

      {config != null && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-text-secondary">
            {localize('com_ui_admin_config_overrides')}
          </p>
          <pre className="max-h-64 overflow-auto rounded-md bg-surface-tertiary p-3 text-xs text-text-primary">
            {formatJson(overrides)}
          </pre>
        </div>
      )}

      {config != null && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-text-secondary">
            {localize('com_ui_admin_config_tombstones')}
          </p>
          {tombstones.length === 0 && (
            <p className="text-xs text-text-secondary">
              {localize('com_ui_admin_config_tombstones_none')}
            </p>
          )}
          {tombstones.length > 0 && <ul className="flex flex-col gap-1">{tombstoneItems}</ul>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={openReplace}>
          {localize('com_ui_admin_config_replace')}
        </Button>
        {config != null &&
          FIELD_ACTIONS.map((action) => (
            <Button
              key={action.operation}
              type="button"
              variant="subtle"
              size="sm"
              onClick={() => setOperation(action.operation)}
            >
              {localize(action.label)}
            </Button>
          ))}
        {config != null && (
          <Button type="button" variant="destructive" size="sm" onClick={openDelete}>
            {localize('com_ui_admin_config_delete_set')}
          </Button>
        )}
      </div>

      {replaceOpen && (
        <ReplaceDialog
          principal={principal}
          overrides={overrides}
          priority={config?.priority}
          open
          onOpenChange={setReplaceOpen}
        />
      )}

      {operation != null && (
        <FieldDialog
          principal={principal}
          operation={operation}
          open
          onOpenChange={closeOperation}
        />
      )}

      {deleteOpen && (
        <DeleteSetDialog principal={principal} label={label} open onOpenChange={setDeleteOpen} />
      )}
    </div>
  );
}
