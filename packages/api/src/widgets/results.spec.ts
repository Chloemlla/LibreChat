import type { TStoredWidget, TWidgetResultsResponse } from 'librechat-data-provider';
import type { Response } from 'express';
import type { StoredWidgetMessage, WidgetResultDbMethods, WidgetResultRequest } from './results';
import type { ServerRequest } from '~/types';
import {
  createWidgetResultHandlers,
  normalizeStoredWidget,
  normalizeStoredWidgets,
  storeWidgetEntry,
  upsertWidgetResult,
  WIDGET_PENDING_STALE_MS,
  WIDGET_RESULTS_MAX_ENTRIES,
} from './results';

const USER_ID = 'user-id';
const MESSAGE_ID = 'message-id';
const CONVERSATION_ID = '9c2f1d5e-8a4b-4c6d-9e0f-1a2b3c4d5e6f';
const SPEC = '**Objective:** plot the series';
const CODE = 'function Widget() { return <div>ok</div>; }';
const EXPIRY = new Date('2026-09-13T00:00:00.000Z');
const INTERFACE_CONFIG = { widgetCompileTimeoutMs: 90_000 };

/** What an orphaned compile reads as; the client shows it on the card. */
const ORPHANED_ERROR = 'The compilation did not finish. Generate the card again to retry.';

const READY: TStoredWidget = {
  spec: SPEC,
  endpoint: 'openAI',
  model: 'gpt-4o-mini',
  status: 'ready',
  code: CODE,
  startedAt: 0,
};

const FAILED: TStoredWidget = {
  spec: SPEC,
  endpoint: 'openAI',
  model: 'gpt-4o-mini',
  status: 'failed',
  error: 'The widget could not be compiled',
  startedAt: 0,
};

const pendingEntry = (startedAt: number): TStoredWidget => ({
  spec: SPEC,
  endpoint: 'openAI',
  model: 'gpt-4o-mini',
  status: 'pending',
  startedAt,
});

/** An entry written before the compile became asynchronous: it carries its
 *  compiled code and no status at all. */
const LEGACY = {
  spec: SPEC,
  endpoint: 'openAI',
  model: 'gpt-4o-mini',
  code: CODE,
} as unknown as TStoredWidget;

const entryFor = (model: string): TStoredWidget => ({ ...READY, model });

const createRequest = (
  params: { messageId: string } = { messageId: MESSAGE_ID },
  authenticated = true,
): WidgetResultRequest => {
  const user = { id: USER_ID, role: 'USER', tenantId: 'tenant-a' };
  return (authenticated ? { params, user } : { params }) as unknown as WidgetResultRequest;
};

const createServerRequest = (): ServerRequest => {
  const user = { id: USER_ID, role: 'USER', tenantId: 'tenant-a' };
  const config = { interfaceConfig: INTERFACE_CONFIG };
  return { body: {}, config, user } as unknown as ServerRequest;
};

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { response: { status, json } as unknown as Response, status, json };
};

const createDb = () => {
  const getMessage = jest.fn();
  const saveMessage = jest.fn();
  const db = { getMessage, saveMessage } as unknown as WidgetResultDbMethods;
  return { db, getMessage, saveMessage };
};

const createHandlers = () => {
  const { db, getMessage, saveMessage } = createDb();
  return { getMessage, saveMessage, handlers: createWidgetResultHandlers({ db }) };
};

describe('normalizeStoredWidget', () => {
  /** Entries stored before the compile became asynchronous are finished
   *  compiles: the code is already on them. */
  it('reads a legacy entry with no status as a finished compile', () => {
    expect(normalizeStoredWidget(LEGACY)).toEqual({
      spec: SPEC,
      endpoint: 'openAI',
      model: 'gpt-4o-mini',
      code: CODE,
      status: 'ready',
      startedAt: 0,
    });
  });

  it('leaves a pending entry inside its budget pending', () => {
    const entry = pendingEntry(Date.now());

    expect(normalizeStoredWidget(entry)).toBe(entry);
  });

  /** Nothing can still be compiling past the protocol ceiling, so the entry was
   *  orphaned by a restart rather than left running. */
  it('reads a pending entry past the staleness ceiling as failed', () => {
    const entry = pendingEntry(Date.now() - WIDGET_PENDING_STALE_MS - 60_000);
    const normalized = normalizeStoredWidget(entry);

    expect(normalized).toEqual({
      spec: SPEC,
      endpoint: 'openAI',
      model: 'gpt-4o-mini',
      status: 'failed',
      error: ORPHANED_ERROR,
      startedAt: entry.startedAt,
    });
    expect(normalized.code).toBeUndefined();
  });

  it('keeps a pending entry that sits exactly on the staleness ceiling', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers({ now });
    try {
      const entry = pendingEntry(now - WIDGET_PENDING_STALE_MS);

      expect(normalizeStoredWidget(entry)).toBe(entry);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads a pending entry with no start time as failed', () => {
    const entry = { ...pendingEntry(Date.now()), startedAt: undefined } as unknown as TStoredWidget;

    expect(normalizeStoredWidget(entry).status).toBe('failed');
  });

  it('reads a pending entry with an unreadable start time as failed', () => {
    const entry = { ...pendingEntry(Date.now()), startedAt: NaN };

    expect(normalizeStoredWidget(entry).status).toBe('failed');
  });

  it('leaves a settled entry alone', () => {
    expect(normalizeStoredWidget(READY)).toBe(READY);
    expect(normalizeStoredWidget(FAILED)).toBe(FAILED);
  });
});

