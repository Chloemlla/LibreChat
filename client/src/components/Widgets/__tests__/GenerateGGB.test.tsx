import React from 'react';
import { render, screen, fireEvent, act } from 'test/layout-test-utils';
import Markdown from '../../Chat/Messages/Content/Markdown';
import { GGB_COMMAND_MAX_COUNT } from '../plugin';
import { MessageContext } from '~/Providers';
import { GGB_BOOT_TIMEOUT_MS, WIDGET_DARK_CLASS } from '../frame';

let mockStartupConfig: { interface?: { geogebraOrigin?: string } } | undefined;

jest.mock('~/data-provider', () => {
  const actual = jest.requireActual<Record<string, unknown>>('~/data-provider');
  return {
    ...actual,
    useGetStartupConfig: () => ({ data: mockStartupConfig }),
  };
});

const GGB_ORIGIN = 'https://ggb.example.com';
const FRAME_SRC = `${GGB_ORIGIN}/ggb-runtime.html`;
const TITLE = 'GeoGebra construction';
const FRAME_TITLE = 'GeoGebra applet';
const COMMANDS = ['A=(1,2)', 'f(x)=x^2', 'Circle(A,3)'];
const LOADING_TEXT = 'Loading the GeoGebra construction';
const BOOT_TIMEOUT_TEXT =
  'The GeoGebra runtime did not finish loading. Check that the configured GeoGebra origin is reachable, then retry.';

const heightAttribute = (height?: string): string =>
  height === undefined ? '' : ` height="${height}"`;

const tag = (body: string, height?: string): string =>
  `<GenerateGGB${heightAttribute(height)}>\n${body}\n</GenerateGGB>`;

const body = (commands: string[] = COMMANDS): string => commands.join('\n');

/* `render` from `test/layout-test-utils` already supplies the router, so a second one
   here would be nested inside it. */
const wrap = (ui: React.ReactNode) => (
  <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
    {ui}
  </MessageContext.Provider>
);

const renderMessage = (content: string) =>
  render(wrap(<Markdown content={content} isLatestMessage={false} />));

const renderCard = (content = `Here is a figure.\n\n${tag(body(), '480px')}`) =>
  renderMessage(content);

/** The frame is a separate window that the host writes to, so the test stands in for it. */
const frameWindow = { postMessage: jest.fn() };

const frame = (): HTMLIFrameElement => screen.getByTitle(FRAME_TITLE) as HTMLIFrameElement;

const dispatchFromFrame = (
  data: unknown,
  { origin = GGB_ORIGIN, source = frameWindow }: { origin?: string; source?: unknown } = {},
): void => {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin,
        source: source as MessageEventSource,
      }),
    );
  });
};

const ready = () => dispatchFromFrame({ type: 'ggb:ready' });

const commandsCommand = (dark: boolean) => ({ type: 'ggb:commands', commands: COMMANDS, dark });

beforeEach(() => {
  frameWindow.postMessage.mockClear();
  mockStartupConfig = { interface: { geogebraOrigin: GGB_ORIGIN } };
  jest
    .spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get')
    .mockReturnValue(frameWindow as unknown as Window);
});

describe('a message carrying a GeoGebra tag', () => {
  it('renders the card instead of the tag', () => {
    const { container } = renderCard();

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(container.textContent).not.toContain('GenerateGGB');
    expect(frame()).toHaveAttribute('src', FRAME_SRC);
  });

  it('runs the frame same-origin, from the configured origin', () => {
    renderCard();

    expect(frame()).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    expect(frame()).toHaveAttribute('title', FRAME_TITLE);
    expect(frame()).toHaveStyle({ height: '480px' });
  });

  it('leaves a tag that is still streaming as literal text', () => {
    const { container } = renderMessage(
      `Here is a figure.\n\n<GenerateGGB height="480px">\nA=(1,2`,
    );

    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(container.textContent).toContain('<GenerateGGB height="480px">');
  });

  it('leaves a tag with no command as literal text', () => {
    const { container } = renderMessage(
      `Here is a figure.\n\n<GenerateGGB height="480px"></GenerateGGB>`,
    );

    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(container.textContent).toContain('</GenerateGGB>');
  });

  it('renders the tag as text when the deployment sets no origin', () => {
    mockStartupConfig = { interface: {} };
    const { container } = renderCard();

    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(container.textContent).toContain('<GenerateGGB height="480px">');
  });

  it('renders the tag as text when the origin is not an absolute origin', () => {
    mockStartupConfig = { interface: { geogebraOrigin: 'ggb.example.com' } };
    const { container } = renderCard();

    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(container.textContent).toContain('<GenerateGGB');
  });

  it('says how many commands the tag was too long to carry', () => {
    const commands: string[] = [];
    for (let index = 0; index < GGB_COMMAND_MAX_COUNT + 5; index += 1) {
      commands.push(`A${index}=(1,2)`);
    }
    renderMessage(`\n\n${tag(body(commands))}`);

    expect(screen.getByText(/Some commands were dropped \(5\)/)).toBeInTheDocument();
  });
});

describe('the commands sent to the frame', () => {
  it('are posted once the frame reports ready, addressed to the origin', () => {
    renderCard();

    expect(frameWindow.postMessage).not.toHaveBeenCalled();

    ready();

    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(commandsCommand(false), GGB_ORIGIN);
  });

  it('are re-posted when the frame reports ready again after a reload', () => {
    renderCard();
    ready();
    frameWindow.postMessage.mockClear();

    ready();

    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(commandsCommand(false), GGB_ORIGIN);
  });
});

/**
 * The frame has a real origin, so a message is only this card's if it comes from the
 * configured origin *and* from the window this card mounted.
 */
