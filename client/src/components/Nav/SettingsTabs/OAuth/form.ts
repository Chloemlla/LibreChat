import type { SynapseOAuthClientType } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

export const CLIENT_TYPES: readonly SynapseOAuthClientType[] = ['confidential', 'public'];

export const CLIENT_TYPE_LABELS: Record<SynapseOAuthClientType, TranslationKeys> = {
  confidential: 'com_ui_oauth_client_type_confidential',
  public: 'com_ui_oauth_client_type_public',
};

export function isClientType(value: string): value is SynapseOAuthClientType {
  return (CLIENT_TYPES as readonly string[]).includes(value);
}

/** One entry per line: the shape a list of redirect URIs is pasted in as. */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
