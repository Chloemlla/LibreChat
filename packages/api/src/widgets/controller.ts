import { logger } from '@librechat/data-schemas';
import type { TWidgetGenerateResponse } from 'librechat-data-provider';
import type { Response } from 'express';
import type { EndpointDbMethods, ServerRequest } from '~/types';
import { parseWidgetGenerateRequest, validateWidgetCode, widgetRejectionMessage } from './validate';
import { generateWidgetCode } from './generate';

export type WidgetGenerateHandler = (req: ServerRequest, res: Response) => Promise<void>;

export interface WidgetGenerateHandlerDeps {
  /** Provider-credential lookups, supplied by the route rather than reached for. */
  db: EndpointDbMethods;
  /** The compile call; injectable so the handler is testable at the provider boundary. */
  generate?: typeof generateWidgetCode;
}

/**
 * Compiles one `widgetSpec.prompt` into a component body.
 *
 * Model authorization has already happened by the time this runs — the route
 * mounts `validateModel`, which trims `req.body.model` in place and rejects a
 * model the endpoint does not offer — so the body is read here, afterwards.
 */
export function createWidgetGenerateHandler({
  db,
  generate = generateWidgetCode,
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
    const { endpoint, model, spec } = parsed.value;
    let code: string;
    try {
      code = await generate({ req, endpoint, model, spec, db });
    } catch (error) {
      logger.error(`[widgets] Compile call failed (endpoint: ${endpoint})`, error);
      res.status(502).json({ error: 'The widget could not be compiled' });
      return;
    }
    const validated = validateWidgetCode(code);
    if (!validated.ok) {
      const detail = validated.detail == null ? '' : `: ${validated.detail}`;
      logger.warn(`[widgets] Rejected compiled code (${validated.rejection}${detail}) from ${endpoint}`);
      res.status(502).json({ error: widgetRejectionMessage(validated.rejection) });
      return;
    }
    const body: TWidgetGenerateResponse = { code: validated.code };
    res.status(200).json(body);
  };
}
