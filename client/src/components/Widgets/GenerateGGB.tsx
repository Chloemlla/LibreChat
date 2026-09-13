import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Alert, Button } from '@librechat/client';
import type { GgbHostCommand, GgbNodeProps } from './plugin';
import {
  clampWidgetHeight,
  geogebraOrigin,
  getWidgetFrameProps,
  ggbFrameReducer,
  ggbFrameTarget,
  initialWidgetFrameState,
  observeWidgetDark,
  parseGgbFrameEvent,
  readWidgetDark,
  GGB_BOOT_TIMEOUT_MS,
  WIDGET_HEIGHT_DEFAULT,
} from './frame';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { CardTagText } from './Tag';

/** The applet draws its own progress inside the frame, so the host only announces the
 *  wait to assistive tech and leaves the frame's area to the construction. */
function GgbLoading({ label }: { label: string }) {
  return <span className="sr-only" role="status">{label}</span>;
}

function GgbError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const localize = useLocalize();
  return (
    <div className="space-y-2">
      <Alert variant="error">{message}</Alert>
      <Button onClick={onRetry} size="sm" variant="outline">{localize('com_ui_ggb_retry')}</Button>
    </div>
  );
}

function GgbCard({ node, origin }: { node: GgbNodeProps; origin: string }) {
  const localize = useLocalize();
  const { properties } = node;
  const commands = useMemo(
    () => (properties.commands ?? '').split('\n').filter((command) => command !== ''),
    [properties.commands],
  );
  const dropped = Number(properties.dropped ?? 0);
  const tagHeight = Number.parseFloat(properties.height ?? '');
  const initialHeight = Number.isFinite(tagHeight)
    ? clampWidgetHeight(tagHeight)
    : WIDGET_HEIGHT_DEFAULT;

  const [frameState, dispatch] = useReducer(
    ggbFrameReducer,
    initialHeight,
    initialWidgetFrameState,
  );
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameReadyRef = useRef(false);
  /* Bumped on every reboot so React drops the old document and loads a new one. */
  const [attempt, setAttempt] = useState(0);
  const [dark, setDark] = useState(readWidgetDark);
  const postedDarkRef = useRef(dark);

  /** This frame has a real origin, so it is addressed by that origin rather than `'*'`. */
  const postToFrame = useCallback(
    (message: GgbHostCommand) => {
      frameRef.current?.contentWindow?.postMessage(message, origin);
    },
    [origin],
  );

  /** The theme is read at post time, so commands posted after a theme switch already
   *  carry the right one without either value being a dependency here. */
  const postCommands = useCallback(() => {
    postToFrame({ type: 'ggb:commands', commands, dark: readWidgetDark() });
  }, [commands, postToFrame]);

  const onRetry = useCallback(() => {
    /* A frame that reported ready is still there, so replaying the commands is enough and
       avoids reloading the applet. A frame that never booted has nothing to replay into —
       the reload is the retry. */
    if (frameReadyRef.current) {
      dispatch({ type: 'ggb:reset' });
      postCommands();
      return;
    }
    dispatch({ type: 'ggb:reboot' });
    setAttempt((count) => count + 1);
  }, [postCommands]);

  /**
   * The frame is untrusted even though it has an origin: a message must come from the
   * configured origin *and* from the window this card mounted, so a card cannot be
   * driven by another applet, another card, or a page that happens to share the origin.
   */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.origin !== origin || event.source !== frame.contentWindow) {
        return;
      }
      const message = parseGgbFrameEvent(event.data);
      if (!message) {
        return;
      }
      if (message.type === 'ggb:ready') {
        frameReadyRef.current = true;
        postCommands();
      }
      dispatch(message);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [origin, postCommands]);

  /**
   * A reset means the frame is alive and only needs the commands again, so it waits for
   * the ready ping: before then there is nothing to replay into, and a mount-time reset
   * would spend `booting` — the one status that says the frame has not reported in yet —
   * before the frame had any chance to report.
   */
  useEffect(() => {
    if (!frameReadyRef.current) {
      return;
    }
    dispatch({ type: 'ggb:reset' });
    postCommands();
  }, [postCommands]);

  /**
   * The frame is a different origin, so a document that 404s, an origin that does not
   * answer and a bundle that never starts are all indistinguishable from here: no
   * `ggb:ready` ever arrives and the card would sit on an empty frame forever. The ready
   * ping is the only signal that the applet came up, so the wait for it is what is timed.
   */
  useEffect(() => {
    if (frameState.status !== 'booting') {
      return;
    }
    const timer = window.setTimeout(
      () => dispatch({ type: 'ggb:boot-timeout', message: localize('com_ui_ggb_boot_timeout') }),
      GGB_BOOT_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [frameState.status, localize]);

  useEffect(() => observeWidgetDark(setDark), []);

  /**
   * The frame does not inherit the app's theme, so a change has to be pushed across. It
   * is a repaint there, not a replay: nothing here invalidates `commands`, so the
   * construction the user is looking at is not rebuilt. The first run is skipped because
   * the commands payload already carries the theme.
   */
  useEffect(() => {
    if (postedDarkRef.current === dark) {
      return;
    }
    postedDarkRef.current = dark;
    postToFrame({ type: 'ggb:theme', dark });
  }, [dark, postToFrame]);

  const title = localize('com_ui_ggb_title');
  const frameTitle = localize('com_ui_ggb_frame_title');
  const frameProps = getWidgetFrameProps(frameState.height, ggbFrameTarget(origin));
  const frameFailed = frameState.status === 'failed';
  const pending = frameState.status === 'booting' || frameState.status === 'executing';

  return (
    <section
      aria-label={title}
      className="my-4 overflow-hidden rounded-lg border border-border-light bg-surface-secondary"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border-light px-3 py-2">
        <span className="text-sm font-medium text-text-primary">{title}</span>
      </div>
      <div className="space-y-2 p-3">
        {dropped > 0 ? (
          <Alert variant="warning">{localize('com_ui_ggb_truncated', { dropped })}</Alert>
        ) : null}
        {/* A dropped-command warning and a refused-command warning come from different
            places and can both apply, so neither replaces the other. */}
        {frameState.warning ? <Alert variant="warning">{frameState.warning}</Alert> : null}
        {frameFailed ? <GgbError message={frameState.error ?? ''} onRetry={onRetry} /> : null}
        {pending ? <GgbLoading label={localize('com_ui_ggb_loading')} /> : null}
        <iframe
          ref={frameRef}
          key={attempt}
          {...frameProps}
          title={frameTitle}
          className={frameFailed ? 'hidden' : frameProps.className}
        />
      </div>
    </section>
  );
}

/**
 * The deployment switch is read here: with no `interface.geogebraOrigin` there is no
 * origin to serve the frame from, so the tag never reaches the card and the message keeps
 * the literal text the model wrote — the same shape as a disabled widget.
 */
export function GenerateGGB({ node }: GgbNodeProps) {
  const { data: startupConfig } = useGetStartupConfig();
  const origin = geogebraOrigin(startupConfig?.interface?.geogebraOrigin);
  if (origin === null || !node.properties.commands) {
    return <CardTagText raw={node.properties.raw ?? ''} />;
  }
  return <GgbCard node={node} origin={origin} />;
}
