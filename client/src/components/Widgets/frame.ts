import type { CSSProperties, IframeHTMLAttributes } from 'react';

/** Static document copied into `dist/` by the `copyPublicAssets` vite plugin. */
export const WIDGET_RUNTIME_URL = '/widget-runtime.html';

/**
 * `allow-scripts` and nothing else. Without `allow-same-origin` the frame runs in an
 * opaque origin: it cannot read the parent document, its cookies or its storage, and
 * the parent cannot reach into it. Adding `allow-same-origin` back would let the frame
 * remove its own sandbox attribute, so this constant is deliberately not configurable.
 */
export const WIDGET_FRAME_SANDBOX = 'allow-scripts';

/**
 * `allow-scripts` *and* `allow-same-origin` — the pairing the widget frame above refuses.
 * GeoGebra's GWT bootstrap (`web3d.nocache.js`) loads the module into a hidden child
 * iframe and reads `child.contentWindow.document`; under an opaque origin that read
 * throws SecurityError and the bundle never starts, so the flag is not optional here.
 *
 * Together the two flags would let the frame reach this document, so what contains it is
 * where it is served from: `interface.geogebraOrigin` must be an origin that serves
 * nothing else of this app, and every message below is addressed to, and accepted only
 * from, that origin.
 */
export const GEOGEBRA_FRAME_SANDBOX = 'allow-scripts allow-same-origin';

/** The wrapper document the GeoGebra bundle boots in, served from the configured origin. */
export const GEOGEBRA_RUNTIME_DOCUMENT = 'ggb-runtime.html';

export const WIDGET_HEIGHT_DEFAULT = 320;
export const WIDGET_HEIGHT_MIN = 120;
export const WIDGET_HEIGHT_MAX = 1200;

/** The frame is untrusted: a reported height is bounded before it reaches the layout. */
export const clampWidgetHeight = (height: number): number =>
  Math.min(WIDGET_HEIGHT_MAX, Math.max(WIDGET_HEIGHT_MIN, Math.round(height)));

/**
 * The deployment's GeoGebra origin, or `null` when it is unset or unusable — a `null`
 * origin is what leaves a ggb tag as literal text, the way a disabled widget does.
 *
 * The value becomes an iframe `src` and a `postMessage` target both, so it is normalized
 * once here: `new URL` rejects anything that is not an absolute http(s) origin and drops
 * the path and trailing slash an operator may have written, leaving exactly the string
 * the frame's messages carry in `event.origin`.
 */
export const geogebraOrigin = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  try {
    const { protocol, origin } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? origin : null;
  } catch {
    return null;
  }
};

/**
 * How long a card waits for the frame's `ggb:ready` before it reports a boot failure.
 * The frame is a different origin, so a document that 404s, an origin that does not
 * answer, or a bundle that never starts are all indistinguishable from here and all
 * leave an empty card on screen — the ready ping is the only signal that the applet
 * came up. Generous next to a cold start (several seconds even on a warm cache),
 * because a false positive costs the user a working construction.
 */
export const GGB_BOOT_TIMEOUT_MS = 20_000;

/** The `src` and `sandbox` of one card's frame; the two card kinds differ in both. */
export interface WidgetFrameTarget {
  src: string;
  sandbox: string;
}

export const WIDGET_FRAME_TARGET: WidgetFrameTarget = {
  src: WIDGET_RUNTIME_URL,
  sandbox: WIDGET_FRAME_SANDBOX,
};

export const ggbFrameTarget = (origin: string): WidgetFrameTarget => ({
  src: `${origin}/${GEOGEBRA_RUNTIME_DOCUMENT}`,
  sandbox: GEOGEBRA_FRAME_SANDBOX,
});

/** The frame's `title` is set at the call site, where it can be localized. */
export const getWidgetFrameProps = (
  height: number,
  target: WidgetFrameTarget = WIDGET_FRAME_TARGET,
): IframeHTMLAttributes<HTMLIFrameElement> => ({
  src: target.src,
  sandbox: target.sandbox,
  referrerPolicy: 'no-referrer',
  className: 'w-full border-0 bg-transparent',
  style: { height: clampWidgetHeight(height) } as CSSProperties,
});

