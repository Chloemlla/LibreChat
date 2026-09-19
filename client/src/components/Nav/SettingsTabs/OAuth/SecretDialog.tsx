import { useState } from 'react';
import {
  Alert,
  Button,
  Input,
  OGDialog,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import { useLocalize } from '~/hooks';

interface SecretDialogProps {
  clientName: string;
  secret: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The secret is returned by the API exactly once and stored hashed, so this dialog is
 *  the only place it can be read — and it says so. */
export default function SecretDialog({
  clientName,
  secret,
  open,
  onOpenChange,
}: SecretDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      showToast({ message: localize('com_ui_copied'), status: 'success' });
    } catch {
      showToast({ message: localize('com_ui_oauth_secret_copy_error'), status: 'error' });
    }
  };

  const close = (next: boolean): void => {
    if (!next) {
      setCopied(false);
    }
    onOpenChange(next);
  };

  return (
    <OGDialog open={open} onOpenChange={close}>
      <OGDialogTemplate
        title={localize('com_ui_oauth_secret_title', { 0: clientName })}
        description={localize('com_ui_oauth_secret_text')}
        main={
          <div className="flex flex-col gap-3">
            <Alert variant="warning">{localize('com_ui_oauth_secret_warning')}</Alert>
            <div className="flex items-center gap-2">
              <Input readOnly value={secret} aria-label={localize('com_ui_oauth_secret_label')} />
              <Button type="button" variant="outline" onClick={copy}>
                {localize(copied ? 'com_ui_copied' : 'com_ui_copy')}
              </Button>
            </div>
          </div>
        }
        buttons={
          <Button type="button" onClick={() => close(false)}>
            {localize('com_ui_close')}
          </Button>
        }
      />
    </OGDialog>
  );
}
