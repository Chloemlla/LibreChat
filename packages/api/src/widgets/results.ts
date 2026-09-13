import { logger } from '@librechat/data-schemas';
import { WIDGET_COMPILE_TIMEOUT_HARD_MAX_MS } from 'librechat-data-provider';
import type {
  TStoredWidget,
  TWidgetCompileStatus,
  TWidgetResultsResponse,
} from 'librechat-data-provider';
import type { MessageMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

/**
 * Per-message storage guard, not an operator knob: it bounds how many compiled
 * cards one message carries, not how the feature behaves.
 */
export const WIDGET_RESULTS_MAX_ENTRIES = 8;

/**
 * How long a `pending` entry may stand before it is read as a failure. No
 * compile can outlive the protocol's hard ceiling, so one older than this
 * cannot still be running — it was orphaned by a process restart mid-compile,
 * and reporting it as failed lets the user retry instead of watching a card
 * that will never settle.
 */
export const WIDGET_PENDING_STALE_MS: number = WIDGET_COMPILE_TIMEOUT_HARD_MAX_MS + 60_000;

/** What a `pending` entry orphaned by a restart reads as. */
const WIDGET_ORPHANED_COMPILE_ERROR =
  'The compilation did not finish. Generate the card again to retry.';

/** The only path that writes the array, so an entry that settles late still has
 *  a context naming the request that started it. */
const WIDGET_STORE_CONTEXT = 'POST /api/widgets/generate';

export type WidgetResultRequest = ServerRequest & { params: { messageId: string } };

export type WidgetResultHandler = (req: WidgetResultRequest, res: Response) => Promise<void>;

/** The message fields these routes read; every other field is left to `saveMessage`. */
export interface StoredWidgetMessage {
  conversationId: string;
  isTemporary?: boolean;
  expiredAt?: Date | null;
  widgets?: TStoredWidget[];
}

/** A message the caller has proved belongs to the requesting user. */
export interface OwnedMessage {
  userId: string;
  message: StoredWidgetMessage;
}

export interface WidgetResultDbMethods {
  getMessage: MessageMethods['getMessage'];
  saveMessage: MessageMethods['saveMessage'];
}

export interface WidgetResultDeps {
  db: WidgetResultDbMethods;
}

export interface WidgetResultHandlers {
  read: WidgetResultHandler;
}

export interface StoreWidgetEntryParams {
  db: WidgetResultDbMethods;
  req: ServerRequest;
  userId: string;
  messageId: string;
  message: StoredWidgetMessage;
  entry: TStoredWidget;
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

/**
 * Derives the entry a reader should see from the one that was stored. An entry
 * written before the compile became asynchronous carries its compiled code and
 * no status, so it is a finished compile; a `pending` entry that outlived the
 * protocol ceiling was orphaned by a restart and is reported as a failure the
 * user can retry. Everything else is already what it claims to be.
 */
export function normalizeStoredWidget(entry: TStoredWidget): TStoredWidget {
  const status: TWidgetCompileStatus | undefined = entry.status;
  if (status == null) {
    return { ...entry, status: 'ready', startedAt: 0 };
  }
  if (status !== 'pending') {
    return entry;
  }
  /** An unreadable start time leaves the entry no age at all, so it is treated
   *  as orphaned rather than left pending forever. */
  const elapsedMs = Date.now() - entry.startedAt;
  if (Number.isFinite(elapsedMs) && elapsedMs <= WIDGET_PENDING_STALE_MS) {
    return entry;
  }
  return {
    ...entry,
    status: 'failed',
    code: undefined,
    error: WIDGET_ORPHANED_COMPILE_ERROR,
  };
}

export function normalizeStoredWidgets(widgets: readonly TStoredWidget[]): TStoredWidget[] {
  return widgets.map(normalizeStoredWidget);
}

/**
 * Loads a message the requesting user owns, answering the request itself when
 * it does not. The message id is a parameter rather than a route parameter
 * because the compile request carries it in the body.
 */
export async function loadOwnedMessage(
  req: ServerRequest,
  res: Response,
  db: WidgetResultDbMethods,
  messageId: string,
): Promise<OwnedMessage | undefined> {
  const userId = req.user?.id;
  if (userId == null) {
    res.status(401).json({ error: 'Authentication required' });
    return undefined;
  }
  const message = await db.getMessage({ user: userId, messageId });
  if (message == null) {
    res.status(404).json({ error: 'Message not found' });
    return undefined;
  }
  return { userId, message };
}

/**
 * The single place the `widgets` array is written. Existing entries are
 * normalized first, so rewriting the array upgrades a legacy entry instead of
 * persisting it in the shape that predates the status field.
 */
export async function storeWidgetEntry({
  db,
  req,
  userId,
  messageId,
  message,
  entry,
}: StoreWidgetEntryParams): Promise<boolean> {
  const widgets = upsertWidgetResult(normalizeStoredWidgets(message.widgets ?? []), entry);
  const saved = await db.saveMessage(
    {
      userId,
      isTemporary: message.isTemporary,
      expiredAt: message.expiredAt ?? undefined,
      interfaceConfig: req.config?.interfaceConfig,
    },
    {
      messageId,
      conversationId: message.conversationId,
      user: userId,
      widgets,
    },
    { context: WIDGET_STORE_CONTEXT },
  );
  if (saved == null) {
    logger.warn(`[widgets] Message ${messageId} was not stored`);
    return false;
  }
  return true;
}

export function createWidgetResultHandlers({ db }: WidgetResultDeps): WidgetResultHandlers {
  const read: WidgetResultHandler = async (req, res) => {
    try {
      const owned = await loadOwnedMessage(req, res, db, req.params.messageId);
      if (owned == null) {
        return;
      }
      const body: TWidgetResultsResponse = {
        widgets: normalizeStoredWidgets(owned.message.widgets ?? []),
      };
      res.status(200).json(body);
    } catch (error) {
      logger.error('[widgets] Failed to read stored widget results', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  return { read };
}
