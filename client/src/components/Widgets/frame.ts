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

export const WIDGET_HEIGHT_DEFAULT = 320;
export const WIDGET_HEIGHT_MIN = 120;
export const WIDGET_HEIGHT_MAX = 1200;

/** The frame is untrusted: a reported height is bounded before it reaches the layout. */
export const clampWidgetHeight = (height: number): number =>
  Math.min(WIDGET_HEIGHT_MAX, Math.max(WIDGET_HEIGHT_MIN, Math.round(height)));

/** The frame's `title` is set at the call site, where it can be localized. */
export const getWidgetFrameProps = (height: number): IframeHTMLAttributes<HTMLIFrameElement> => ({
  src: WIDGET_RUNTIME_URL,
  sandbox: WIDGET_FRAME_SANDBOX,
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

/**
 * `booting` — the frame document is loading; `rendering` — code posted, awaiting a
 * report; `ready` — the frame mounted the component and reported its height;
 * `failed` — the runtime or the component threw, and the message is shown instead.
 */
export type WidgetFrameStatus = 'booting' | 'rendering' | 'ready' | 'failed';

export interface WidgetFrameState {
  status: WidgetFrameStatus;
  height: number;
  error: string | null;
}

export const MAX_WIDGET_ERROR_LENGTH = 300;

export const initialWidgetFrameState = (height = WIDGET_HEIGHT_DEFAULT): WidgetFrameState => ({
  status: 'booting',
  height: clampWidgetHeight(height),
  error: null,
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

export function widgetFrameReducer(
  state: WidgetFrameState,
  action: WidgetFrameAction,
): WidgetFrameState {
  switch (action.type) {
    case 'widget:reset':
      return { status: 'rendering', height: state.height, error: null };
    case 'widget:ready':
      /* A frame that already failed is not re-armed by a stray ready. */
      return state.status === 'booting'
        ? { status: 'rendering', height: state.height, error: null }
        : state;
    case 'widget:height':
      /* A late height report must not resurrect a card the frame already errored on. */
      return state.status === 'failed'
        ? state
        : { status: 'ready', height: action.height, error: null };
    case 'widget:error':
      return { status: 'failed', height: state.height, error: action.message };
  }
}
