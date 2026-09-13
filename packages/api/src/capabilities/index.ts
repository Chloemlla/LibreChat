import { logger } from '@librechat/data-schemas';
import { BASE_SYSTEM_CAPABILITIES } from 'librechat-data-provider';
import type { BaseSystemCapability } from 'librechat-data-provider';
import type { Response } from 'express';
import type { CapabilityUser, GetHeldCapabilitiesFn } from '~/middleware/capabilities';
import type { ServerRequest } from '~/types';

export interface CapabilityListingDeps {
  getHeldCapabilities: GetHeldCapabilitiesFn;
}

/**
 * Reads back the base capabilities a user holds.
 *
 * The capability store already expands the manage→read implication hierarchy,
 * so this only narrows the answer to the base set — derived capabilities
 * (section-scoped config grants, config assignment) are not reported here.
 */
export function listBaseCapabilities({
  getHeldCapabilities,
}: CapabilityListingDeps): (user: CapabilityUser) => Promise<BaseSystemCapability[]> {
  return async (user) => {
    const held = await getHeldCapabilities(user, BASE_SYSTEM_CAPABILITIES);
    return BASE_SYSTEM_CAPABILITIES.filter((capability) => held.has(capability));
  };
}

export interface UserCapabilitiesHandlerDeps {
  listCapabilities: (user: CapabilityUser) => Promise<BaseSystemCapability[]>;
}

/** Answers the caller's own capabilities — reachable without any capability of its own. */
export function createUserCapabilitiesHandler({
  listCapabilities,
}: UserCapabilitiesHandlerDeps): (req: ServerRequest, res: Response) => Promise<void> {
  return async (req, res) => {
    if (req.user == null) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const user: CapabilityUser = {
      id: req.user.id,
      role: req.user.role ?? '',
      tenantId: req.user.tenantId,
      idOnTheSource: req.user.idOnTheSource ?? null,
    };

    try {
      const capabilities = await listCapabilities(user);
      res.status(200).json({ capabilities });
    } catch (error) {
      logger.error('[UserCapabilities] Failed to resolve held capabilities', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
