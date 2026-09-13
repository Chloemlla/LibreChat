import { resolveModelCatalogKey } from 'librechat-data-provider';
import type { TEndpointsConfig, TModelsConfig } from 'librechat-data-provider';

/** Longest identifier accepted as a model name; past this it is not one. */
export const MAX_MODEL_STRING_LENGTH = 256;

/**
 * A model identifier is opaque to this server, but it is echoed into logs and
 * handed to a provider, so it is held to a URL-safe, log-safe charset.
 */
export const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$/;

/** Why a model was refused, and the wording both enforcers report it with. */
export type ModelRejection =
  | 'model_missing'
  | 'model_malformed'
  | 'models_not_loaded'
  | 'endpoint_models_not_loaded'
  | 'model_not_offered';

const REJECTION_MESSAGES: Record<ModelRejection, string> = {
  model_missing: 'Model not provided',
  model_malformed: 'Invalid model identifier',
  models_not_loaded: 'Models not loaded',
  endpoint_models_not_loaded: 'Endpoint models not loaded',
  model_not_offered: 'Illegal model request',
};

/** A refusal the client cannot fix by retrying is a client error, not a 500. */
const REJECTION_STATUSES: Record<ModelRejection, number> = {
  model_missing: 400,
  model_malformed: 400,
  models_not_loaded: 503,
  endpoint_models_not_loaded: 503,
  model_not_offered: 403,
};

export type ModelAccessResult =
  | { ok: true; model: string }
  | { ok: false; rejection: ModelRejection };

export interface ModelAccessParams {
  endpoint?: string | null;
  model?: unknown;
  getEndpointsConfig: () => Promise<TEndpointsConfig>;
  getModelsConfig: () => Promise<TModelsConfig | null | undefined>;
}

export function modelRejectionMessage(rejection: ModelRejection): string {
  return REJECTION_MESSAGES[rejection];
}

export function modelRejectionStatus(rejection: ModelRejection): number {
  return REJECTION_STATUSES[rejection];
}

/**
 * Decides whether a request may use the model it named.
 *
 * Two guards enforce this — the chat middleware, which answers over SSE, and
 * the widget compile endpoint, which answers JSON — and they resolve their
 * config from the same app singletons but must not diverge on the rule, so the
 * rule lives here and the lookups arrive as callbacks. They are called in order
 * and only as far as the decision reaches: an endpoint the user supplies
 * credentials for skips the catalog read entirely.
 */
export async function checkModelAccess({
  endpoint,
  model: raw,
  getEndpointsConfig,
  getModelsConfig,
}: ModelAccessParams): Promise<ModelAccessResult> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, rejection: 'model_missing' };
  }

  const model = raw.trim();
  if (model.length === 0 || model.length > MAX_MODEL_STRING_LENGTH || !MODEL_PATTERN.test(model)) {
    return { ok: false, rejection: 'model_malformed' };
  }

  const endpointsConfig = await getEndpointsConfig();
  if (endpointsConfig?.[endpoint ?? '']?.userProvide) {
    return { ok: true, model };
  }

  const modelsConfig = await getModelsConfig();
  if (!modelsConfig) {
    return { ok: false, rejection: 'models_not_loaded' };
  }

  const offered = modelsConfig[resolveModelCatalogKey(endpoint, modelsConfig)];
  if (!offered) {
    return { ok: false, rejection: 'endpoint_models_not_loaded' };
  }

  if (!offered.includes(model)) {
    return { ok: false, rejection: 'model_not_offered' };
  }

  return { ok: true, model };
}
