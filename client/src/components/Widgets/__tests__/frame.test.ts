import type { WidgetFrameEvent, WidgetFrameState } from '../frame';
import {
  clampWidgetHeight,
  geogebraOrigin,
  getWidgetFrameProps,
  ggbFrameReducer,
  ggbFrameTarget,
  initialWidgetFrameState,
  observeWidgetDark,
  parseGgbFrameEvent,
  parseWidgetFrameEvent,
  readWidgetDark,
  widgetFrameReducer,
  GEOGEBRA_FRAME_SANDBOX,
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
    expect(booting).toEqual({ status: 'booting', height: 600, error: null, warning: null });
    expect(initialWidgetFrameState()).toEqual({
      status: 'booting',
      height: WIDGET_HEIGHT_DEFAULT,
      error: null,
      warning: null,
    });
  });

  it('moves to rendering when the frame reports ready', () => {
    expect(widgetFrameReducer(booting, { type: 'widget:ready' })).toEqual({
      status: 'rendering',
      height: 600,
      error: null,
      warning: null,
    });
  });

  it('does not re-arm a failed frame on a stray ready', () => {
    const failed: WidgetFrameState = {
      status: 'failed',
      height: 600,
      error: 'boom',
      warning: null,
    };

    expect(widgetFrameReducer(failed, { type: 'widget:ready' })).toBe(failed);
  });

  it('reports the measured height once the frame renders', () => {
    const rendering: WidgetFrameState = {
      status: 'rendering',
      height: 600,
      error: null,
      warning: null,
    };

    expect(widgetFrameReducer(rendering, { type: 'widget:height', height: 214 })).toEqual({
      status: 'ready',
      height: 214,
      error: null,
      warning: null,
    });
  });

  it('ignores a late height after the frame failed', () => {
    const failed: WidgetFrameState = {
      status: 'failed',
      height: 600,
      error: 'boom',
      warning: null,
    };

    expect(widgetFrameReducer(failed, { type: 'widget:height', height: 10 })).toBe(failed);
  });

  it('records the frame error instead of showing a blank frame', () => {
    const rendering: WidgetFrameState = {
      status: 'rendering',
      height: 600,
      error: null,
      warning: null,
    };

    expect(widgetFrameReducer(rendering, { type: 'widget:error', message: 'boom' })).toEqual({
      status: 'failed',
      height: 600,
      error: 'boom',
      warning: null,
    });
  });

  it('clears a failure on reset and keeps the last height', () => {
    const failed: WidgetFrameState = {
      status: 'failed',
      height: 600,
      error: 'boom',
      warning: null,
    };

    expect(widgetFrameReducer(failed, { type: 'widget:reset' })).toEqual({
      status: 'rendering',
      height: 600,
      error: null,
      warning: null,
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

describe('parseGgbFrameEvent', () => {
  it('accepts the events the protocol defines', () => {
    expect(parseGgbFrameEvent({ type: 'ggb:ready' })).toEqual({ type: 'ggb:ready' });
    expect(parseGgbFrameEvent({ type: 'ggb:height', height: 480 })).toEqual({
      type: 'ggb:height',
      height: 480,
    });
    expect(parseGgbFrameEvent({ type: 'ggb:warning', message: 'A=(1,2): rejected' })).toEqual({
      type: 'ggb:warning',
      message: 'A=(1,2): rejected',
    });
    expect(parseGgbFrameEvent({ type: 'ggb:error', message: 'boom' })).toEqual({
      type: 'ggb:error',
      message: 'boom',
    });
  });

  it('ignores keys the protocol does not define', () => {
    expect(parseGgbFrameEvent({ type: 'ggb:ready', commands: ['steal this'] })).toEqual({
      type: 'ggb:ready',
    });
  });

  it('does not accept the widget protocol', () => {
    expect(parseGgbFrameEvent({ type: 'widget:ready' })).toBeNull();
    expect(parseWidgetFrameEvent({ type: 'ggb:ready' })).toBeNull();
  });

  it.each([null, undefined, 'ggb:ready', 7, [], {}, { type: 7 }, { type: 'ggb:nope' }])(
    'drops %p',
    (data) => {
      expect(parseGgbFrameEvent(data)).toBeNull();
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '480', null, undefined])(
    'drops a height of %p',
    (height) => {
      expect(parseGgbFrameEvent({ type: 'ggb:height', height })).toBeNull();
    },
  );

  it('clamps a height the frame could not be believed about', () => {
    expect(parseGgbFrameEvent({ type: 'ggb:height', height: -40 })).toEqual({
      type: 'ggb:height',
      height: WIDGET_HEIGHT_MIN,
    });
  });

  it('truncates an error message before it reaches the DOM', () => {
    const event = parseGgbFrameEvent({
      type: 'ggb:error',
      message: 'x'.repeat(MAX_WIDGET_ERROR_LENGTH * 2),
    });

    expect(event).toEqual({ type: 'ggb:error', message: 'x'.repeat(MAX_WIDGET_ERROR_LENGTH) });
  });

  it('drops a warning without a message, or with one that is not a string', () => {
    expect(parseGgbFrameEvent({ type: 'ggb:warning' })).toBeNull();
    expect(parseGgbFrameEvent({ type: 'ggb:warning', message: { text: 'rejected' } })).toBeNull();
  });

  it('truncates a warning message like an error one, since the frame writes both', () => {
    const event = parseGgbFrameEvent({
      type: 'ggb:warning',
      message: 'x'.repeat(MAX_WIDGET_ERROR_LENGTH * 2),
    });

    expect(event).toEqual({ type: 'ggb:warning', message: 'x'.repeat(MAX_WIDGET_ERROR_LENGTH) });
  });
});

describe('ggbFrameReducer', () => {
  const booting = initialWidgetFrameState(480);
  const warning = 'Circle(A,3): rejected';
  const executing: WidgetFrameState = {
    status: 'executing',
    height: 480,
    error: null,
    warning: null,
  };
  const ready: WidgetFrameState = { status: 'ready', height: 480, error: null, warning };
  const failed: WidgetFrameState = { status: 'failed', height: 480, error: 'boom', warning: null };

  it('starts booting at the tag height', () => {
    expect(booting).toEqual({ status: 'booting', height: 480, error: null, warning: null });
  });

  it('moves to executing when the frame reports ready', () => {
    expect(ggbFrameReducer(booting, { type: 'ggb:ready' })).toEqual({
      status: 'executing',
      height: 480,
      error: null,
      warning: null,
    });
  });

  it('enters executing while its payload is posted, where a widget renders', () => {
    expect(ggbFrameReducer(booting, { type: 'ggb:reset' }).status).toBe('executing');
    expect(widgetFrameReducer(booting, { type: 'widget:reset' }).status).toBe('rendering');
  });

  it('reboots into booting, where a reset only replays', () => {
    const rebooted = ggbFrameReducer(failed, { type: 'ggb:reboot' });

    expect(rebooted).toEqual({ status: 'booting', height: 480, error: null, warning: null });
    expect(ggbFrameReducer(failed, { type: 'ggb:reset' })).toEqual({
      status: 'executing',
      height: 480,
      error: null,
      warning: null,
    });
  });

  it('does not re-arm a failed frame on a stray ready', () => {
    expect(ggbFrameReducer(failed, { type: 'ggb:ready' })).toBe(failed);
  });

  it('reports the measured height once the construction is drawn', () => {
    expect(ggbFrameReducer(executing, { type: 'ggb:height', height: 214 })).toEqual({
      status: 'ready',
      height: 214,
      error: null,
      warning: null,
    });
  });

  it('ignores a late height after the frame failed', () => {
    expect(ggbFrameReducer(failed, { type: 'ggb:height', height: 10 })).toBe(failed);
  });

  it('records the frame error instead of showing a blank frame', () => {
    expect(ggbFrameReducer(executing, { type: 'ggb:error', message: 'boom' })).toEqual({
      status: 'failed',
      height: 480,
      error: 'boom',
      warning: null,
    });
  });

  it('clears a failure on reset and keeps the last height', () => {
    const drawn: WidgetFrameState = {
      status: 'failed',
      height: 214,
      error: 'boom',
      warning: null,
    };

    expect(ggbFrameReducer(drawn, { type: 'ggb:reset' })).toEqual({
      status: 'executing',
      height: 214,
      error: null,
      warning: null,
    });
  });

  it('carries a warning without moving the card', () => {
    expect(ggbFrameReducer(executing, { type: 'ggb:warning', message: warning })).toEqual({
      status: 'executing',
      height: 480,
      error: null,
      warning,
    });
    expect(ggbFrameReducer(ready, { type: 'ggb:warning', message: 'A=(1,2): rejected' })).toEqual({
      status: 'ready',
      height: 480,
      error: null,
      warning: 'A=(1,2): rejected',
    });
  });

  it('ignores a warning after the frame failed', () => {
    expect(ggbFrameReducer(failed, { type: 'ggb:warning', message: warning })).toBe(failed);
  });

  it('keeps a warning across the height that settles the card', () => {
    const warned: WidgetFrameState = {
      status: 'executing',
      height: 480,
      error: null,
      warning,
    };

    expect(ggbFrameReducer(warned, { type: 'ggb:height', height: 214 })).toEqual({
      status: 'ready',
      height: 214,
      error: null,
      warning,
    });

    /* A reset starts the batch over, so the height that follows it carries nothing. */
    const afterReset = ggbFrameReducer(warned, { type: 'ggb:reset' });

    expect(ggbFrameReducer(afterReset, { type: 'ggb:height', height: 214 })).toEqual({
      status: 'ready',
      height: 214,
      error: null,
      warning: null,
    });
  });

  it('clears a warning on a retry, and again when the frame ends up failing', () => {
    expect(ggbFrameReducer(ready, { type: 'ggb:reset' })).toEqual({
      status: 'executing',
      height: 480,
      error: null,
      warning: null,
    });
    expect(ggbFrameReducer(ready, { type: 'ggb:reboot' })).toEqual({
      status: 'booting',
      height: 480,
      error: null,
      warning: null,
    });
    expect(ggbFrameReducer(ready, { type: 'ggb:error', message: 'boom' })).toEqual({
      status: 'failed',
      height: 480,
      error: 'boom',
      warning: null,
    });
  });

  it('fails a card whose frame never reported ready', () => {
    expect(ggbFrameReducer(booting, { type: 'ggb:boot-timeout', message: 'timed out' })).toEqual({
      status: 'failed',
      height: 480,
      error: 'timed out',
      warning: null,
    });
  });

  /* The timer outlives the status it was armed for, so a stale dispatch has to be a
     no-op: otherwise a slow construction would be killed with the failure the user
     never earned. */
  it('ignores a boot timeout once the frame has reported in', () => {
    const timeout = { type: 'ggb:boot-timeout', message: 'timed out' } as const;

    expect(ggbFrameReducer(executing, timeout)).toBe(executing);
    expect(ggbFrameReducer(ready, timeout)).toBe(ready);
    expect(ggbFrameReducer(failed, timeout)).toBe(failed);
  });
});

describe('geogebraOrigin', () => {
  it('keeps the origin and drops a path or a trailing slash', () => {
    expect(geogebraOrigin('https://ggb.example.com')).toBe('https://ggb.example.com');
    expect(geogebraOrigin('https://ggb.example.com/')).toBe('https://ggb.example.com');
    expect(geogebraOrigin('https://ggb.example.com/ggb-runtime.html')).toBe(
      'https://ggb.example.com',
    );
    expect(geogebraOrigin('http://localhost:3081')).toBe('http://localhost:3081');
  });

  it.each([undefined, '', 'ggb.example.com', 'not a url', 'javascript:alert(1)', 'ftp://ggb.x'])(
    'rejects %p',
    (value) => {
      expect(geogebraOrigin(value)).toBeNull();
    },
  );
});

describe('the GeoGebra frame', () => {
  const origin = 'https://ggb.example.com';

  it('is served from the configured origin', () => {
    const props = getWidgetFrameProps(480, ggbFrameTarget(origin));

    expect(props.src).toBe('https://ggb.example.com/ggb-runtime.html');
    expect(props.referrerPolicy).toBe('no-referrer');
  });

  it('runs same-origin, which the widget frame must not', () => {
    const props = getWidgetFrameProps(480, ggbFrameTarget(origin));

    expect(props.sandbox).toBe(GEOGEBRA_FRAME_SANDBOX);
    expect(GEOGEBRA_FRAME_SANDBOX).toContain('allow-same-origin');
    expect(WIDGET_FRAME_SANDBOX).not.toContain('allow-same-origin');
  });

  it('clamps the height it is given, like the widget frame', () => {
    const props = getWidgetFrameProps(9000, ggbFrameTarget(origin));

    expect(props.style).toMatchObject({ height: WIDGET_HEIGHT_MAX });
  });
});
