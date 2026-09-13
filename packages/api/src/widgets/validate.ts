import type { TWidgetGenerateRequest } from 'librechat-data-provider';

/**
 * Upper bound on the model-written specification. A `widgetSpec.prompt` is a
 * few hundred words of prose and lists — under 4 KB in practice — so 16 KB
 * admits four times the largest useful spec while keeping a runaway or
 * injection-shaped body out of the codegen call.
 */
export const WIDGET_SPEC_MAX_LENGTH = 16_000;

/**
 * Upper bound on the compiled component. The compile call already caps
 * generated tokens; this bound is what stops an unexpectedly large body from
 * being handed to the sandbox iframe.
 */
export const WIDGET_CODE_MAX_LENGTH = 100_000;

/**
 * Upper bound on the message a compile is stored against. Message ids are
 * 24-character ObjectIds or generated UUIDs, so 200 admits every stored message
 * while keeping a runaway body out of the lookup and the write that follows it.
 */
export const WIDGET_MESSAGE_ID_MAX_LENGTH = 200;

/** Why a specification was refused. */
export type WidgetSpecRejection = 'spec_missing' | 'spec_empty' | 'spec_too_long';

/** Why a compiled component was refused. */
export type WidgetCodeRejection =
  | 'code_empty'
  | 'code_too_long'
  | 'code_forbidden'
  | 'code_missing_component';

/** Why a compile request was refused before any provider call. */
export type WidgetRequestRejection =
  | 'missing_endpoint'
  | 'missing_model'
  | 'missing_message_id'
  | WidgetSpecRejection;

export type WidgetRejection = WidgetRequestRejection | WidgetCodeRejection;

export type WidgetSpecResult =
  | { ok: true; spec: string }
  | { ok: false; rejection: WidgetSpecRejection };

export type WidgetCodeResult =
  | { ok: true; code: string }
  | { ok: false; rejection: WidgetCodeRejection; detail?: string };

export type WidgetRequestResult =
  | { ok: true; value: TWidgetGenerateRequest }
  | { ok: false; rejection: WidgetRequestRejection };

const REJECTION_MESSAGES: Record<WidgetRejection, string> = {
  missing_endpoint: 'An endpoint is required to compile a widget',
  missing_model: 'A model is required to compile a widget',
  missing_message_id: 'A message is required to compile a widget',
  spec_missing: 'A widget specification is required',
  spec_empty: 'The widget specification is empty',
  spec_too_long: 'The widget specification is too long',
  code_empty: 'The model returned no component',
  code_too_long: 'The generated component is too large',
  code_forbidden: 'The generated component uses a construct the sandbox forbids',
  code_missing_component: 'The generated component does not define a Widget component',
};

interface ForbiddenConstruct {
  pattern: RegExp;
  label: string;
}

/**
 * Constructs the sandbox contract forbids outright. Code that reaches for one
 * is a compile failure rather than something to sanitize silently: the frame
 * runs with `allow-scripts` only and `connect-src 'none'`, so an import or a
 * network call could not work even if it survived this check.
 */
const FORBIDDEN_CONSTRUCTS: readonly ForbiddenConstruct[] = [
  { pattern: /\bimport\b/, label: 'import' },
  { pattern: /\brequire\b/, label: 'require' },
  { pattern: /\bfetch\b/, label: 'fetch' },
  { pattern: /XMLHttpRequest/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
  { pattern: /<script/i, label: '<script' },
];

/** Shapes of a top-level `Widget` definition the model is asked to emit. */
const WIDGET_COMPONENT_PATTERNS: readonly RegExp[] = [
  /\bfunction\s+Widget\s*\(/,
  /\bclass\s+Widget\s+(?:extends\b|\{)/,
  /\b(?:const|let|var)\s+Widget\s*=/,
  /\bWidget\s*=\s*(?:function|\(|async\b)/,
];

const CODE_FENCE = /^```[^\n]*\r?\n([\s\S]*?)\r?\n?```$/;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Models habitually wrap code in a Markdown fence even when told not to;
 * unwrapping it here keeps that habit from failing an otherwise good card.
 * Every check below still runs on the unwrapped body.
 */
function stripCodeFence(code: string): string {
  const trimmed = code.trim();
  const match = CODE_FENCE.exec(trimmed);
  return match == null ? trimmed : match[1].trim();
}

export function widgetRejectionMessage(rejection: WidgetRejection): string {
  return REJECTION_MESSAGES[rejection];
}

export function validateWidgetSpec(raw: unknown): WidgetSpecResult {
  if (typeof raw !== 'string') {
    return { ok: false, rejection: 'spec_missing' };
  }
  const spec = raw.trim();
  if (spec.length === 0) {
    return { ok: false, rejection: 'spec_empty' };
  }
  if (spec.length > WIDGET_SPEC_MAX_LENGTH) {
    return { ok: false, rejection: 'spec_too_long' };
  }
  return { ok: true, spec };
}

export function findForbiddenConstruct(code: string): string | undefined {
  return FORBIDDEN_CONSTRUCTS.find(({ pattern }) => pattern.test(code))?.label;
}

export function definesWidgetComponent(code: string): boolean {
  return WIDGET_COMPONENT_PATTERNS.some((pattern) => pattern.test(code));
}

export function validateWidgetCode(raw: unknown): WidgetCodeResult {
  const code = stripCodeFence(typeof raw === 'string' ? raw : '');
  if (code.length === 0) {
    return { ok: false, rejection: 'code_empty' };
  }
  if (code.length > WIDGET_CODE_MAX_LENGTH) {
    return { ok: false, rejection: 'code_too_long' };
  }
  const forbidden = findForbiddenConstruct(code);
  if (forbidden != null) {
    return { ok: false, rejection: 'code_forbidden', detail: forbidden };
  }
  if (!definesWidgetComponent(code)) {
    return { ok: false, rejection: 'code_missing_component' };
  }
  return { ok: true, code };
}

/**
 * Reads the compile body after `validateModel` has run, so `model` here is the
 * value that middleware authorized — it trims `req.body.model` in place and the
 * trimmed string is the one the endpoint catalog was checked against. The
 * `messageId` names the message the result is stored against, so the caller can
 * load and authorize it before any provider call.
 */
export function parseWidgetGenerateRequest(
  raw: Partial<TWidgetGenerateRequest>,
): WidgetRequestResult {
  const endpoint = nonEmptyString(raw.endpoint);
  if (endpoint == null) {
    return { ok: false, rejection: 'missing_endpoint' };
  }
  const model = nonEmptyString(raw.model);
  if (model == null) {
    return { ok: false, rejection: 'missing_model' };
  }
  const spec = validateWidgetSpec(raw.spec);
  if (!spec.ok) {
    return { ok: false, rejection: spec.rejection };
  }
  const messageId = nonEmptyString(raw.messageId);
  if (messageId == null || messageId.length > WIDGET_MESSAGE_ID_MAX_LENGTH) {
    return { ok: false, rejection: 'missing_message_id' };
  }
  return { ok: true, value: { messageId, spec: spec.spec, endpoint, model } };
}
