import { PrincipalType } from 'librechat-data-provider';
import type { TConfigPrincipalType, TAdminConfigOverridesRequest } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

export type ConfigOverrides = TAdminConfigOverridesRequest['overrides'];

export const PRINCIPAL_TYPES: readonly TConfigPrincipalType[] = [
  PrincipalType.USER,
  PrincipalType.GROUP,
  PrincipalType.ROLE,
];

export const PRINCIPAL_LABELS: Record<TConfigPrincipalType, TranslationKeys> = {
  [PrincipalType.USER]: 'com_ui_user',
  [PrincipalType.GROUP]: 'com_ui_group',
  [PrincipalType.ROLE]: 'com_ui_role',
};

export function isPrincipalType(value: string): value is TConfigPrincipalType {
  return (PRINCIPAL_TYPES as readonly string[]).includes(value);
}

export function principalKey(principalType: TConfigPrincipalType, principalId: string): string {
  return `${principalType}:${principalId}`;
}

/** `null` when the text is not a JSON object, the only shape an overrides body accepts. */
export function parseOverrides(text: string): ConfigOverrides | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ConfigOverrides;
  } catch {
    return null;
  }
}

/** JSON when it parses, the text otherwise, so an unquoted value is still a string. */
export function parseValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '';
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}
