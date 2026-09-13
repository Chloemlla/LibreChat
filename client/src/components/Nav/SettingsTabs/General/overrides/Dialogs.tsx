import { useState } from 'react';
import {
  Button,
  Input,
  Label,
  OGDialog,
  OGDialogTemplate,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  useToastContext,
} from '@librechat/client';
import type {
  TAdminConfigPrincipal,
  TAdminConfigOverridesRequest,
  TAdminConfigWriteResponse,
} from 'librechat-data-provider';
import type { ConfigOverrides } from './values';
import type { TranslationKeys } from '~/hooks';
import {
  useDeleteAdminConfigFieldMutation,
  useDeleteAdminConfigMutation,
  usePatchAdminConfigFieldsMutation,
  useTombstoneAdminConfigFieldMutation,
  useUpsertAdminConfigMutation,
} from '~/data-provider';
import {
  PRINCIPAL_LABELS,
  PRINCIPAL_TYPES,
  formatJson,
  isPrincipalType,
  parseOverrides,
  parseValue,
} from './values';
import { useLocalize } from '~/hooks';

export type FieldOperation = 'patch' | 'tombstone' | 'delete';

interface OperationCopy {
  title: TranslationKeys;
  description: TranslationKeys;
  submit: TranslationKeys;
  success: TranslationKeys;
  error: TranslationKeys;
}

const OPERATION_COPY: Record<FieldOperation, OperationCopy> = {
  patch: {
    title: 'com_ui_admin_config_patch_title',
    description: 'com_ui_admin_config_patch_text',
    submit: 'com_ui_admin_config_patch',
    success: 'com_ui_admin_config_patch_saved',
    error: 'com_ui_admin_config_patch_error',
  },
  tombstone: {
    title: 'com_ui_admin_config_tombstone_title',
    description: 'com_ui_admin_config_tombstone_text',
    submit: 'com_ui_admin_config_tombstone',
    success: 'com_ui_admin_config_tombstone_saved',
    error: 'com_ui_admin_config_tombstone_error',
  },
  delete: {
    title: 'com_ui_admin_config_delete_field_title',
    description: 'com_ui_admin_config_delete_field_text',
    submit: 'com_ui_admin_config_delete_field',
    success: 'com_ui_admin_config_delete_field_saved',
    error: 'com_ui_admin_config_delete_field_error',
  },
};

interface FieldDialogProps {
  principal: TAdminConfigPrincipal;
  operation: FieldOperation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FieldDialog({ principal, operation, open, onOpenChange }: FieldDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const patchMutation = usePatchAdminConfigFieldsMutation();
  const tombstoneMutation = useTombstoneAdminConfigFieldMutation();
  const deleteFieldMutation = useDeleteAdminConfigFieldMutation();
  const [fieldPath, setFieldPath] = useState('');
  const [value, setValue] = useState('');
  const copy = OPERATION_COPY[operation];
  const path = fieldPath.trim();
  const noActionMessage = localize('com_ui_admin_config_no_action');
  const pending =
    patchMutation.isLoading || tombstoneMutation.isLoading || deleteFieldMutation.isLoading;

  const close = (): void => {
    setFieldPath('');
    setValue('');
    onOpenChange(false);
  };

  const succeeded = (): void => {
    showToast({ message: localize(copy.success), status: 'success' });
    close();
  };

  const fail = (): void => {
    showToast({ message: localize(copy.error), status: 'error' });
  };

  /** A write answered with a message stored nothing, so the dialog stays open. */
  const saved = (result: TAdminConfigWriteResponse): void => {
    if ('message' in result) {
      showToast({ message: noActionMessage, status: 'warning' });
      return;
    }
    succeeded();
  };

  const submit = (): void => {
    if (path.length === 0) {
      return;
    }
    const principalType = principal.principalType;
    const principalId = principal.principalId;
    if (operation === 'patch') {
      const entries = [{ fieldPath: path, value: parseValue(value) }];
      const patchRequest = { principalType, principalId, entries };
      patchMutation.mutate(patchRequest, { onSuccess: saved, onError: fail });
      return;
    }
    const fieldRequest = { principalType, principalId, fieldPath: path };
    if (operation === 'tombstone') {
      tombstoneMutation.mutate(fieldRequest, { onSuccess: saved, onError: fail });
      return;
    }
    deleteFieldMutation.mutate(fieldRequest, { onSuccess: succeeded, onError: fail });
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize(copy.title)}
        description={localize(copy.description)}
        main={
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-config-field-path">
                {localize('com_ui_admin_config_field_path')}
              </Label>
              <Input
                id="admin-config-field-path"
                value={fieldPath}
                placeholder={localize('com_ui_admin_config_field_path_placeholder')}
                onChange={(event) => setFieldPath(event.target.value)}
              />
            </div>
            {operation === 'patch' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="admin-config-field-value">
                  {localize('com_ui_admin_config_field_value')}
                </Label>
                <Textarea
                  id="admin-config-field-value"
                  rows={3}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
                <p className="text-xs text-text-secondary">
                  {localize('com_ui_admin_config_field_value_hint')}
                </p>
              </div>
            )}
          </div>
        }
        buttons={
          <Button type="button" disabled={path.length === 0 || pending} onClick={submit}>
            {pending ? <Spinner /> : localize(copy.submit)}
          </Button>
        }
      />
    </OGDialog>
  );
}

