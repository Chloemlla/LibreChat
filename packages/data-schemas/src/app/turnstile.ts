import logger from '~/config/winston';
import { removeNullishValues } from 'librechat-data-provider';
import type { TCustomConfig, TConfigDefaults } from 'librechat-data-provider';

type TurnstileConfig = NonNullable<TCustomConfig['turnstile']>;
type TurnstileOptions = NonNullable<TurnstileConfig['options']>;
type TurnstileSize = NonNullable<TurnstileOptions['size']>;
type TurnstileTheme = NonNullable<TurnstileOptions['theme']>;

const turnstileSizes: ReadonlySet<TurnstileSize> = new Set([
  'normal',
  'compact',
  'flexible',
  'invisible',
]);
const turnstileThemes: ReadonlySet<TurnstileTheme> = new Set(['auto', 'light', 'dark']);

function readEnvValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function readEnvOption<T extends string>(name: string, values: ReadonlySet<T>): T | undefined {
  const value = readEnvValue(name);
  if (!value) {
    return undefined;
  }

  if (values.has(value as T)) {
    return value as T;
  }

  logger.warn(`[Turnstile] Ignoring invalid ${name}: ${value}`);
  return undefined;
}

/**
 * Loads and maps the Cloudflare Turnstile configuration.
 *
 * Expected config structure:
 *
 * turnstile:
 *   siteKey: "your-site-key-here"
 *   options:
 *     language: "auto"    // "auto" or an ISO 639-1 language code (e.g. en)
 *     size: "normal"      // Options: "normal", "compact", "flexible", or "invisible"
 *
 * @param config - The loaded custom configuration.
 * @param configDefaults - The custom configuration default values.
 * @returns The mapped Turnstile configuration.
 */
export function loadTurnstileConfig(
  config: Partial<TCustomConfig> | undefined,
  configDefaults: TConfigDefaults,
): Partial<TCustomConfig['turnstile']> {
  const { turnstile: customTurnstile } = config ?? {};
  const { turnstile: defaults } = configDefaults;
  const envSiteKey = readEnvValue('TURNSTILE_SITE_KEY');
  const envLanguage = readEnvValue('TURNSTILE_LANGUAGE');
  const envSize = readEnvOption('TURNSTILE_SIZE', turnstileSizes);
  const envTheme = readEnvOption('TURNSTILE_THEME', turnstileThemes);
  const envOptions = removeNullishValues({
    language: envLanguage,
    size: envSize,
    theme: envTheme,
  });
  const options = removeNullishValues({
    ...(defaults as TCustomConfig['turnstile'] | undefined)?.options,
    ...customTurnstile?.options,
    ...envOptions,
  });

  const loadedTurnstile = removeNullishValues({
    siteKey:
      envSiteKey ??
      customTurnstile?.siteKey ??
      (defaults as TCustomConfig['turnstile'] | undefined)?.siteKey,
    options: Object.keys(options).length > 0 ? options : undefined,
  });

  const enabled = Boolean(loadedTurnstile.siteKey);

  if (enabled) {
    logger.debug(
      'Turnstile is ENABLED with configuration:\n' + JSON.stringify(loadedTurnstile, null, 2),
    );
  } else {
    logger.debug('Turnstile is DISABLED (no siteKey provided).');
  }

  return loadedTurnstile;
}