describe('normalizeStoredWidgets', () => {
  it('normalizes every entry and keeps their order', () => {
    const orphan = pendingEntry(Date.now() - WIDGET_PENDING_STALE_MS - 60_000);

    expect(normalizeStoredWidgets([LEGACY, orphan, READY])).toEqual([
      { ...LEGACY, status: 'ready', startedAt: 0 },
      { ...orphan, status: 'failed', code: undefined, error: ORPHANED_ERROR },
      READY,
    ]);
  });

  it('answers an empty list for a message that stored nothing', () => {
    expect(normalizeStoredWidgets([])).toEqual([]);
  });
});

describe('upsertWidgetResult', () => {
  it('appends the first entry', () => {
    expect(upsertWidgetResult([], READY)).toEqual([READY]);
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

describe('storeWidgetEntry', () => {
  const message = (widgets?: TStoredWidget[]): StoredWidgetMessage => ({
    conversationId: CONVERSATION_ID,
    expiredAt: EXPIRY,
    widgets,
  });

  it('writes the entry onto the message and reports it stored', async () => {
    const { db, saveMessage } = createDb();
    saveMessage.mockResolvedValue({ messageId: MESSAGE_ID });

    const stored = await storeWidgetEntry({
      db,
      req: createServerRequest(),
      userId: USER_ID,
      messageId: MESSAGE_ID,
      message: { ...message([entryFor('a')]), isTemporary: true },
      entry: READY,
    });

    expect(stored).toBe(true);
    expect(saveMessage).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        isTemporary: true,
        expiredAt: EXPIRY,
        interfaceConfig: INTERFACE_CONFIG,
      },
      {
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        user: USER_ID,
        widgets: [entryFor('a'), READY],
      },
      { context: 'POST /api/widgets/generate' },
    );
  });

  /** The whole array is rewritten on every compile, so an entry that predates
   *  the status field has to be upgraded rather than re-persisted as it was. */
  it('normalizes a legacy entry before rewriting the array', async () => {
    const { db, saveMessage } = createDb();
    saveMessage.mockResolvedValue({ messageId: MESSAGE_ID });
    const settled = { ...READY, model: 'gpt-4o' };

    await storeWidgetEntry({
      db,
      req: createServerRequest(),
      userId: USER_ID,
      messageId: MESSAGE_ID,
      message: message([LEGACY]),
      entry: settled,
    });

    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      {
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        user: USER_ID,
        widgets: [{ ...LEGACY, status: 'ready', startedAt: 0 }, settled],
      },
      expect.anything(),
    );
  });

  it('writes a pending entry the same way it writes a settled one', async () => {
    const { db, saveMessage } = createDb();
    saveMessage.mockResolvedValue({ messageId: MESSAGE_ID });
    const pending = pendingEntry(Date.now());

    await storeWidgetEntry({
      db,
      req: createServerRequest(),
      userId: USER_ID,
      messageId: MESSAGE_ID,
      message: message(),
      entry: pending,
    });

    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      {
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        user: USER_ID,
        widgets: [pending],
      },
      expect.anything(),
    );
  });

  it('reports an entry that was not stored', async () => {
    const { db, saveMessage } = createDb();
    saveMessage.mockResolvedValue(null);

    const stored = await storeWidgetEntry({
      db,
      req: createServerRequest(),
      userId: USER_ID,
      messageId: MESSAGE_ID,
      message: message(),
      entry: READY,
    });

    expect(stored).toBe(false);
  });

  it('reports a save that answered nothing at all', async () => {
    const { db, saveMessage } = createDb();
    saveMessage.mockResolvedValue(undefined);

    const stored = await storeWidgetEntry({
      db,
      req: createServerRequest(),
      userId: USER_ID,
      messageId: MESSAGE_ID,
      message: message(),
      entry: READY,
    });

    expect(stored).toBe(false);
  });
});

describe('createWidgetResultHandlers', () => {
  it('answers an unauthenticated read as unauthorized', async () => {
    const { getMessage, handlers } = createHandlers();
    const { response, status, json } = createResponse();

    await handlers.read(createRequest({ messageId: MESSAGE_ID }, false), response);

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

  /** The read path is the only one the client polls, so it is what turns a
   *  legacy or orphaned entry into something the card can render. */
  it('returns the stored widgets normalized', async () => {
    const { getMessage, handlers } = createHandlers();
    const orphan = pendingEntry(Date.now() - WIDGET_PENDING_STALE_MS - 60_000);
    getMessage.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      widgets: [LEGACY, orphan, READY],
    });
    const { response, status, json } = createResponse();

    await handlers.read(createRequest(), response);

    expect(status).toHaveBeenCalledWith(200);
    const [body] = json.mock.calls[0] as [TWidgetResultsResponse];
    expect(body.widgets).toEqual([
      { ...LEGACY, status: 'ready', startedAt: 0 },
      { ...orphan, status: 'failed', code: undefined, error: ORPHANED_ERROR },
      READY,
    ]);
    expect(body.widgets[1].code).toBeUndefined();
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
});
