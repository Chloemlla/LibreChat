import React from 'react';
import type { TStoredWidget } from 'librechat-data-provider';
import { render, screen, fireEvent, act } from 'test/layout-test-utils';
import Markdown from '../../Chat/Messages/Content/Markdown';
import { MessageContext } from '~/Providers';
import { WIDGET_DARK_CLASS } from '../frame';

let mockEndpoints: Record<string, { userProvide: boolean }> | undefined;
let mockModels: Record<string, string[]> | undefined;
let mockStartupConfig: { interface?: { widgets?: boolean } } | undefined;
let mockWidgets: TStoredWidget[] | undefined;

jest.mock('~/data-provider', () => {
  const actual = jest.requireActual<Record<string, unknown>>('~/data-provider');
  return {
    ...actual,
    useGetEndpointsQuery: () => ({ data: mockEndpoints }),
    useGetStartupConfig: () => ({ data: mockStartupConfig }),
  };
});

jest.mock('librechat-data-provider/react-query', () => {
  const actualModule = jest.requireActual<Record<string, unknown>>(
    'librechat-data-provider/react-query',
  );
  return {
    ...actualModule,
    useGetModelsQuery: () => ({ data: mockModels }),
    useGenerateWidgetMutation: () => ({ mutate: mockMutate }),
    useGetWidgetResultsQuery: () => ({ data: mockWidgets ? { widgets: mockWidgets } : undefined }),
    useSaveWidgetResultMutation: () => ({ mutate: mockSaveMutate }),
  };
});

const mockMutate = jest.fn();
const mockSaveMutate = jest.fn();

const COMPILED_CODE = 'function Widget() { return null; }';
const STORED_CODE = 'function Stored() { return null; }';
const PROMPT = 'plot the series';
const CHOOSE_MODEL = 'Choose an endpoint and model to compile this card.';

const heightAttribute = (height?: string): string =>
  height === undefined ? '' : ` height="${height}"`;

const tag = (body: string, height?: string): string =>
  `<GenerateWidget${heightAttribute(height)}>\n${body}\n</GenerateWidget>`;

const specBody = (prompt = PROMPT): string => JSON.stringify({ widgetSpec: { prompt } });

type MutationOptions = {
  onSuccess: (data: { code: string }) => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
};

/* React Query always settles a mutation, and the card's pending state is cleared there
   rather than in the success and error handlers, so a stub that stops after `onSuccess`
   or `onError` leaves the card stuck on its loading branch. */
const resolveWith = (code: string) => {
  mockMutate.mockImplementation((_payload: unknown, options: MutationOptions) => {
    options.onSuccess({ code });
    options.onSettled();
  });
};

const rejectWith = (error: Error) => {
  mockMutate.mockImplementation((_payload: unknown, options: MutationOptions) => {
    options.onError(error);
    options.onSettled();
  });
};

const storedWidget = (overrides: Partial<TStoredWidget> = {}): TStoredWidget => ({
  spec: PROMPT,
  endpoint: 'openAI',
  model: 'gpt-4o-mini',
  code: STORED_CODE,
  ...overrides,
});

type SaveOptions = { onError?: (error: Error) => void };

/** React Query reports a rejected save through handlers the card never passes, so a
 *  failed write reaches the component as nothing at all. */
const failSave = (error = new Error('offline')) => {
  mockSaveMutate.mockImplementation((_payload: unknown, options?: SaveOptions) =>
    options?.onError?.(error),
  );
};

/* `render` from `test/layout-test-utils` already supplies the router, so a second one
   here would be nested inside it. */
const wrap = (ui: React.ReactNode) => (
  <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
    {ui}
  </MessageContext.Provider>
);

const renderMessage = (content: string) =>
  render(wrap(<Markdown content={content} isLatestMessage={false} />));

/** The frame is a separate window that the host writes to, so the test stands in for it. */
const frameWindow = { postMessage: jest.fn() };

