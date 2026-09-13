import { logger } from '@librechat/data-schemas';
import type { TStoredWidget, TWidgetGenerateResponse } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import type { WidgetCompileDbMethods, WidgetCompileJobParams } from './job';
import {
  loadOwnedMessage,
  normalizeStoredWidgets,
  storeWidgetEntry,
  upsertWidgetResult,
} from './results';
import { parseWidgetGenerateRequest, widgetRejectionMessage } from './validate';
import { generateWidgetCode } from './generate';
import { runWidgetCompile } from './job';

export type WidgetGenerateHandler = (req: ServerRequest, res: Response) => Promise<void>;

export type WidgetCompileJob = (params: WidgetCompileJobParams) => void;

/** The route passes `~/models`, which carries both the provider-credential and
 *  the message-storage methods this path needs. */
export type WidgetGenerateDbMethods = WidgetCompileDbMethods;

export interface WidgetGenerateHandlerDeps {
  db: WidgetGenerateDbMethods;
  /** The compile call; injectable so the handler is testable at the provider boundary. */
  generate?: typeof generateWidgetCode;
  /** The detached compile; injectable so the handler is testable without one. */
  job?: WidgetCompileJob;
}

/**
 * Starts one `widgetSpec.prompt` compile and answers as soon as the pending
 * entry is stored.
 *
 * The compile itself is detached: a non-streaming codegen call outlives what a
 * reverse proxy will hold a request open, so the request only records that a
 * compile is running and the client polls the message's results for the outcome.
 *
 * Two start requests for the same spec, endpoint and model both write `pending`
 * and both run a compile; whichever settles last wins. That is a duplicate
 * compile rather than a corrupted record, and the client cannot normally issue
 * it — the regenerate control is disabled while a compile is in flight.
 *
 * Model authorization has already happened by the time this runs — the route
 * mounts `validateModel`, which trims `req.body.model` in place and rejects a
 * model the endpoint does not offer — so the body is read here, afterwards.
 */
export function createWidgetGenerateHandler({
  db,
  generate = generateWidgetCode,
  job = runWidgetCompile,
}: WidgetGenerateHandlerDeps): WidgetGenerateHandler {
  return async (req, res) => {
    if (req.user == null) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const parsed = parseWidgetGenerateRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: widgetRejectionMessage(parsed.rejection) });
      return;
    }
    const { messageId, endpoint, model, spec } = parsed.value;
    const startedAt = Date.now();
    const entry: TStoredWidget = { spec, endpoint, model, status: 'pending', startedAt };
    let pending: WidgetCompileJobParams;
    try {
      /** Loading the message this way is also what authorizes the write: the
       *  compile is stored against a message the caller owns, exactly as the
       *  results route checks before reading one back. */
      const owned = await loadOwnedMessage(req, res, db, messageId);
      if (owned == null) {
        return;
      }
      const { userId, message } = owned;
      /** A compile whose outcome cannot be recorded is pure waste, so the job
       *  only starts once the pending entry is on the message. */
      const stored = await storeWidgetEntry({ db, req, userId, messageId, message, entry });
      if (!stored) {
        res.status(500).json({ error: 'Failed to store widget result' });
        return;
      }
      const body: TWidgetGenerateResponse = {
        widgets: upsertWidgetResult(normalizeStoredWidgets(message.widgets ?? []), entry),
      };
      res.status(202).json(body);
      pending = { req, messageId, userId, spec, endpoint, model, db, generate, startedAt };
    } catch (error) {
      logger.error('[widgets] Failed to start a widget compile', error);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    /** Started only once the response is on the wire, so the client is
     *  unblocked no matter how long the compile runs. */
    job(pending);
  };
}