interface ReplaceDialogProps {
  principal: TAdminConfigPrincipal;
  overrides: ConfigOverrides;
  priority?: number;
  /** A set being created has no principal yet, so the dialog collects one. */
  principalEditable?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReplaceDialog({
  principal,
  overrides,
  priority,
  principalEditable = false,
  open,
  onOpenChange,
}: ReplaceDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const upsertMutation = useUpsertAdminConfigMutation();
  const [text, setText] = useState(() => formatJson(overrides));
  const initialPriority = priority == null ? '' : String(priority);
  const [priorityText, setPriorityText] = useState(initialPriority);
  const [principalType, setPrincipalType] = useState(principal.principalType);
  const [principalId, setPrincipalId] = useState(principal.principalId);
  const parsed = parseOverrides(text);
  const priorityValue = priorityText.trim().length === 0 ? undefined : Number(priorityText);
  const priorityValid =
    priorityValue == null || (Number.isInteger(priorityValue) && priorityValue >= 0);
  const typedPrincipalId = principalId.trim();
  const principalValid = !principalEditable || typedPrincipalId.length > 0;
  const target: TAdminConfigPrincipal = principalEditable
    ? { principalType, principalId: typedPrincipalId }
    : principal;
  const noActionMessage = localize('com_ui_admin_config_no_action');
  const savedMessage = localize('com_ui_admin_config_saved');
  const saveErrorMessage = localize('com_ui_admin_config_save_error');
  const title = localize(
    principalEditable ? 'com_ui_admin_config_new_title' : 'com_ui_admin_config_replace_title',
  );
  const description = localize(
    principalEditable ? 'com_ui_admin_config_new_text' : 'com_ui_admin_config_replace_text',
  );

  const fail = (): void => {
    showToast({ message: saveErrorMessage, status: 'error' });
  };

  const changePrincipalType = (value: string): void => {
    if (isPrincipalType(value)) {
      setPrincipalType(value);
    }
  };

  const submit = (): void => {
    if (parsed == null || !priorityValid || !principalValid) {
      return;
    }
    const request: TAdminConfigOverridesRequest = { ...target, overrides: parsed };
    if (priorityValue != null) {
      request.priority = priorityValue;
    }
    upsertMutation.mutate(request, {
      onSuccess: (result) => {
        if ('message' in result) {
          showToast({ message: noActionMessage, status: 'warning' });
          return;
        }
        showToast({ message: savedMessage, status: 'success' });
        onOpenChange(false);
      },
      onError: fail,
    });
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={title}
        description={description}
        main={
          <div className="flex flex-col gap-4">
            {principalEditable && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="admin-config-principal-type">
                  {localize('com_ui_admin_config_principal_type')}
                </Label>
                <Select value={principalType} onValueChange={changePrincipalType}>
                  <SelectTrigger id="admin-config-principal-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRINCIPAL_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {localize(PRINCIPAL_LABELS[type])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {principalEditable && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="admin-config-principal-id">
                  {localize('com_ui_admin_config_principal_id')}
                </Label>
                <Input
                  id="admin-config-principal-id"
                  value={principalId}
                  placeholder={localize('com_ui_admin_config_principal_id_placeholder')}
                  onChange={(event) => setPrincipalId(event.target.value)}
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-config-overrides">
                {localize('com_ui_admin_config_overrides_json')}
              </Label>
              <Textarea
                id="admin-config-overrides"
                rows={10}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              {parsed == null && (
                <p className="text-xs text-text-destructive">
                  {localize('com_ui_admin_config_json_invalid')}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-config-priority">
                {localize('com_ui_admin_config_priority')}
              </Label>
              <Input
                id="admin-config-priority"
                inputMode="numeric"
                value={priorityText}
                onChange={(event) => setPriorityText(event.target.value)}
              />
              {!priorityValid && (
                <p className="text-xs text-text-destructive">
                  {localize('com_ui_admin_config_priority_invalid')}
                </p>
              )}
            </div>
          </div>
        }
        buttons={
          <Button
            type="button"
            disabled={
              parsed == null || !priorityValid || !principalValid || upsertMutation.isLoading
            }
            onClick={submit}
          >
            {upsertMutation.isLoading ? <Spinner /> : localize('com_ui_admin_config_save')}
          </Button>
        }
      />
    </OGDialog>
  );
}

interface DeleteSetDialogProps {
  principal: TAdminConfigPrincipal;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteSetDialog({ principal, label, open, onOpenChange }: DeleteSetDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const deleteMutation = useDeleteAdminConfigMutation();
  const deletedMessage = localize('com_ui_admin_config_deleted');
  const deleteErrorMessage = localize('com_ui_admin_config_delete_error');

  const remove = (): void => {
    deleteMutation.mutate(principal, {
      onSuccess: () => {
        showToast({ message: deletedMessage, status: 'success' });
        onOpenChange(false);
      },
      onError: () => showToast({ message: deleteErrorMessage, status: 'error' }),
    });
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_admin_config_delete_title')}
        description={localize('com_ui_admin_config_delete_text', { 0: label })}
        selection={{
          selectHandler: remove,
          selectText: localize('com_ui_delete'),
          isLoading: deleteMutation.isLoading,
          selectClasses:
            'bg-surface-destructive text-text-on-status transition-all duration-200 hover:bg-surface-destructive-hover',
        }}
      />
    </OGDialog>
  );
}
