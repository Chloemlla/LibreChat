import type { TStoredWidget } from 'librechat-data-provider';
import type { Response } from 'express';
import type { WidgetResultDbMethods, WidgetResultRequest } from './results';
import {
  createWidgetResultHandlers,
  parseWidgetResult,
  upsertWidgetResult,
  WIDGET_RESULTS_MAX_ENTRIES,
} from './results';
import { WIDGET_CODE_MAX_LENGTH, WIDGET_SPEC_MAX_LENGTH } from './validate';

const USER_ID = 'user-id';
const MESSAGE_ID = 'message-id';
const CONVERSATION_ID = '9c2f1d5e-8a4b-4c6d-9e0f-1a2b3c4d5e6f';
const SPEC = '**Objective:** plot the series';
const CODE = 'function Widget() { return <div>ok</div>; }';
const EXPIRY = new Date('2026-09-13T00:00:00.000Z');
const ENTRY: TStoredWidget = { spec: SPEC, endpoint: 'openAI', model: 'gpt-4o-mini', code: CODE };

const createRequest = (body: unknown = ENTRY, authenticated = true): WidgetResultRequest => {
  const user = { id: USER_ID, role: 'USER', tenantId: 'tenant-a' };
  const params = { messageId: MESSAGE_ID };
  return (
    authenticated ? { params, body, user } : { params, body }
  ) as unknown as WidgetResultRequest;
};

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { response: { status, json } as unknown as Response, status, json };
};

const createHandlers = () => {
  const getMessage = jest.fn();
  const saveMessage = jest.fn();
  const rejectSubagentWrite = jest.fn().mockResolvedValue(false);
  const db = { getMessage, saveMessage } as unknown as WidgetResultDbMethods;
  const handlers = createWidgetResultHandlers({ db, rejectSubagentWrite });
  return { getMessage, saveMessage, rejectSubagentWrite, handlers };
};

const entryFor = (model: string): TStoredWidget => ({ ...ENTRY, model });

const invalidBodies: ReadonlyArray<[string, unknown]> = [
  ['an absent body', undefined],
  ['a null body', null],
  ['a string body', SPEC],
  ['a body without a specification', { endpoint: 'openAI', model: 'gpt-4o-mini', code: CODE }],
  ['a body without an endpoint', { spec: SPEC, model: 'gpt-4o-mini', code: CODE }],
  ['a body without a model', { spec: SPEC, endpoint: 'openAI', code: CODE }],
  ['a body without code', { spec: SPEC, endpoint: 'openAI', model: 'gpt-4o-mini' }],
  ['an empty endpoint', { ...ENTRY, endpoint: '' }],
  ['a whitespace-only model', { ...ENTRY, model: '   ' }],
  ['a numeric code', { ...ENTRY, code: 42 }],
  ['an endpoint past its bound', { ...ENTRY, endpoint: 'a'.repeat(201) }],
  ['a model past its bound', { ...ENTRY, model: 'a'.repeat(201) }],
  ['a specification past its bound', { ...ENTRY, spec: 'a'.repeat(WIDGET_SPEC_MAX_LENGTH + 1) }],
  ['code past the compile bound', { ...ENTRY, code: 'a'.repeat(WIDGET_CODE_MAX_LENGTH + 1) }],
];

describe('parseWidgetResult', () => {
  it('accepts a complete entry', () => {
    expect(parseWidgetResult(ENTRY)).toEqual({ ok: true, value: ENTRY });
  });

  it('accepts a specification and code that sit exactly on the compile bounds', () => {
    const spec = 'a'.repeat(WIDGET_SPEC_MAX_LENGTH);
    const code = 'a'.repeat(WIDGET_CODE_MAX_LENGTH);

    expect(parseWidgetResult({ ...ENTRY, spec, code })).toEqual({
      ok: true,
      value: { ...ENTRY, spec, code },
    });
  });

  /** The client compares the entry it stored against the one the route returns. */
  it('keeps the values it was handed verbatim', () => {
    const padded = { ...ENTRY, spec: ` ${SPEC} `, endpoint: ' openAI ' };

    expect(parseWidgetResult(padded)).toEqual({ ok: true, value: padded });
  });

  it.each(invalidBodies)('refuses %s', (_label, body) => {
    expect(parseWidgetResult(body)).toEqual({ ok: false });
  });
});

