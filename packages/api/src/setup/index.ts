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