describe('a message from somewhere else', () => {
  it('is dropped when it comes from another origin', () => {
    renderCard();

    dispatchFromFrame({ type: 'ggb:height', height: 700 }, { origin: 'https://evil.example' });

    expect(frame()).toHaveStyle({ height: '480px' });
  });

  it('is dropped when it comes from another window on the configured origin', () => {
    renderCard();

    dispatchFromFrame({ type: 'ggb:height', height: 700 }, { source: { notTheFrame: true } });

    expect(frame()).toHaveStyle({ height: '480px' });
  });

  it("is accepted when it comes from the card's own frame", () => {
    renderCard();

    dispatchFromFrame({ type: 'ggb:height', height: 700 });

    expect(frame()).toHaveStyle({ height: '700px' });
  });

  it('cannot arm the frame with a ready from another origin', () => {
    renderCard();

    dispatchFromFrame({ type: 'ggb:ready' }, { origin: 'https://evil.example' });

    expect(frameWindow.postMessage).not.toHaveBeenCalled();
  });
});

describe('a frame that fails', () => {
  it('shows the reason with a retry, and retrying replays into the live frame', () => {
    renderCard();
    ready();
    frameWindow.postMessage.mockClear();

    dispatchFromFrame({ type: 'ggb:error', message: 'the applet failed to load' });

    expect(screen.getByText('the applet failed to load')).toBeInTheDocument();
    expect(frame()).toHaveClass('hidden');

    const before = frame();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(commandsCommand(false), GGB_ORIGIN);
    expect(screen.queryByText('the applet failed to load')).not.toBeInTheDocument();
    /* The frame reported in, so the retry is a replay: the document is not reloaded. */
    expect(frame()).toBe(before);
  });
});

/**
 * A refused command is not a dead frame: the part of the construction the applet did draw
 * stays on screen and the problem is reported beside it.
 */
describe('a frame that reports a problem with the batch', () => {
  it('shows it as a warning and leaves the construction in place', () => {
    renderCard();
    ready();
    dispatchFromFrame({ type: 'ggb:height', height: 700 });
    frameWindow.postMessage.mockClear();

    dispatchFromFrame({ type: 'ggb:warning', message: 'Circle(A,3): rejected' });

    expect(screen.getByText('Circle(A,3): rejected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(document.contains(frame())).toBe(true);
    expect(frame()).not.toHaveClass('hidden');
    /* A warning is a report, not a payload: nothing is sent back to the frame. */
    expect(frameWindow.postMessage).not.toHaveBeenCalled();
  });

  it('shows a warning from the frame beside one the tag earned locally', () => {
    const commands: string[] = [];
    for (let index = 0; index < GGB_COMMAND_MAX_COUNT + 5; index += 1) {
      commands.push(`A${index}=(1,2)`);
    }
    renderMessage(`\n\n${tag(body(commands))}`);
    ready();

    dispatchFromFrame({ type: 'ggb:warning', message: 'Circle(A,3): rejected' });

    expect(screen.getByText(/Some commands were dropped \(5\)/)).toBeInTheDocument();
    expect(screen.getByText('Circle(A,3): rejected')).toBeInTheDocument();
  });
});

/**
 * The frame is a different origin, so a document that 404s, an origin that does not answer
 * and a bundle that never starts are one and the same from here: the ready ping never
 * comes. Without a deadline the card would sit on an empty frame with nothing to click.
 */
describe('a frame that never reports ready', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const passBootWindow = () => {
    act(() => {
      jest.advanceTimersByTime(GGB_BOOT_TIMEOUT_MS);
    });
  };

  it('fails the card with a retry instead of waiting forever', () => {
    renderCard();

    expect(screen.queryByText(BOOT_TIMEOUT_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(LOADING_TEXT)).toBeInTheDocument();

    passBootWindow();

    expect(screen.getByText(BOOT_TIMEOUT_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(LOADING_TEXT)).not.toBeInTheDocument();
    expect(frame()).toHaveClass('hidden');
  });

  it('leaves a frame that reported in alone', () => {
    renderCard();
    ready();
    dispatchFromFrame({ type: 'ggb:height', height: 700 });

    passBootWindow();

    expect(screen.queryByText(BOOT_TIMEOUT_TEXT)).not.toBeInTheDocument();
    expect(frame()).not.toHaveClass('hidden');
    expect(frame()).toHaveStyle({ height: '700px' });
  });

  it('reboots the frame on retry, since there is nothing to replay into', () => {
    renderCard();
    passBootWindow();
    const before = frame();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(document.contains(before)).toBe(false);
    expect(frame()).not.toBe(before);
    expect(frameWindow.postMessage).not.toHaveBeenCalled();
  });
});

/**
 * A frame does not inherit the app's theme, so the host reads the class the app rendered
 * off the document root and sends it — with the payload, and again on every change.
 */
describe('the theme sent across the boundary', () => {
  afterEach(() => {
    document.documentElement.classList.remove(WIDGET_DARK_CLASS);
  });

  it('sends the resolved theme with the commands the frame asks for', () => {
    document.documentElement.classList.add(WIDGET_DARK_CLASS);
    renderCard();

    ready();

    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(commandsCommand(true), GGB_ORIGIN);
  });

  it('sends the light theme, and no theme message, when nothing has changed', () => {
    renderCard();

    ready();

    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(commandsCommand(false), GGB_ORIGIN);
  });

  it('re-sends the theme on a change without replaying the construction', async () => {
    renderCard();
    ready();
    frameWindow.postMessage.mockClear();

    await act(async () => {
      document.documentElement.classList.add(WIDGET_DARK_CLASS);
      await Promise.resolve();
    });

    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      { type: 'ggb:theme', dark: true },
      GGB_ORIGIN,
    );
  });
});
