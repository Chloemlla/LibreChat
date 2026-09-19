import { useState } from 'react';
import {
  Button,
  Checkbox,
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
  Switch,
  Textarea,
  useToastContext,
} from '@librechat/client';
import type {
  SynapseOAuthClient,
  SynapseOAuthClientInput,
  SynapseOAuthClientType,
} from 'librechat-data-provider';
import {
  useCreateSynapseOAuthClientMutation,
  useSynapseOAuthScopesQuery,
  useUpdateSynapseOAuthClientMutation,
} from '~/data-provider';
import { CLIENT_TYPES, CLIENT_TYPE_LABELS, isClientType, parseLines } from './form';
import { useLocalize } from '~/hooks';

interface ClientDialogProps {
  /** `null` creates a client; an existing one is edited in place. */
  client: SynapseOAuthClient | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A freshly minted secret is shown once, so the caller takes it from here. */
  onSecret: (clientName: string, secret: string) => void;
}

export default function ClientDialog({ client, open, onOpenChange, onSecret }: ClientDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const scopesQuery = useSynapseOAuthScopesQuery({ enabled: open });
  const createMutation = useCreateSynapseOAuthClientMutation();
  const updateMutation = useUpdateSynapseOAuthClientMutation();
  const [name, setName] = useState(client?.name ?? '');
  const [type, setType] = useState<SynapseOAuthClientType>(client?.type ?? 'confidential');
  const [description, setDescription] = useState(client?.description ?? '');
  const [homepageUrl, setHomepageUrl] = useState(client?.homepageUrl ?? '');
  const [logoUrl, setLogoUrl] = useState(client?.logoUrl ?? '');
  const [redirects, setRedirects] = useState((client?.redirectUris ?? []).join('\n'));
  const [scopes, setScopes] = useState<string[]>(client?.allowedScopes ?? []);
  const [rateLimit, setRateLimit] = useState(String(client?.rateLimitPerMinute ?? 60));
  const [enabled, setEnabled] = useState(client?.enabled ?? true);

  const catalogue = scopesQuery.data?.scopes ?? [];
  const redirectUris = parseLines(redirects);
  const rateLimitPerMinute = Number(rateLimit);
  const rateLimitValid = Number.isInteger(rateLimitPerMinute) && rateLimitPerMinute > 0;
  /** An empty scope list is read as "unset" and falls back to the server default, so the
   *  form asks for an explicit choice instead of quietly granting that default. */
  const valid =
    name.trim().length > 0 && redirectUris.length > 0 && scopes.length > 0 && rateLimitValid;
  const pending = createMutation.isLoading || updateMutation.isLoading;

  const toggleScope = (key: string, checked: boolean): void => {
    setScopes((current) =>
      checked ? [...current, key] : current.filter((entry) => entry !== key),
    );
  };

  const submit = (): void => {
    if (!valid) {
      return;
    }
    const payload: SynapseOAuthClientInput = {
      name: name.trim(),
      type,
      description: description.trim(),
      homepageUrl: homepageUrl.trim(),
      logoUrl: logoUrl.trim(),
      redirectUris,
      allowedScopes: scopes,
      rateLimitPerMinute,
      enabled,
    };
    if (client == null) {
      createMutation.mutate(payload, {
        onSuccess: (result) => {
          onOpenChange(false);
          if (result.clientSecret != null) {
            onSecret(result.client.name, result.clientSecret);
          }
        },
        onError: () =>
          showToast({ message: localize('com_ui_oauth_client_save_error'), status: 'error' }),
      });
      return;
    }
    updateMutation.mutate(
      { clientId: client.clientId, payload },
      {
        onSuccess: () => {
          showToast({ message: localize('com_ui_oauth_client_saved'), status: 'success' });
          onOpenChange(false);
        },
        onError: () =>
          showToast({ message: localize('com_ui_oauth_client_save_error'), status: 'error' }),
      },
    );
  };

  const changeType = (value: string): void => {
    if (isClientType(value)) {
      setType(value);
    }
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize(
          client == null ? 'com_ui_oauth_client_new_title' : 'com_ui_oauth_client_edit_title',
        )}
        description={localize(
          client == null ? 'com_ui_oauth_client_new_text' : 'com_ui_oauth_client_edit_text',
        )}
        main={
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-name">{localize('com_ui_name')}</Label>
              <Input
                id="oauth-client-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-type">{localize('com_ui_oauth_client_type')}</Label>
              <Select value={type} onValueChange={changeType}>
                <SelectTrigger id="oauth-client-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLIENT_TYPES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {localize(CLIENT_TYPE_LABELS[entry])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-description">{localize('com_ui_description')}</Label>
              <Textarea
                id="oauth-client-description"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <p className="text-xs text-text-secondary">
                {localize('com_ui_oauth_client_description_hint')}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-redirects">
                {localize('com_ui_oauth_client_redirect_uris')}
              </Label>
              <Textarea
                id="oauth-client-redirects"
                rows={4}
                value={redirects}
                onChange={(event) => setRedirects(event.target.value)}
              />
              <p className="text-xs text-text-secondary">
                {localize('com_ui_oauth_client_redirect_uris_hint')}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-homepage">
                {localize('com_ui_oauth_client_homepage')}
              </Label>
              <Input
                id="oauth-client-homepage"
                value={homepageUrl}
                placeholder="https://"
                onChange={(event) => setHomepageUrl(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-logo">{localize('com_ui_oauth_client_logo')}</Label>
              <Input
                id="oauth-client-logo"
                value={logoUrl}
                placeholder="https://"
                onChange={(event) => setLogoUrl(event.target.value)}
              />
              <p className="text-xs text-text-secondary">
                {localize('com_ui_oauth_client_logo_hint')}
              </p>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium text-text-primary">
                {localize('com_ui_oauth_client_scopes')}
              </legend>
              {scopesQuery.isLoading && (
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <Spinner />
                  {localize('com_ui_loading')}
                </div>
              )}
              {catalogue.map((scope) => (
                <div key={scope.key} className="flex items-start gap-2">
                  <Checkbox
                    id={`oauth-scope-${scope.key}`}
                    aria-labelledby={`oauth-scope-label-${scope.key}`}
                    checked={scopes.includes(scope.key)}
                    onCheckedChange={(checked) => toggleScope(scope.key, checked === true)}
                  />
                  <div className="flex flex-col">
                    <Label
                      id={`oauth-scope-label-${scope.key}`}
                      htmlFor={`oauth-scope-${scope.key}`}
                      className="font-normal"
                    >
                      {scope.label}
                    </Label>
                    <span className="text-xs text-text-secondary">{scope.description}</span>
                  </div>
                </div>
              ))}
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-rate-limit">
                {localize('com_ui_oauth_client_rate_limit')}
              </Label>
              <Input
                id="oauth-client-rate-limit"
                inputMode="numeric"
                value={rateLimit}
                onChange={(event) => setRateLimit(event.target.value)}
              />
              {!rateLimitValid && (
                <p className="text-xs text-text-destructive">
                  {localize('com_ui_oauth_client_rate_limit_invalid')}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label id="oauth-client-enabled-label" htmlFor="oauth-client-enabled">
                {localize('com_ui_oauth_client_enabled')}
              </Label>
              <Switch
                id="oauth-client-enabled"
                aria-labelledby="oauth-client-enabled-label"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>
          </div>
        }
        buttons={
          <Button type="button" disabled={!valid || pending} onClick={submit}>
            {pending ? <Spinner /> : localize('com_ui_save')}
          </Button>
        }
      />
    </OGDialog>
  );
}
