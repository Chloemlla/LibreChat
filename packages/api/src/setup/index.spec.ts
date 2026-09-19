import { SystemRoles } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import type { SetupAccountInput, SetupDeps, SetupHandlers, SetupRegistrationResult } from './index';
import { createSetupHandlers, describeSetupRequirement } from './index';

const ACCOUNT: SetupAccountInput = {
  email: 'root@example.com',
  name: 'Root',
  username: 'root',
  password: 'correct-horse',
  confirm_password: 'correct-horse',
};

const created = async (): Promise<SetupRegistrationResult> => ({
  status: 200,
  message: 'ok',
  userCreated: true,
});

const createRequest = (body: SetupAccountInput = ACCOUNT): ServerRequest =>
  ({ body }) as unknown as ServerRequest;

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { response: { status, json } as unknown as Response, status, json };
};

type RegisterUser = SetupDeps['registerUser'];

const createDeps = (overrides: {
  admins?: number;
  tenantId?: string;
  registerUser?: RegisterUser;
}): { registerUser: RegisterUser; handlers: SetupHandlers } => {
  const registerUser = overrides.registerUser ?? jest.fn(created);

  return {
    registerUser,
    handlers: createSetupHandlers({
      countAdmins: jest.fn(async () => overrides.admins ?? 0),
      registerUser,
      getTenantId: () => overrides.tenantId,
    }),
  };
};

describe('createSetupHandlers', () => {
  describe('getSetupStatus', () => {
    it('reports an uninitialized deployment as requiring setup', async () => {
      const { handlers } = createDeps({ admins: 0 });
      const { response, status, json } = createResponse();

      await handlers.getSetupStatus(createRequest(), response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ required: true });
    });

    it('reports a deployment that already has an administrator as initialized', async () => {
      const { handlers } = createDeps({ admins: 1 });
      const { response, status, json } = createResponse();

      await handlers.getSetupStatus(createRequest(), response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ required: false });
    });

    /** A tenant is provisioned by the platform, so its own page must never offer to
     *  create an administrator even while the platform has none. */
    it('reports a tenanted request as initialized', async () => {
      const { handlers } = createDeps({ admins: 0, tenantId: 'tenant-a' });
      const { response, json } = createResponse();

      await handlers.getSetupStatus(createRequest(), response);

      expect(json).toHaveBeenCalledWith({ required: false });
    });

    it('fails closed to a 500 when the administrator count cannot be read', async () => {
      const { response, status, json } = createResponse();
      const handlers = createSetupHandlers({
        countAdmins: jest.fn(async () => {
          throw new Error('mongo down');
        }),
        registerUser: jest.fn(created),
        getTenantId: () => undefined,
      });

      await handlers.getSetupStatus(createRequest(), response);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ message: 'Unable to read the initialization state' });
    });
  });

  describe('initialize', () => {
    it('registers the first account as an administrator', async () => {
      const { handlers, registerUser } = createDeps({ admins: 0 });
      const { response, status, json } = createResponse();

      await handlers.initialize(createRequest(), response);

      expect(registerUser).toHaveBeenCalledWith(ACCOUNT, {
        role: SystemRoles.ADMIN,
        emailVerified: true,
      });
      expect(status).toHaveBeenCalledWith(201);
      expect(json).toHaveBeenCalledWith({ message: 'Administrator created' });
    });

    it('refuses once an administrator exists', async () => {
      const { handlers, registerUser } = createDeps({ admins: 1 });
      const { response, status, json } = createResponse();

      await handlers.initialize(createRequest(), response);

      expect(registerUser).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({
        message: 'This deployment already has an administrator.',
      });
    });

    it('refuses a tenanted request', async () => {
      const { handlers, registerUser } = createDeps({ admins: 0, tenantId: 'tenant-a' });
      const { response, status } = createResponse();

      await handlers.initialize(createRequest(), response);

      expect(registerUser).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
    });

    /** The register path answers 200 for an email already in use, so `userCreated` is the
     *  only signal that distinguishes a created account from a no-op. */
    it('reports a registration that created nothing as a 400', async () => {
      const { handlers } = createDeps({
        admins: 0,
        registerUser: jest.fn(async () => ({ status: 200, message: 'generic' })),
      });
      const { response, status, json } = createResponse();

      await handlers.initialize(createRequest(), response);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ message: 'generic' });
    });

    it('forwards the status of a rejected registration', async () => {
      const { handlers } = createDeps({
        admins: 0,
        registerUser: jest.fn(async () => ({ status: 403, message: 'Email not allowed' })),
      });
      const { response, status } = createResponse();

      await handlers.initialize(createRequest(), response);

      expect(status).toHaveBeenCalledWith(403);
    });

    it('reports an unexpected failure as a 500', async () => {
      const { handlers } = createDeps({
        admins: 0,
        registerUser: jest.fn(async () => {
          throw new Error('bcrypt exploded');
        }),
      });
      const { response, status, json } = createResponse();

      await handlers.initialize(createRequest(), response);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ message: 'Unable to initialize this deployment' });
    });
  });

  describe('describeSetupRequirement', () => {
    it('says nothing once an administrator exists', async () => {
      const announcement = await describeSetupRequirement({
        countUsersByRole: jest.fn(async () => 1),
        fallbackOrigin: 'http://localhost:3080',
      });

      expect(announcement).toBeNull();
    });

    it('points an uninitialized deployment at its setup page', async () => {
      const announcement = await describeSetupRequirement({
        countUsersByRole: jest.fn(async () => 0),
        fallbackOrigin: 'http://localhost:3080',
      });

      expect(announcement).toContain('http://localhost:3080/setup');
    });

    it('prefers the configured public origin and drops its trailing slash', async () => {
      const announcement = await describeSetupRequirement({
        countUsersByRole: jest.fn(async () => 0),
        domainClient: 'https://chat.example.com/',
        fallbackOrigin: 'http://localhost:3080',
      });

      expect(announcement).toContain('https://chat.example.com/setup');
    });

    /** A boot announcement is not allowed to be the reason a server refuses to start. */
    it('stays silent when the administrator count cannot be read', async () => {
      const announcement = await describeSetupRequirement({
        countUsersByRole: jest.fn(async () => {
          throw new Error('mongo down');
        }),
        fallbackOrigin: 'http://localhost:3080',
      });

      expect(announcement).toBeNull();
    });
  });
});