const dispatchFromFrame = (data: unknown): void => {
  act(() => {
    const frame = screen.getByTitle('Interactive card content') as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
  });
};

const selectModel = () => {
  fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'openAI' } });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-4o-mini' } });
};

beforeEach(() => {
  mockMutate.mockReset();
  mockSaveMutate.mockReset();
  frameWindow.postMessage.mockClear();
  mockEndpoints = { openAI: { userProvide: false } };
  mockModels = { openAI: ['gpt-4o-mini'] };
  mockStartupConfig = { interface: { widgets: true } };
  mockWidgets = undefined;
});

describe('a message carrying a widget tag', () => {
  it('renders the card instead of the tag', () => {
    const { container } = renderMessage(`Here is a card.\n\n${tag(specBody(), '600px')}`);

    expect(screen.getByText('Interactive card')).toBeInTheDocument();
    expect(screen.getByText(CHOOSE_MODEL)).toBeInTheDocument();
    expect(container.textContent).not.toContain('GenerateWidget');
  });

  it('offers only the endpoints that serve a model', () => {
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    const endpoint = screen.getByLabelText('Endpoint');
    expect(Array.from(endpoint.querySelectorAll('option')).map((option) => option.value)).toEqual([
      '',
      'openAI',
    ]);
  });

  it('leaves a tag that is still streaming as literal text', () => {
    const { container } = renderMessage(
      `Here is a card.\n\n<GenerateWidget height="600px">\n{"widgetSpec": {"prompt": "unfinished`,
    );

    expect(screen.queryByText('Interactive card')).not.toBeInTheDocument();
    expect(container.textContent).toContain('<GenerateWidget height="600px">');
  });

  it('leaves a tag whose body is malformed as literal text', () => {
    const { container } = renderMessage(`\n\n${tag('{"widgetSpec": {"prompt":', '600px')}`);

    expect(screen.queryByText('Interactive card')).not.toBeInTheDocument();
    expect(container.textContent).toContain('</GenerateWidget>');
  });

  it('renders the tag as text when the deployment turns widgets off', () => {
    mockStartupConfig = { interface: { widgets: false } };
    const { container } = renderMessage(`\n\n${tag(specBody(), '600px')}`);

    expect(screen.queryByText('Interactive card')).not.toBeInTheDocument();
    expect(container.textContent).toContain('<GenerateWidget height="600px">');
  });
});

describe('compiling a card', () => {
  it('offers no way to compile until a model is chosen', () => {
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    expect(screen.queryByRole('button', { name: 'Generate card' })).not.toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'openAI' } });

    expect(screen.queryByRole('button', { name: 'Generate card' })).not.toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-4o-mini' } });

    expect(screen.getByRole('button', { name: 'Generate card' })).toBeInTheDocument();
  });

  it('compiles with the chosen endpoint and model, then mounts a sandboxed frame', () => {
    resolveWith(COMPILED_CODE);
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    selectModel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate card' }));

    expect(mockMutate).toHaveBeenCalledWith(
      { spec: PROMPT, endpoint: 'openAI', model: 'gpt-4o-mini' },
      expect.anything(),
    );

    const frame = screen.getByTitle('Interactive card content');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame).toHaveAttribute('src', '/widget-runtime.html');
  });

  it('shows the reason with a retry when the compile fails', () => {
    rejectWith(new Error('models are not loaded'));
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    selectModel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate card' }));

    expect(screen.getByText('models are not loaded')).toBeInTheDocument();
    expect(screen.queryByTitle('Interactive card content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(mockMutate).toHaveBeenCalledTimes(2);
  });

  it('falls back to its own wording for an error with no message', () => {
    rejectWith(new Error(''));
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    selectModel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate card' }));

    expect(screen.getByText('The card could not be generated.')).toBeInTheDocument();
  });

  it('offers no endpoint when the deployment serves none', () => {
    mockEndpoints = {};
    mockModels = {};
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    expect(screen.getByText('No models are available to compile this card.')).toBeInTheDocument();
  });
});

