import { useState } from 'react';
import { PrincipalType } from 'librechat-data-provider';
import { Alert, Button, Spinner } from '@librechat/client';
import type { TAdminConfigPrincipal } from 'librechat-data-provider';
import { useAdminConfigsQuery } from '~/data-provider';
import { ReplaceDialog } from './overrides/Dialogs';
import { principalKey } from './overrides/values';
import Detail from './overrides/Detail';
import { useLocalize } from '~/hooks';
import Sets from './overrides/Sets';

const NEW_PRINCIPAL: TAdminConfigPrincipal = {
  principalType: PrincipalType.USER,
  principalId: '',
};

export default function AdminConfig() {
  const localize = useLocalize();
  const configsQuery = useAdminConfigsQuery();
  const [selected, setSelected] = useState<TAdminConfigPrincipal | null>(null);
  const [creating, setCreating] = useState(false);
  const configs = configsQuery.data?.configs ?? [];
  const selectedKey =
    selected == null ? null : principalKey(selected.principalType, selected.principalId);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="admin-config-heading">
      <div className="flex items-center justify-between gap-3">
        <h4 id="admin-config-heading" className="text-sm font-medium text-text-primary">
          {localize('com_ui_admin_config_title')}
        </h4>
        <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
          {localize('com_ui_admin_config_new')}
        </Button>
      </div>

      {configsQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner />
          {localize('com_ui_loading')}
        </div>
      )}

      {configsQuery.isError && (
        <Alert variant="error">{localize('com_ui_admin_config_load_error')}</Alert>
      )}

      {!configsQuery.isLoading && !configsQuery.isError && configs.length === 0 && (
        <p className="text-sm text-text-secondary">{localize('com_ui_admin_config_empty')}</p>
      )}

      {configs.length > 0 && (
        <>
          <Sets configs={configs} selectedKey={selectedKey} onSelect={setSelected} />
          {selected == null ? (
            <p className="text-sm text-text-secondary">{localize('com_ui_admin_config_select')}</p>
          ) : (
            <Detail key={selectedKey} principal={selected} />
          )}
        </>
      )}

      {creating && (
        <ReplaceDialog
          principal={NEW_PRINCIPAL}
          overrides={{}}
          principalEditable
          open
          onOpenChange={setCreating}
        />
      )}
    </section>
  );
}
