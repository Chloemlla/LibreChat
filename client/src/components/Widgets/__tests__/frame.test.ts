import type { WidgetFrameEvent, WidgetFrameState } from '../frame';
import {
  clampWidgetHeight,
  getWidgetFrameProps,
  initialWidgetFrameState,
  observeWidgetDark,
  parseWidgetFrameEvent,
  readWidgetDark,
  widgetFrameReducer,
  MAX_WIDGET_ERROR_LENGTH,
  WIDGET_DARK_CLASS,
  WIDGET_FRAME_SANDBOX,
  WIDGET_HEIGHT_DEFAULT,
  WIDGET_HEIGHT_MAX,
  WIDGET_HEIGHT_MIN,
  WIDGET_RUNTIME_URL,
} from '../frame';
import { act } from 'test/layout-test-utils';

describe('parseWidgetFrameEvent', () => {
  it('accepts the three events the protocol defines', () => {
    expect(parseWidgetFrameEvent({ type: 'widget:ready' })).toEqual({ type: 'widget:ready' });
    expect(parseWidgetFrameEvent({ type: 'widget:height', height: 480 })).toEqual({
      type: 'widget:height',
      height: 480,
    });
    expect(parseWidgetFrameEvent({ type: 'widget:error', message: 'boom' })).toEqual({
      type: 'widget:error',
      message: 'boom',
    });
  });

  it('ignores keys the protocol does not define', () => {
    expect(parseWidgetFrameEvent({ type: 'widget:ready', code: 'steal this' })).toEqual({
      type: 'widget:ready',
    });
  });

  it.each([null, undefined, 'widget:ready', 7, [], {}, { type: 7 }, { type: 'widget:nope' }])(
    'drops %p',
    (data) => {
      expect(parseWidgetFrameEvent(data)).toBeNull();
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '480', null, undefined])(
    'drops a height of %p',
    (height) => {
      expect(parseWidgetFrameEvent({ type: 'widget:height', height })).toBeNull();
    },
  );

  it('clamps a height the frame could not be believed about', () => {
    expect(parseWidgetFrameEvent({ type: 'widget:height', height: 99999 })).toEqual({
      type: 'widget:height',
      height: WIDGET_HEIGHT_MAX,
    });
    expect(parseWidgetFrameEvent({ type: 'widget:height', height: -40 })).toEqual({
      type: 'widget:height',
      height: WIDGET_HEIGHT_MIN,
    });
  });

  it('truncates an error message before it reaches the DOM', () => {
    const event = parseWidgetFrameEvent({
      type: 'widget:error',
      message: 'x'.repeat(MAX_WIDGET_ERROR_LENGTH * 2),
    });

    expect(event).toEqual({ type: 'widget:error', message: 'x'.repeat(MAX_WIDGET_ERROR_LENGTH) });
  });

  it('drops a non-string error message', () => {
    expect(parseWidgetFrameEvent({ type: 'widget:error', message: { text: 'boom' } })).toBeNull();
  });
});

describe('clampWidgetHeight', () => {
  it.each([
    [0, WIDGET_HEIGHT_MIN],
    [-1, WIDGET_HEIGHT_MIN],
    [WIDGET_HEIGHT_MIN, WIDGET_HEIGHT_MIN],
    [480, 480],
    [480.6, 481],
    [WIDGET_HEIGHT_MAX, WIDGET_HEIGHT_MAX],
    [WIDGET_HEIGHT_MAX + 1, WIDGET_HEIGHT_MAX],
  ])('maps %p to %p', (input, expected) => {
    expect(clampWidgetHeight(input)).toBe(expected);
  });
});

