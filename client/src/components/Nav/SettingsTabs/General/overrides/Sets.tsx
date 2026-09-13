import { Button, Chip, Switch, cn, useToastContext } from '@librechat/client';
import type { TAdminConfig, TAdminConfigPrincipal } from 'librechat-data-provider';
import { useToggleAdminConfigMutation } from '~/data-provider';
import { PRINCIPAL_LABELS, principalKey } from './values';
import { useLocalize } from '~/hooks';

interface RowProps {
  config: TAdminConfig;
  selected: boolean;
  onSelect: (principal: TAdminConfigPrincipal) => void;
}

function Row({ config, selected, onSelect }: RowProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const toggleMutation = useToggleAdminConfigMutation();
  const toggleSaved = localize('com_ui_admin_config_active_saved');
  const toggleError = localize('com_ui_admin_config_active_error');
  const principal: TAdminConfigPrincipal = {
    principalType: config.principalType,
    principalId: config.principalId,
  };
  const label = `${localize(PRINCIPAL_LABELS[config.principalType])} · ${config.principalId}`;
  const rowClass = cn(
    'flex items-center justify-between gap-3 rounded-lg border border-border-light px-3 py-2',
    selected && 'bg-surface-secondary',
  );

  const toggle = (isActive: boolean): void => {
    toggleMutation.mutate(
      { ...principal, isActive },
      {
        onSuccess: () => showToast({ message: toggleSaved, status: 'success' }),
        onError: () => showToast({ message: toggleError, status: 'error' }),
      },
    );
  };

  return (
    <li className={rowClass}>
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-text-tertiary">
          {localize(PRINCIPAL_LABELS[config.principalType])}
        </span>
        <span className="truncate text-sm text-text-primary">{config.principalId}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Chip tone={config.isActive ? 'success' : 'neutral'}>
          {localize(config.isActive ? 'com_ui_active' : 'com_ui_admin_config_inactive')}
        </Chip>
        <Switch
          checked={config.isActive}
          disabled={toggleMutation.isLoading}
          aria-label={localize('com_ui_admin_config_active_toggle', { 0: label })}
          onCheckedChange={toggle}
        />
        <Button type="button" variant="subtle" size="sm" onClick={() => onSelect(principal)}>
          {localize('com_ui_edit')}
        </Button>
      </div>
    </li>
  );
}

interface SetsProps {
  configs: TAdminConfig[];
  selectedKey: string | null;
  onSelect: (principal: TAdminConfigPrincipal) => void;
}

export default function Sets({ configs, selectedKey, onSelect }: SetsProps) {
  const rows = configs.map((config) => (
    <Row
      key={config._id}
      config={config}
      selected={principalKey(config.principalType, config.principalId) === selectedKey}
      onSelect={onSelect}
    />
  ));

  return <ul className="flex flex-col gap-2">{rows}</ul>;
}
