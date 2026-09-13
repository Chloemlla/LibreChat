import { logger } from '@librechat/data-schemas';
import type { TStoredWidget } from 'librechat-data-provider';
import type { EndpointDbMethods, ServerRequest } from '~/types';
import type { WidgetResultDbMethods } from './results';
import { validateWidgetCode, widgetRejectionMessage } from './validate';
import { generateWidgetCode } from './generate';
import { storeWidgetEntry } from './results';

/** What a compile that reached the provider but produced nothing usable reads as. */
const WIDGET_COMPILE_FAILED_ERROR = 'The widget could not be compiled';

/** The two database surfaces a compile needs: the provider credentials the
 *  compile call reads, and the message methods that settle the entry. */
export interface WidgetCompileDbMethods extends EndpointDbMethods, WidgetResultDbMethods {}

export interface WidgetCompileJobParams {
  /** The request that started the compile, held for its config and its user. */
  req: ServerRequest;
  messageId: string;
  userId: string;
  spec: string;
  endpoint: string;
  model: string;
  db: WidgetCompileDbMethods;
  /** When the entry was first written as `pending`. Carried through rather than
   *  re-read, so the staleness rule measures the compile and not the settle. */
  startedAt: number;
  /** The compile call; injectable so the job is testable at the provider boundary. */
  generate?: typeof generateWidgetCode;
}

/**
 * Runs one compile to completion in the background. It returns as soon as the
 * work is scheduled: the request that started it has already been answered, and
 * the client learns the outcome by polling the message's stored results.
 *
 * The job holds the request after its response is sent. That is deliberate — the
 * call is bounded by the `AbortSignal.timeout` inside `generateWidgetCode`, and
 * the job only ever reads the request, never the response.
 */
export function runWidgetCompile(params: WidgetCompileJobParams): void {
  void settleWidgetCompile(params);
}

/**
 * The compile body, which must never reject: nothing awaits it, so a rejection
 * would surface as an unhandled rejection rather than as a failed card.
 */
async function settleWidgetCompile(params: WidgetCompileJobParams): Promise<void> {
  const { req, messageId, userId, spec, endpoint, model, db, startedAt } = params;
  const generate = params.generate ?? generateWidgetCode;

  /** Writes the settled entry. There is nobody left to answer, so a store that
   *  fails is logged here and the entry is left for the staleness rule. */
  const settle = async (entry: TStoredWidget): Promise<void> => {
    try {
      /** Re-read rather than rewrite the copy the request loaded: the compile ran
       *  for minutes, and the array another card on this message wrote in that
       *  time would be dropped by settling from a snapshot taken before it. */
      const current = await db.getMessage({ user: userId, messageId });
      if (current == null) {
        logger.warn(`[widgets] Message ${messageId} is gone; the compile was not stored`);
        return;
      }
      await storeWidgetEntry({ db, req, userId, messageId, message: current, entry });
    } catch (error) {
      logger.error(`[widgets] Failed to store the compiled widget for ${messageId}`, error);
    }
  };

  try {
    let code: string;
    try {
      code = await generate({ req, endpoint, model, spec, db });
    } catch (error) {
      logger.error(`[widgets] Compile call failed (endpoint: ${endpoint})`, error);
      await settle({
        spec,
        endpoint,
        model,
        status: 'failed',
        error: WIDGET_COMPILE_FAILED_ERROR,
        startedAt,
      });
      return;
    }
    const validated = validateWidgetCode(code);
    if (!validated.ok) {
      const detail = validated.detail == null ? '' : `: ${validated.detail}`;
      logger.warn(
        `[widgets] Rejected compiled code (${validated.rejection}${detail}) from ${endpoint}`,
      );
      await settle({
        spec,
        endpoint,
        model,
        status: 'failed',
        error: widgetRejectionMessage(validated.rejection),
        startedAt,
      });
      return;
    }
    await settle({ spec, endpoint, model, status: 'ready', code: validated.code, startedAt });
  } catch (error) {
    logger.error(`[widgets] Widget compile failed (endpoint: ${endpoint})`, error);
  }
}