describe('a card whose message already carries results', () => {
  afterEach(() => {
    document.documentElement.classList.remove(WIDGET_DARK_CLASS);
  });

  it('mounts the stored result without compiling again', () => {
    mockWidgets = [storedWidget()];
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    const frame = screen.getByTitle('Interactive card content');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(screen.queryByText(CHOOSE_MODEL)).not.toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('restores the endpoint and model the result was compiled with', () => {
    mockWidgets = [storedWidget()];
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    expect(screen.getByLabelText('Endpoint')).toHaveValue('openAI');
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-4o-mini');
  });

  it('saves a freshly compiled result to the message', () => {
    resolveWith(COMPILED_CODE);
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    selectModel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate card' }));

    expect(mockSaveMutate).toHaveBeenCalledWith({
      messageId: 'm1',
      widget: { spec: PROMPT, endpoint: 'openAI', model: 'gpt-4o-mini', code: COMPILED_CODE },
    });
  });

  it('keeps the card working when the save fails', () => {
    resolveWith(COMPILED_CODE);
    failSave();
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    selectModel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate card' }));

    expect(screen.getByTitle('Interactive card content')).toBeInTheDocument();
    expect(screen.queryByText('offline')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('asks for a choice when the message carries nothing', () => {
    mockWidgets = [];
    renderMessage(`\n\n${tag(specBody(), '600px')}`);

    expect(screen.getByText(CHOOSE_MODEL)).toBeInTheDocument();
    expect(screen.getByLabelText('Endpoint')).toHaveValue('');
    expect(screen.getByLabelText('Model')).toHaveValue('');
  });

  /* The theme class is the card's own state change, which is what re-renders it and
     lets it see results that arrived after the user had already chosen. */
  it('keeps the choice the user made before the results arrived', async () => {
    renderMessage(`\n\n${tag(specBody(), '600px')}`);
    selectModel();

    mockWidgets = [storedWidget({ endpoint: 'anthropic', model: 'claude-3-haiku' })];
    await act(async () => {
      document.documentElement.classList.add(WIDGET_DARK_CLASS);
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Endpoint')).toHaveValue('openAI');
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-4o-mini');
  });
});

/**
 * A frame does not inherit the app's theme, so the host reads the class the app rendered
 * off the document root and sends it — with the payload, and again on every change.
 */
describe('the theme sent across the boundary', () => {
  const mountCard = () => {
    resolveWith(COMPILED_CODE);
    renderMessage(`\n\n${tag(specBody(), '600px')}`);
    selectModel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate card' }));
  };

  beforeEach(() => {
    jest
      .spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get')
      .mockReturnValue(frameWindow as unknown as Window);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.documentElement.classList.remove(WIDGET_DARK_CLASS);
  });

  it('sends the resolved theme with the payload the frame asks for', () => {
    document.documentElement.classList.add(WIDGET_DARK_CLASS);
    mountCard();

    dispatchFromFrame({ type: 'widget:ready' });

    const renderCommand = { type: 'widget:render', code: COMPILED_CODE, dark: true };
    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(renderCommand, '*');
  });

  it('sends the light theme, and no theme message, when nothing has changed', () => {
    mountCard();

    dispatchFromFrame({ type: 'widget:ready' });

    const renderCommand = { type: 'widget:render', code: COMPILED_CODE, dark: false };
    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(renderCommand, '*');
  });

  it('re-sends the theme on a change without re-rendering the component', async () => {
    mountCard();
    dispatchFromFrame({ type: 'widget:ready' });
    frameWindow.postMessage.mockClear();

    await act(async () => {
      document.documentElement.classList.add(WIDGET_DARK_CLASS);
      await Promise.resolve();
    });

    const themeCommand = { type: 'widget:theme', dark: true };
    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(themeCommand, '*');
  });
});