/** host → frame. `'*'` is the only usable target: the frame's origin is opaque. */
export interface WidgetRenderCommand {
  type: 'widget:render';
  code: string;
  /** Sent with the payload so the first paint is already in the right theme. */
  dark: boolean;
}

/** host → frame. Repaints the frame without re-mounting the component. */
export interface WidgetThemeCommand {
  type: 'widget:theme';
  dark: boolean;
}

export type WidgetHostCommand = WidgetRenderCommand | WidgetThemeCommand;

/**
 * host → frame. Unlike the widget above this one has a real origin, so it is addressed
 * by that origin rather than with `'*'`.
 */
export interface GgbCommandsCommand {
  type: 'ggb:commands';
  commands: string[];
  /** Sent with the payload so the first paint is already in the right theme. */
  dark: boolean;
}

/** host → frame. Repaints the frame without replaying the construction. */
export interface GgbThemeCommand {
  type: 'ggb:theme';
  dark: boolean;
}

export type GgbHostCommand = GgbCommandsCommand | GgbThemeCommand;

/** The class the theme provider toggles on the document root. */
export const WIDGET_DARK_CLASS = 'dark';

/**
 * The theme the application actually rendered: `ThemeProvider` toggles `dark` on the
 * document root (`packages/client/src/theme/context/ThemeProvider.tsx`), so reading that
 * class is reading what was rendered rather than reaching into a theme store.
 */
export const readWidgetDark = (): boolean =>
  document.documentElement.classList.contains(WIDGET_DARK_CLASS);

/**
 * Calls `onChange` only when the resolved theme moves. A frame does not inherit the
 * embedding page's theme — `prefers-color-scheme` inside it follows the OS — so every
 * change has to be pushed across the boundary.
 */
