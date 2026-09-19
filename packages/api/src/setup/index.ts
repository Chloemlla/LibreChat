import { logger } from '@librechat/data-schemas';
import { SystemRoles } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

/** Credentials the first-run page submits; the register schema validates them. */
export interface SetupAccountInput {
  email?: string;
  name?: string;
  username?: string | null;
  password?: string;
  confirm_password?: string;
}

export interface SetupRegistrationResult {
  status: number;
  message: string;
  userCreated?: boolean;
}

export interface SetupDeps {
  /** Accounts currently holding the administrator role. */
  countAdmins: () => Promise<number>;
  /** Registration path, injected so the bootstrap reuses its validation and hashing. */
  registerUser: (
    user: SetupAccountInput,
    additionalData: { role: string; emailVerified: boolean },
  ) => Promise<SetupRegistrationResult>;
  /** Tenant the request resolved to, when the deployment is multi-tenant. */
  getTenantId: () => string | undefined;
}

export interface SetupHandlers {
  getSetupStatus: (req: ServerRequest, res: Response) => Promise<void>;
  initialize: (req: ServerRequest, res: Response) => Promise<void>;
}

export interface SetupAnnouncementDeps {
  /** Counts accounts holding a role; the deployment's own role list is the caller's to read. */
  countUsersByRole: (roleName: string) => Promise<number>;
  /** Public origin the deployment is served from, when the operator configured one. */
  domainClient?: string;
  /** Address the process actually bound to, used when no public origin is configured. */
  fallbackOrigin: string;
}

/**
 * The line an operator needs at boot while nothing can administer the deployment yet, or `null`
 * once an administrator exists.
 *
 * A deployment can be listening, healthy and completely unadministrable at the same time — every
 * other startup log reads normally — so the one state that needs a human gets its own message
 * carrying the page that resolves it. Failures are logged and swallowed: an announcement must
 * never be the reason a server refuses to boot.
 */
export async function describeSetupRequirement({
  countUsersByRole,
  domainClient,
  fallbackOrigin,
}: SetupAnnouncementDeps): Promise<string | null> {
  try {
    if ((await countUsersByRole(SystemRoles.ADMIN)) > 0) {
      return null;
    }
  } catch (error) {
    logger.error('[Setup] Unable to read the initialization state at boot', error);
    return null;
  }

  const origin = (domainClient || fallbackOrigin).replace(/\/+$/, '');
  return (
    '[Setup] This deployment has no administrator account yet. ' +
    `Open ${origin}/setup to create the first administrator.`
  );
}

/**
 * A deployment is uninitialized for exactly as long as no account holds the administrator role.
 *
 * Counting administrators rather than users is what keeps a deployment reachable when its first
 * account arrives through a path that never grants the role: social login creates a plain user,
 * and the "first registered user becomes ADMIN" rule only runs on the local registration path.
 */
async function isUninitialized(countAdmins: () => Promise<number>): Promise<boolean> {
  return (await countAdmins()) === 0;
}

export function createSetupHandlers({
  countAdmins,
  registerUser,
  getTenantId,
}: SetupDeps): SetupHandlers {
  const getSetupStatus = async (_req: ServerRequest, res: Response): Promise<void> => {
    try {
      const tenantId = getTenantId();
      res.status(200).json({
        required: !tenantId && (await isUninitialized(countAdmins)),
      });
    } catch (error) {
      logger.error('[Setup] Unable to read the initialization state', error);
      res.status(500).json({ message: 'Unable to read the initialization state' });
    }
  };

  const initialize = async (req: ServerRequest, res: Response): Promise<void> => {
    try {
      if (getTenantId()) {
        res.status(403).json({ message: 'Tenant administrators are provisioned by the platform.' });
        return;
      }

      if (!(await isUninitialized(countAdmins))) {
        res.status(403).json({ message: 'This deployment already has an administrator.' });
        return;
      }

      const { email, name, username, password, confirm_password } = req.body as SetupAccountInput;

      const result = await registerUser(
        { email, name, username, password, confirm_password },
        { role: SystemRoles.ADMIN, emailVerified: true },
      );

      if (result.status !== 200 || result.userCreated !== true) {
        res.status(result.status === 200 ? 400 : result.status).json({ message: result.message });
        return;
      }

      logger.info(`[Setup] First administrator created [Email: ${email}]`);
      res.status(201).json({ message: 'Administrator created' });
    } catch (error) {
      logger.error('[Setup] Failed to create the first administrator', error);
      res.status(500).json({ message: 'Unable to initialize this deployment' });
    }
  };

  return { getSetupStatus, initialize };
}