describe('upsertWidgetResult', () => {
  it('appends the first entry', () => {
    expect(upsertWidgetResult([], ENTRY)).toEqual([ENTRY]);
  });

  it('keeps the oldest entry first and the newest last', () => {
    const list = upsertWidgetResult([entryFor('a')], entryFor('b'));

    expect(list.map((item) => item.model)).toEqual(['a', 'b']);
  });

  it('replaces the entry compiled from the same spec, endpoint and model', () => {
    const rewritten = { ...entryFor('a'), code: 'function Widget() { return null; }' };

    expect(upsertWidgetResult([entryFor('a')], rewritten)).toEqual([rewritten]);
  });

  /** The client restores the user's last choice from the tail of the list. */
  it('moves a rewritten entry to the end', () => {
    const rewritten = { ...entryFor('a'), code: 'function Widget() { return null; }' };
    const list = upsertWidgetResult([entryFor('a'), entryFor('b')], rewritten);

    expect(list.map((item) => item.model)).toEqual(['b', 'a']);
  });

  it('keeps a different specification on the same model as its own entry', () => {
    const list = upsertWidgetResult([{ ...entryFor('a'), spec: 'another spec' }], entryFor('a'));

    expect(list).toHaveLength(2);
  });

  it('drops the oldest entries once the cap is reached', () => {
    const models = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const list = models.reduce<TStoredWidget[]>(
      (acc, model) => upsertWidgetResult(acc, entryFor(model)),
      [],
    );

    expect(list).toHaveLength(WIDGET_RESULTS_MAX_ENTRIES);
    expect(list.map((item) => item.model)).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });
});

describe('createWidgetResultHandlers', () => {
  it('answers an unauthenticated read as unauthorized', async () => {
    const { getMessage, handlers } = createHandlers();
    const { response, status, json } = createResponse();

    await handlers.read(createRequest(ENTRY, false), response);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('answers an empty list for a message that never stored a card', async () => {
    const { getMessage, handlers } = createHandlers();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID });
    const { response, status, json } = createResponse();

    await handlers.read(createRequest(), response);

    expect(getMessage).toHaveBeenCalledWith({ user: USER_ID, messageId: MESSAGE_ID });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ widgets: [] });
  });

  it('returns the stored widgets oldest first', async () => {
    const { getMessage, handlers } = createHandlers();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID, widgets: [ENTRY] });
    const { response, json } = createResponse();

    await handlers.read(createRequest(), response);

    expect(json).toHaveBeenCalledWith({ widgets: [ENTRY] });
  });

  it('answers not found for a message this user does not own', async () => {
    const { getMessage, handlers } = createHandlers();
    getMessage.mockResolvedValue(null);
    const { response, status, json } = createResponse();

    await handlers.read(createRequest(), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Message not found' });
  });

  it('reports a failed read as an internal error', async () => {
    const { getMessage, handlers } = createHandlers();
    getMessage.mockRejectedValue(new Error('read failed'));
    const { response, status } = createResponse();

    await handlers.read(createRequest(), response);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('refuses an invalid body before reading the message', async () => {
    const { getMessage, saveMessage, handlers } = createHandlers();
    const { response, status, json } = createResponse();

    await handlers.write(createRequest({ spec: SPEC }), response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid widget result' });
    expect(getMessage).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('answers not found without writing when the message is gone', async () => {
    const { getMessage, saveMessage, handlers } = createHandlers();
    getMessage.mockResolvedValue(null);
    const { response, status } = createResponse();

    await handlers.write(createRequest(), response);

    expect(status).toHaveBeenCalledWith(404);
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('stores the entry and answers with the full list', async () => {
    const { getMessage, saveMessage, handlers } = createHandlers();
    getMessage.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      isTemporary: true,
      expiredAt: EXPIRY,
      widgets: [entryFor('a')],
    });
    saveMessage.mockResolvedValue({ messageId: MESSAGE_ID });
    const { response, status, json } = createResponse();

    await handlers.write(createRequest(), response);

    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, isTemporary: true, expiredAt: EXPIRY }),
      {
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        user: USER_ID,
        widgets: [entryFor('a'), ENTRY],
      },
      { context: 'POST /api/messages/widgets/:messageId' },
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ widgets: [entryFor('a'), ENTRY] });
  });

  it('leaves the answer to the subagent guard, without writing', async () => {
    const { getMessage, saveMessage, rejectSubagentWrite, handlers } = createHandlers();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID });
    rejectSubagentWrite.mockResolvedValue(true);
    const { response, status } = createResponse();

    await handlers.write(createRequest(), response);

    expect(rejectSubagentWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      CONVERSATION_ID,
    );
    expect(saveMessage).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('reports an entry that was not stored', async () => {
    const { getMessage, saveMessage, handlers } = createHandlers();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID });
    saveMessage.mockResolvedValue(null);
    const { response, status } = createResponse();

    await handlers.write(createRequest(), response);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('reports a failed write as an internal error', async () => {
    const { getMessage, saveMessage, handlers } = createHandlers();
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID });
    saveMessage.mockRejectedValue(new Error('write failed'));
    const { response, status } = createResponse();

    await handlers.write(createRequest(), response);

    expect(status).toHaveBeenCalledWith(500);
  });
});
