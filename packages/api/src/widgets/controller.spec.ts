import type { TStoredWidget, TWidgetGenerateRequest } from 'librechat-data-provider';
import type { Response } from 'express';
import type { WidgetGenerateDbMethods } from './controller';
import type { ServerRequest } from '~/types';
import { createWidgetGenerateHandler } from './controller';
import { WIDGET_MESSAGE_ID_MAX_LENGTH } from './validate';

const USER_ID = 'user-id';
const MESSAGE_ID = 'message-id';
const CONVERSATION_ID = '9c2f1d5e-8a4b-4c6d-9e0f-1a2b3c4d5e6f';
const SPEC = '**Objective:** plot the series';
const INTERFACE_CONFIG = { widgetCompileTimeoutMs: 90_000 };

/** The clock is frozen so the entry the handler writes is exactly assertable. */
const NOW = 1_700_000_000_000;

const PENDING: TStoredWidget = {
  spec: SPEC,
  endpoint: 'openAI',
  model: 'gpt-4o-mini',
  status: 'pending',
  startedAt: NOW,
};

const entryFor = (model: string): TStoredWidget => ({
  spec: SPEC,
  endpoint: 'openAI',
  model,
  status: 'ready',
  code: 'function Widget() { return <div>ok</div>; }',
  startedAt: 0,
});

const createRequest = (
  overrides: Partial<TWidgetGenerateRequest> = {},
  authenticated = true,
): ServerRequest => {
  const body = {
    messageId: MESSAGE_ID,
    endpoint: 'openAI',
    model: 'gpt-4o-mini',
    spec: SPEC,
    ...overrides,
  };
  const user = { id: USER_ID, role: 'USER', tenantId: 'tenant-a' };
  const config = { interfaceConfig: INTERFACE_CONFIG };
  return (
    authenticated ? { query: {}, body, user, config } : { query: {}, body, config }
  ) as unknown as ServerRequest;
};

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { response: { status, json } as unknown as Response, status, json };
};

const createHandler = (job = jest.fn()) => {
  const getMessage = jest.fn();
  const saveMessage = jest.fn();
  const generate = jest.fn();
  const db = {
    getUserKey: jest.fn(),
    getUserKeyValues: jest.fn(),
    getMessage,
    saveMessage,
  } as unknown as WidgetGenerateDbMethods;
  return {
    handler: createWidgetGenerateHandler({ db, generate, job }),
    job,
    generate,
    getMessage,
    saveMessage,
  };
};

const invalidRequests: ReadonlyArray<[string, Partial<TWidgetGenerateRequest>]> = [
  ['an endpoint', { endpoint: '' }],
  ['a model', { model: '' }],
  ['a specification', { spec: '' }],
  ['a specification that is only whitespace', { spec: '   ' }],
  ['a specification past the bound', { spec: 'a'.repeat(16_001) }],
  ['a message', { messageId: '' }],
  ['a message that is only whitespace', { messageId: '   ' }],
  ['a message past its bound', { messageId: 'a'.repeat(WIDGET_MESSAGE_ID_MAX_LENGTH + 1) }],
];

describe('createWidgetGenerateHandler', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  it('refuses an unauthenticated request before anything is read or started', async () => {
    const { handler, job, getMessage } = createHandler();
    const { response, status, json } = createResponse();

    await handler(createRequest({}, false), response);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(getMessage).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
  });

  it.each(invalidRequests)('refuses a request missing %s', async (_label, overrides) => {
    const { handler, job, getMessage, saveMessage } = createHandler();
    const { response, status } = createResponse();

    await handler(createRequest(overrides), response);

    expect(status).toHaveBeenCalledWith(400);
    expect(getMessage).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
  });

  it('names the missing message when the body carries none', async () => {
    const { handler } = createHandler();
    const { response, status, json } = createResponse();
    const req = createRequest();
    delete req.body.messageId;

    await handler(req, response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'A message is required to compile a widget' });
  });

  it('answers not found without compiling when the user does not own the message', async () => {
    const { handler, job, getMessage, saveMessage } = createHandler();
    getMessage.mockResolvedValue(null);
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(getMessage).toHaveBeenCalledWith({ user: USER_ID, messageId: MESSAGE_ID });
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Message not found' });
    expect(saveMessage).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
  });

  it('records the compile as pending and answers with the stored list', async () => {
    const { handler, getMessage, saveMessage } = createHandler();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID, widgets: [entryFor('a')] });
    saveMessage.mockResolvedValue({ messageId: MESSAGE_ID });
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, interfaceConfig: INTERFACE_CONFIG }),
      {
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        user: USER_ID,
        widgets: [entryFor('a'), PENDING],
      },
      { context: 'POST /api/widgets/generate' },
    );
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ widgets: [entryFor('a'), PENDING] });
  });

  /** The whole point of the change: nothing the client sent is left open while
   *  the compile runs, so the answer has to be on the wire before it starts. */
  it('answers the request before it starts the compile', async () => {
    const { handler, job, getMessage, saveMessage } = createHandler();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID });
    saveMessage.mockResolvedValue({ messageId: MESSAGE_ID });
    const { response, json } = createResponse();
    const answeredAtJob = jest.fn();
    job.mockImplementation(() => {
      answeredAtJob(json.mock.calls.length);
    });

    await handler(createRequest(), response);

    expect(answeredAtJob).toHaveBeenCalledWith(1);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('hands the compile to the job, carrying everything it needs to settle it', async () => {
    const { handler, job, generate, getMessage, saveMessage } = createHandler();
    const message = { conversationId: CONVERSATION_ID };
    getMessage.mockResolvedValue(message);
    saveMessage.mockResolvedValue({ messageId: MESSAGE_ID });
    const { response } = createResponse();
    const req = createRequest();

    await handler(req, response);

    expect(job).toHaveBeenCalledWith({
      req,
      messageId: MESSAGE_ID,
      userId: USER_ID,
      spec: SPEC,
      endpoint: 'openAI',
      model: 'gpt-4o-mini',
      db: expect.anything(),
      generate,
      startedAt: NOW,
    });
  });

  /** `validateModel` rewrites `req.body.model` in place, so the handler has to
   *  read the body when it runs rather than capture it when it is built. */
  it('reads the model the authorization middleware left on the request', async () => {
    const { handler, job, getMessage, saveMessage } = createHandler();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID });
    saveMessage.mockResolvedValue({ messageId: MESSAGE_ID });
    const { response } = createResponse();
    const req = createRequest();
    req.body.model = 'gpt-4o';

    await handler(req, response);

    expect(job).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
  });

  /** A compile whose outcome cannot be recorded is pure waste, so it never runs. */
  it('refuses to start a compile whose pending entry was not stored', async () => {
    const { handler, job, getMessage, saveMessage } = createHandler();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID });
    saveMessage.mockResolvedValue(null);
    const { response, status, json } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'Failed to store widget result' });
    expect(job).not.toHaveBeenCalled();
  });

  it('reports a failed message lookup as an internal error', async () => {
    const { handler, job, getMessage } = createHandler();
    getMessage.mockRejectedValue(new Error('read failed'));
    const { response, status } = createResponse();

    await handler(createRequest(), response);

    expect(status).toHaveBeenCalledWith(500);
    expect(job).not.toHaveBeenCalled();
  });
});
