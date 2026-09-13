import { SystemCapabilities, BASE_SYSTEM_CAPABILITIES } from 'librechat-data-provider';
import type { SystemCapability } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { ServerRequest } from '~/types';
import { listBaseCapabilities, createUserCapabilitiesHandler } from './index';

const USER: CapabilityUser = {
  id: 'user-id',
  role: 'USER',
  tenantId: 'tenant-a',
  idOnTheSource: null,
};

const createCapabilityStore = (held: SystemCapability[]) =>
  jest.fn(async (): Promise<Set<SystemCapability>> => new Set(held));

const createRequest = (user?: CapabilityUser): ServerRequest =>
  (user ? { user } : {}) as unknown as ServerRequest;

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { response: { status, json } as unknown as Response, status, json };
};

describe('listBaseCapabilities', () => {
  it('answers only the base capabilities the store reports as held', async () => {
    const getHeldCapabilities = createCapabilityStore([
      SystemCapabilities.MANAGE_PROMPTS,
      SystemCapabilities.READ_USERS,
    ]);
    const listCapabilities = listBaseCapabilities({ getHeldCapabilities });

    await expect(listCapabilities(USER)).resolves.toEqual([
      SystemCapabilities.READ_USERS,
      SystemCapabilities.MANAGE_PROMPTS,
    ]);
  });

  /** Asking for the base set is what lets the store expand manage→read before
   *  the answer is narrowed back down. */
  it('asks the store for the whole base set', async () => {
    const getHeldCapabilities = createCapabilityStore([]);
    const listCapabilities = listBaseCapabilities({ getHeldCapabilities });

    await listCapabilities(USER);

    expect(getHeldCapabilities).toHaveBeenCalledWith(USER, BASE_SYSTEM_CAPABILITIES);
  });

  it('drops anything that is not a base capability', async () => {
    const getHeldCapabilities = createCapabilityStore([
      SystemCapabilities.READ_USERS,
      'manage:configs:endpoints',
    ]);
    const listCapabilities = listBaseCapabilities({ getHeldCapabilities });

    await expect(listCapabilities(USER)).resolves.toEqual([SystemCapabilities.READ_USERS]);
  });
});

describe('createUserCapabilitiesHandler', () => {
  it('refuses an unauthenticated request without reading capabilities', async () => {
    const listCapabilities = jest.fn(async () => [SystemCapabilities.READ_USERS]);
    const handler = createUserCapabilitiesHandler({ listCapabilities });
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(listCapabilities).not.toHaveBeenCalled();
  });

  it('answers the capabilities held by the caller', async () => {
    const listCapabilities = jest.fn(async () => [SystemCapabilities.READ_USERS]);
    const handler = createUserCapabilitiesHandler({ listCapabilities });
    const { response, status, json } = createResponse();

    await handler(createRequest(USER), response);

    expect(listCapabilities).toHaveBeenCalledWith(USER);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ capabilities: [SystemCapabilities.READ_USERS] });
  });

  it('reports a failed lookup as an internal error without leaking it', async () => {
    const listCapabilities = jest.fn(async () => {
      throw new Error('read failed');
    });
    const handler = createUserCapabilitiesHandler({ listCapabilities });
    const { response, status, json } = createResponse();

    await handler(createRequest(USER), response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });
});
