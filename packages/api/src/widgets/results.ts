import { logger } from '@librechat/data-schemas';
import type { TStoredWidget, TWidgetResultsResponse } from 'librechat-data-provider';
import type { MessageMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { WIDGET_CODE_MAX_LENGTH, WIDGET_SPEC_MAX_LENGTH } from './validate';

/**
 * Per-message storage guard, not an operator knob: it bounds how many compiled
 * cards one message carries, not how the feature behaves.
 */
export const WIDGET_RESULTS_MAX_ENTRIES = 8;

const WIDGET_RESULT_ENDPOINT_MAX_LENGTH = 200;
const WIDGET_RESULT_MODEL_MAX_LENGTH = 200;

export type WidgetResultRequest = ServerRequest & { params: { messageId: string } };

export type WidgetResultHandler = (req: WidgetResultRequest, res: Response) => Promise<void>;

export type WidgetResultParse = { ok: true; value: TStoredWidget } | { ok: false };

interface WidgetResultBody {
  spec?: unknown;
  endpoint?: unknown;
  model?: unknown;
  code?: unknown;
}

/** The message fields these routes read; every other field is left to `saveMessage`. */
interface StoredWidgetMessage {
  conversationId: string;
  isTemporary?: boolean;
  expiredAt?: Date | null;
  widgets?: TStoredWidget[];
}

interface OwnedMessage {
  userId: string;
  message: StoredWidgetMessage;
}

export interface WidgetResultDbMethods {
  getMessage: MessageMethods['getMessage'];
  saveMessage: MessageMethods['saveMessage'];
}

export interface WidgetResultDeps {
  db: WidgetResultDbMethods;
  /** The route's subagent guard; it answers the request itself when the thread is read-only. */
  rejectSubagentWrite: (
    req: WidgetResultRequest,
    res: Response,
    conversationId: string,
  ) => Promise<boolean>;
}

export interface WidgetResultHandlers {
  read: WidgetResultHandler;
  write: WidgetResultHandler;
}

/**
 * Refuses a blank field or one past the bound; the value itself is kept
 * verbatim, so the entry the client stored comes back identical.
 */
function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value;
}

/**
 * Accepts only a body that already carries all four fields. The stored entry is
 * what the compile call produced, so a partial or oversized body is refused
 * rather than repaired.
 */
export function parseWidgetResult(raw: unknown): WidgetResultParse {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false };
  }
  const body = raw as WidgetResultBody;
  const spec = boundedString(body.spec, WIDGET_SPEC_MAX_LENGTH);
  const endpoint = boundedString(body.endpoint, WIDGET_RESULT_ENDPOINT_MAX_LENGTH);
  const model = boundedString(body.model, WIDGET_RESULT_MODEL_MAX_LENGTH);
  const code = boundedString(body.code, WIDGET_CODE_MAX_LENGTH);
  if (spec == null || endpoint == null || model == null || code == null) {
    return { ok: false };
  }
  return { ok: true, value: { spec, endpoint, model, code } };
}

/** Same entry when compiled from the same spec on the same endpoint and model. */
export function sameWidgetResult(entry: TStoredWidget, other: TStoredWidget): boolean {
  return (
    entry.spec === other.spec && entry.endpoint === other.endpoint && entry.model === other.model
  );
}

/**
 * Replaces the entry for a spec/endpoint/model already stored and appends it, so
 * the list reads oldest-first and its tail is the user's most recent choice; the
 * oldest entries fall off once the list is over the cap.
 */
export function upsertWidgetResult(
  existing: readonly TStoredWidget[],
  entry: TStoredWidget,
): TStoredWidget[] {
  const kept = existing.filter((item) => !sameWidgetResult(item, entry));
  return [...kept, entry].slice(-WIDGET_RESULTS_MAX_ENTRIES);
}

async function loadOwnedMessage(
  req: WidgetResultRequest,
  res: Response,
  db: WidgetResultDbMethods,
): Promise<OwnedMessage | undefined> {
  const userId = req.user?.id;
  if (userId == null) {
    res.status(401).json({ error: 'Authentication required' });
    return undefined;
  }
  const message = await db.getMessage({ user: userId, messageId: req.params.messageId });
  if (message == null) {
    res.status(404).json({ error: 'Message not found' });
    return undefined;
  }
  return { userId, message };
}

export function createWidgetResultHandlers({
  db,
  rejectSubagentWrite,
}: WidgetResultDeps): WidgetResultHandlers {
  const read: WidgetResultHandler = async (req, res) => {
    try {
      const owned = await loadOwnedMessage(req, res, db);
      if (owned == null) {
        return;
      }
      const body: TWidgetResultsResponse = { widgets: owned.message.widgets ?? [] };
      res.status(200).json(body);
    } catch (error) {
      logger.error('[widgets] Failed to read stored widget results', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  const write: WidgetResultHandler = async (req, res) => {
    try {
      const parsed = parseWidgetResult(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: 'Invalid widget result' });
        return;
      }
      const owned = await loadOwnedMessage(req, res, db);
      if (owned == null) {
        return;
      }
      const { userId, message } = owned;
      if (await rejectSubagentWrite(req, res, message.conversationId)) {
        return;
      }
      const widgets = upsertWidgetResult(message.widgets ?? [], parsed.value);
      const saved = await db.saveMessage(
        {
          userId,
          isTemporary: message.isTemporary,
          expiredAt: message.expiredAt ?? undefined,
          interfaceConfig: req.config?.interfaceConfig,
        },
        {
          messageId: req.params.messageId,
          conversationId: message.conversationId,
          user: userId,
          widgets,
        },
        { context: 'POST /api/messages/widgets/:messageId' },
      );
      if (saved == null) {
        logger.warn(`[widgets] Message ${req.params.messageId} was not stored`);
        res.status(500).json({ error: 'Failed to store widget result' });
        return;
      }
      const body: TWidgetResultsResponse = { widgets };
      res.status(200).json(body);
    } catch (error) {
      logger.error('[widgets] Failed to store widget result', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  return { read, write };
}
