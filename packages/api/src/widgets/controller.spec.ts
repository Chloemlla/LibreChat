import type { TWidgetGenerateRequest } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest, EndpointDbMethods } from '~/types';
import { createWidgetGenerateHandler } from './controller';

const SPEC = '**Objective:** plot the series';
const COMPONENT = 'function Widget() { return <div>ok</div>; }';

const db: EndpointDbMethods = {
  getUserKey: jest.fn(),
  getUserKeyValues: jest.fn(),
};

const createRequest = (
  overrides: Partial<TWidgetGenerateRequest> = {},
  authenticated = true,
): ServerRequest => {
  const body = { endpoint: 'openAI', model: 'gpt-4o-mini', spec: SPEC, ...overrides };
  const user = { id: 'user-id', role: 'USER', tenantId: 'tenant-a' };
  return (
    authenticated ? { query: {}, body, user } : { query: {}, body }
  ) as unknown as ServerRequest;
};

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { response: { status, json } as unknown as Response, status, json };
};

const createHandler = (generate = jest.fn().mockResolvedValue(COMPONENT)) => ({
  generate,
  handler: createWidgetGenerateHandler({ db, generate }),
});

const invalidRequests: ReadonlyArray<[string, Partial<TWidgetGenerateRequest>]> = [
  ['an endpoint', { endpoint: '' }],
  ['a model', { model: '' }],
  ['a specification', { spec: '' }],
  ['a specification that is only whitespace', { spec: '   ' }],
  ['a specification past the bound', { spec: 'a'.repeat(16_001) }],
];

const unusableCode: ReadonlyArray<[string, string]> = [
  ['an empty component', ''],
  ['a component that imports', `import React from 'react';\n${COMPONENT}`],
  ['a component that reaches the network', 'function Widget() { fetch("/x"); }'],
  ['a component with no Widget', 'const Chart = () => null;'],
];

describe('createWidgetGenerateHandler', () => {
  it('refuses an unauthenticated request before any provider call', async () => {
    const { generate, handler } = createHandler();
    const { response, status, json } = createResponse();

    await handler(createRequest({}, false), response);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(invalidRequests)('refuses a request missing %s', async (_label, overrides) => {
    const { generate, handler } = createHandler();
    const { response, status } = createResponse();

    await handler(createRequest(overrides), response);

    expect(status).toHaveBeenCalledWith(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('compiles the specification and returns the component', async () => {
    const { generate, handler } = createHandler();
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'openAI',
        model: 'gpt-4o-mini',
        spec: SPEC,
        db,
      }),
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ code: COMPONENT });
  });

  /** `validateModel` rewrites `req.body.model` in place, so the handler has to
   *  read the body when it runs rather than capture it when it is built. */
  it('reads the model the authorization middleware left on the request', async () => {
    const { generate, handler } = createHandler();
    const { response } = createResponse();
    const req = createRequest();
    req.body.model = 'gpt-4o';

    await handler(req, response);

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
  });

  it('reports a failed compile call as a bad gateway', async () => {
    const { generate, handler } = createHandler();
    generate.mockRejectedValue(new Error('provider unavailable'));
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ error: 'The widget could not be compiled' });
  });

  it.each(unusableCode)('refuses %s the codegen returned', async (_label, code) => {
    const { generate, handler } = createHandler();
    generate.mockResolvedValue(code);
    const { response, status } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(502);
  });

  it('returns the unwrapped body when the model fenced its output', async () => {
    const { generate, handler } = createHandler();
    generate.mockResolvedValue(`\`\`\`jsx\n${COMPONENT}\n\`\`\``);
    const { response, json } = createResponse();

    await handler(createRequest(), response);

    expect(json).toHaveBeenCalledWith({ code: COMPONENT });
  });
});
