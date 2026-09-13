import type { TStoredWidget } from 'librechat-data-provider';
import type { WidgetResultDbMethods } from './results';
import type { WidgetCompileJobParams } from './job';
import type { ServerRequest } from '~/types';
import { runWidgetCompile } from './job';

const SPEC = '**Objective:** plot the series';
const COMPONENT = 'function Widget() { return <div>ok</div>; }';
const MESSAGE_ID = 'message-id';
const USER_ID = 'user-id';
const CONVERSATION_ID = '9c2f1d5e-8a4b-4c6d-9e0f-1a2b3c4d5e6f';
const STARTED_AT = 1_700_000_000_000;
const INTERFACE_CONFIG = { widgetCompileTimeoutMs: 90_000 };

/** Echoes what the compile failed with; the client shows it on the card. */
const COMPILE_FAILED_ERROR = 'The widget could not be compiled';

const createRequest = (): ServerRequest => {
  const user = { id: USER_ID, role: 'USER', tenantId: 'tenant-a' };
  const config = { interfaceConfig: INTERFACE_CONFIG };
  return { body: {}, config, user } as unknown as ServerRequest;
};

const createJob = () => {
  const saveMessage = jest.fn().mockResolvedValue({ messageId: MESSAGE_ID });
  const generate = jest.fn().mockResolvedValue(COMPONENT);
  const getMessage = jest.fn().mockResolvedValue({ conversationId: CONVERSATION_ID });
  const db = { getMessage, saveMessage } as unknown as WidgetResultDbMethods;
  const params: WidgetCompileJobParams = {
    req: createRequest(),
    messageId: MESSAGE_ID,
    userId: USER_ID,
    spec: SPEC,
    endpoint: 'openAI',
    model: 'gpt-4o-mini',
    db,
    startedAt: STARTED_AT,
    generate,
  };
  return { params, generate, getMessage, saveMessage };
};

/** The update the job wrote, as `saveMessage` received it. */
const storedWidgets = (saveMessage: jest.Mock): TStoredWidget[] => {
  const call = saveMessage.mock.calls[0] as [unknown, { widgets: TStoredWidget[] }];
  return call[1].widgets;
};

/** Lets the detached compile run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runWidgetCompile', () => {
  /** The request that starts a compile is already answered, so nothing may be
   *  written to the message until the compile has actually returned. */
  it('returns before the compile has settled', () => {
    const { params, saveMessage } = createJob();

    runWidgetCompile(params);

    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('stores the compiled component as ready', async () => {
    const { params, generate, saveMessage } = createJob();

    runWidgetCompile(params);
    await settle();

    expect(generate).toHaveBeenCalledWith({
      req: params.req,
      endpoint: 'openAI',
      model: 'gpt-4o-mini',
      spec: SPEC,
      db: params.db,
    });
    expect(storedWidgets(saveMessage)).toEqual([
      {
        spec: SPEC,
        endpoint: 'openAI',
        model: 'gpt-4o-mini',
        status: 'ready',
        code: COMPONENT,
        startedAt: STARTED_AT,
      },
    ]);
  });

  it('stores the unwrapped component when the model fenced its output', async () => {
    const { params, generate, saveMessage } = createJob();
    generate.mockResolvedValue(`\`\`\`jsx\n${COMPONENT}\n\`\`\``);

    runWidgetCompile(params);
    await settle();

    expect(storedWidgets(saveMessage)[0].code).toBe(COMPONENT);
  });

  it('stores the failure when the compile call throws', async () => {
    const { params, generate, saveMessage } = createJob();
    generate.mockRejectedValue(new Error('provider unavailable'));

    runWidgetCompile(params);
    await settle();

    expect(storedWidgets(saveMessage)).toEqual([
      {
        spec: SPEC,
        endpoint: 'openAI',
        model: 'gpt-4o-mini',
        status: 'failed',
        error: COMPILE_FAILED_ERROR,
        startedAt: STARTED_AT,
      },
    ]);
  });

  it('stores the failure when the compiled code is refused', async () => {
    const { params, generate, saveMessage } = createJob();
    generate.mockResolvedValue('const Chart = () => null;');

    runWidgetCompile(params);
    await settle();

    expect(storedWidgets(saveMessage)).toEqual([
      {
        spec: SPEC,
        endpoint: 'openAI',
        model: 'gpt-4o-mini',
        status: 'failed',
        error: 'The generated component does not define a Widget component',
        startedAt: STARTED_AT,
      },
    ]);
  });

  it('stores the failure when the compiled code reaches the network', async () => {
    const { params, generate, saveMessage } = createJob();
    generate.mockResolvedValue('function Widget() { fetch("/x"); return null; }');

    runWidgetCompile(params);
    await settle();

    expect(storedWidgets(saveMessage)[0].error).toBe(
      'The generated component uses a construct the sandbox forbids',
    );
  });

  /** The staleness rule measures the compile, not the write: re-reading the
   *  clock here would make a slow compile look freshly started forever. */
  it('settles with the start time the pending entry was written with', async () => {
    const { params, saveMessage } = createJob();
    jest.spyOn(Date, 'now').mockReturnValue(STARTED_AT + 500_000);

    runWidgetCompile(params);
    await settle();

    expect(storedWidgets(saveMessage)[0].startedAt).toBe(STARTED_AT);
  });

  /** Nothing awaits the job, so a rejection would surface as an unhandled one
   *  and take the process down instead of failing a single card. */
  it('never rejects when the store itself fails', async () => {
    const { params, saveMessage } = createJob();
    saveMessage.mockRejectedValue(new Error('store failed'));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      runWidgetCompile(params);
      await settle();
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
  });

  it('settles a compile that resolved nothing as a failure rather than throwing', async () => {
    const { params, generate, saveMessage } = createJob();
    generate.mockResolvedValue('');

    runWidgetCompile(params);
    await settle();

    expect(storedWidgets(saveMessage)[0]).toEqual({
      spec: SPEC,
      endpoint: 'openAI',
      model: 'gpt-4o-mini',
      status: 'failed',
      error: 'The model returned no component',
      startedAt: STARTED_AT,
    });
  });

  /** The compile runs for minutes, so the array can have been written since the
   *  request loaded it: rewriting that copy would drop whichever card settled in
   *  between, leaving a card the user had already compiled showing nothing. */
  it('settles into the message as it stands, keeping what was written meanwhile', async () => {
    const { params, getMessage, saveMessage } = createJob();
    const other = {
      spec: 'another card',
      endpoint: 'openAI',
      model: 'gpt-4o',
      status: 'ready' as const,
      code: 'function Widget() { return <p>other</p>; }',
      startedAt: 1,
    };
    getMessage.mockResolvedValue({ conversationId: CONVERSATION_ID, widgets: [other] });

    runWidgetCompile(params);
    await settle();

    expect(getMessage).toHaveBeenCalledWith({ user: USER_ID, messageId: MESSAGE_ID });
    expect(storedWidgets(saveMessage)).toEqual([
      other,
      {
        spec: SPEC,
        endpoint: 'openAI',
        model: 'gpt-4o-mini',
        status: 'ready',
        code: COMPONENT,
        startedAt: STARTED_AT,
      },
    ]);
  });

  /** A settle has nobody left to answer, so a message that vanished mid-compile
   *  is reported and dropped rather than written back into existence. */
  it('drops the compiled component when the message it belongs to is gone', async () => {
    const { params, getMessage, saveMessage } = createJob();
    getMessage.mockResolvedValue(null);

    runWidgetCompile(params);
    await settle();

    expect(saveMessage).not.toHaveBeenCalled();
  });
});