export const observeWidgetDark = (onChange: (dark: boolean) => void): (() => void) => {
  let current = readWidgetDark();
  const observer = new MutationObserver(() => {
    const next = readWidgetDark();
    if (next === current) {
      return;
    }
    current = next;
    onChange(next);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};

/** frame → host. */
export type WidgetFrameEvent =
  | { type: 'widget:ready' }
  | { type: 'widget:height'; height: number }
  | { type: 'widget:error'; message: string };

/** Host-side actions that are not frame events, so the reducer holds every transition. */
export type WidgetFrameAction = WidgetFrameEvent | { type: 'widget:reset' };

/** frame → host. */
export type GgbFrameEvent =
  | { type: 'ggb:ready' }
  | { type: 'ggb:height'; height: number }
  | { type: 'ggb:warning'; message: string }
  | { type: 'ggb:error'; message: string };

/**
 * `ggb:warning` is not a failure: commands the applet refused are reported here and the
 * card keeps rendering the rest. `ggb:reset` and `ggb:reboot` both retry, but from
 * opposite ends — `ggb:reset` means the frame is alive and only needs the commands
 * replayed (back to `executing`), while `ggb:reboot` means the frame never came up, so
 * the only retry is a new iframe (back to `booting`).
 */
export type GgbFrameAction =
  | GgbFrameEvent
  | { type: 'ggb:reset' }
  | { type: 'ggb:reboot' }
  | { type: 'ggb:boot-timeout'; message: string };

/** The label a card takes while its payload is in flight, before the frame reports back. */
export type WidgetFramePendingStatus = 'rendering' | 'executing';

/**
 * `booting` — the frame document is loading; `rendering`/`executing` — the payload is
 * posted and the frame has not reported its height yet; `ready` — it has; `failed` — the
 * frame or the payload threw, and the message is shown instead.
 *
 * Both card kinds run this machine and differ only in that middle label — a widget
 * *renders*, a construction *executes* — so there is one state and one reducer, told
 * which label its protocol uses.
 *
 * `warning` sits beside the status rather than in it: it is a non-terminal channel that
 * carries what the frame could not do without changing where the card is, so a card can
 * be `ready` and still have something to report. `error` is the opposite — it only ever
 * accompanies `failed`.
 */
export type WidgetFrameStatus = 'booting' | WidgetFramePendingStatus | 'ready' | 'failed';

export interface WidgetFrameState {
  status: WidgetFrameStatus;
  height: number;
  error: string | null;
  warning: string | null;
}

export const MAX_WIDGET_ERROR_LENGTH = 300;

export const initialWidgetFrameState = (height = WIDGET_HEIGHT_DEFAULT): WidgetFrameState => ({
  status: 'booting',
  height: clampWidgetHeight(height),
  error: null,
  warning: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Narrow an incoming `message` payload to the protocol. Everything the frame sends is
 * untrusted — it is a document this app does not control at parse time — so an
 * unrecognised shape is dropped rather than coerced.
 */
export function parseWidgetFrameEvent(data: unknown): WidgetFrameEvent | null {
  if (!isRecord(data) || typeof data.type !== 'string') {
    return null;
  }

  switch (data.type) {
    case 'widget:ready':
      return { type: 'widget:ready' };
    case 'widget:height':
      return typeof data.height === 'number' && Number.isFinite(data.height)
        ? { type: 'widget:height', height: clampWidgetHeight(data.height) }
        : null;
    case 'widget:error':
      return typeof data.message === 'string'
        ? { type: 'widget:error', message: data.message.slice(0, MAX_WIDGET_ERROR_LENGTH) }
        : null;
    default:
      return null;
  }
}

export function parseGgbFrameEvent(data: unknown): GgbFrameEvent | null {
  if (!isRecord(data) || typeof data.type !== 'string') {
    return null;
  }

  switch (data.type) {
    case 'ggb:ready':
      return { type: 'ggb:ready' };
    case 'ggb:height':
      return typeof data.height === 'number' && Number.isFinite(data.height)
        ? { type: 'ggb:height', height: clampWidgetHeight(data.height) }
        : null;
    case 'ggb:warning':
      return typeof data.message === 'string'
        ? { type: 'ggb:warning', message: data.message.slice(0, MAX_WIDGET_ERROR_LENGTH) }
        : null;
    case 'ggb:error':
      return typeof data.message === 'string'
        ? { type: 'ggb:error', message: data.message.slice(0, MAX_WIDGET_ERROR_LENGTH) }
        : null;
    default:
      return null;
  }
}

/**
 * One machine for both protocols: a ready ping arms the card, a height report settles it,
 * an error fails it, and a resend clears a failure while keeping the last height. The
 * label a card enters while its payload is in flight is the only difference, so it is an
 * argument rather than a second switch that has to be kept in step with this one.
 *
 * A warning rides alongside the status instead of moving it — the frame is telling the
 * host what it could not execute, not asking the card to stop showing what it did. A
 * boot timeout is the one action that has to prove itself: it only fires while the card
 * is still `booting`, because any other status proves the frame reported in and the
 * timer's dispatch is simply stale.
 */
const frameReducer = (
  state: WidgetFrameState,
  action: WidgetFrameAction | GgbFrameAction,
  pending: WidgetFramePendingStatus,
): WidgetFrameState => {
  switch (action.type) {
    case 'widget:reset':
    case 'ggb:reset':
      return { status: pending, height: state.height, error: null, warning: null };
    case 'ggb:reboot':
      return { status: 'booting', height: state.height, error: null, warning: null };
    case 'widget:ready':
    case 'ggb:ready':
      /* A frame that already failed is not re-armed by a stray ready. */
      return state.status === 'booting'
        ? { status: pending, height: state.height, error: null, warning: null }
        : state;
    case 'widget:height':
    case 'ggb:height':
      /* A late height report must not resurrect a card the frame already errored on. */
      return state.status === 'failed'
        ? state
        : { status: 'ready', height: action.height, error: null, warning: state.warning };
    case 'ggb:warning':
      return state.status === 'failed' ? state : { ...state, warning: action.message };
    case 'ggb:boot-timeout':
      /* Only a frame that never reported ready can time out booting: any other status
         means the ping arrived, so the timer's dispatch is stale and must be a no-op
         rather than a failure the user never earned. */
      return state.status === 'booting'
        ? { status: 'failed', height: state.height, error: action.message, warning: null }
        : state;
    case 'widget:error':
    case 'ggb:error':
      return { status: 'failed', height: state.height, error: action.message, warning: null };
  }
};

export const widgetFrameReducer = (state: WidgetFrameState, action: WidgetFrameAction) =>
  frameReducer(state, action, 'rendering');

export const ggbFrameReducer = (state: WidgetFrameState, action: GgbFrameAction) =>
  frameReducer(state, action, 'executing');