describe('widgetFrameReducer', () => {
  const booting = initialWidgetFrameState(600);

  it('starts booting at the tag height', () => {
    expect(booting).toEqual({ status: 'booting', height: 600, error: null });
    expect(initialWidgetFrameState()).toEqual({
      status: 'booting',
      height: WIDGET_HEIGHT_DEFAULT,
      error: null,
    });
  });

  it('moves to rendering when the frame reports ready', () => {
    expect(widgetFrameReducer(booting, { type: 'widget:ready' })).toEqual({
      status: 'rendering',
      height: 600,
      error: null,
    });
  });

  it('does not re-arm a failed frame on a stray ready', () => {
    const failed: WidgetFrameState = { status: 'failed', height: 600, error: 'boom' };

    expect(widgetFrameReducer(failed, { type: 'widget:ready' })).toBe(failed);
  });

  it('reports the measured height once the frame renders', () => {
    const rendering: WidgetFrameState = { status: 'rendering', height: 600, error: null };

    expect(widgetFrameReducer(rendering, { type: 'widget:height', height: 214 })).toEqual({
      status: 'ready',
      height: 214,
      error: null,
    });
  });

  it('ignores a late height after the frame failed', () => {
    const failed: WidgetFrameState = { status: 'failed', height: 600, error: 'boom' };

    expect(widgetFrameReducer(failed, { type: 'widget:height', height: 10 })).toBe(failed);
  });

  it('records the frame error instead of showing a blank frame', () => {
    const rendering: WidgetFrameState = { status: 'rendering', height: 600, error: null };

    expect(widgetFrameReducer(rendering, { type: 'widget:error', message: 'boom' })).toEqual({
      status: 'failed',
      height: 600,
      error: 'boom',
    });
  });

  it('clears a failure on reset and keeps the last height', () => {
    const failed: WidgetFrameState = { status: 'failed', height: 600, error: 'boom' };

    expect(widgetFrameReducer(failed, { type: 'widget:reset' })).toEqual({
      status: 'rendering',
      height: 600,
      error: null,
    });
  });

  it('is driven only by defined events', () => {
    const events: WidgetFrameEvent[] = [
      { type: 'widget:ready' },
      { type: 'widget:height', height: 300 },
      { type: 'widget:error', message: 'boom' },
    ];

    for (const event of events) {
      expect(widgetFrameReducer(booting, event).status).not.toBe('booting');
    }
  });
});

/**
 * A frame does not inherit the embedding page's theme — `prefers-color-scheme` inside it
 * follows the OS — so the host reads the class the app rendered and pushes it across.
 */
describe('the resolved theme', () => {
  afterEach(() => {
    document.documentElement.classList.remove(WIDGET_DARK_CLASS);
  });

  it('reads the class the theme provider toggles on the document root', () => {
    expect(readWidgetDark()).toBe(false);

    document.documentElement.classList.add(WIDGET_DARK_CLASS);

    expect(readWidgetDark()).toBe(true);
  });

  it('reports a change once, and nothing at all once it is disconnected', async () => {
    const seen: boolean[] = [];
    const stop = observeWidgetDark((dark) => seen.push(dark));

    await act(async () => {
      document.documentElement.classList.add(WIDGET_DARK_CLASS);
      await Promise.resolve();
    });

    expect(seen).toEqual([true]);

    /* A class change that does not move the resolved theme is not a theme change. */
    await act(async () => {
      document.documentElement.classList.add('light');
      await Promise.resolve();
    });

    expect(seen).toEqual([true]);

    stop();

    await act(async () => {
      document.documentElement.classList.remove(WIDGET_DARK_CLASS);
      await Promise.resolve();
    });

    expect(seen).toEqual([true]);
  });
});

describe('getWidgetFrameProps', () => {
  it('grants scripts and nothing else', () => {
    const props = getWidgetFrameProps(400);

    expect(props.sandbox).toBe('allow-scripts');
    expect(WIDGET_FRAME_SANDBOX).not.toContain('allow-same-origin');
  });

  it('points at the static runtime document rather than srcdoc', () => {
    const props = getWidgetFrameProps(400);

    expect(props.src).toBe(WIDGET_RUNTIME_URL);
    expect(props).not.toHaveProperty('srcDoc');
    expect(props.referrerPolicy).toBe('no-referrer');
  });

  it('applies the clamped height to the frame', () => {
    const props = getWidgetFrameProps(9000);

    expect(props.style).toMatchObject({ height: WIDGET_HEIGHT_MAX });
  });
});
