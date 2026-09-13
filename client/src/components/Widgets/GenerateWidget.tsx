import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Alert, Button, Skeleton } from '@librechat/client';
import { resolveModelCatalogKey } from 'librechat-data-provider';
import { useGenerateWidgetMutation, useGetModelsQuery } from 'librechat-data-provider/react-query';
import type { WidgetHostCommand } from './frame';
import type { WidgetNodeProps } from './plugin';
import {
  clampWidgetHeight,
  getWidgetFrameProps,
  initialWidgetFrameState,
  observeWidgetDark,
  parseWidgetFrameEvent,
  readWidgetDark,
  widgetFrameReducer,
  WIDGET_HEIGHT_DEFAULT,
} from './frame';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { CardTagText } from './Tag';

interface WidgetFailure {
  key: string;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Prefer the API's own error text over the transport message axios adds. */
const readErrorMessage = (error: unknown, fallback: string): string => {
  if (!isRecord(error)) {
    return fallback;
  }
  const response = error.response;
  if (isRecord(response)) {
    const data = response.data;
    if (isRecord(data) && typeof data.error === 'string' && data.error.trim() !== '') {
      return data.error;
    }
  }
  if (typeof error.message === 'string' && error.message.trim() !== '') {
    return error.message;
  }
  return fallback;
};

function WidgetLoading({ label }: { label: string }) {
  return (
    <div className="space-y-2" role="status">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function WidgetError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const localize = useLocalize();
  return (
    <div className="space-y-2">
      <Alert variant="error">{message}</Alert>
      <Button onClick={onRetry} size="sm" variant="outline">
        {localize('com_ui_widget_retry')}
      </Button>
    </div>
  );
}

function WidgetCard({ node }: WidgetNodeProps) {
  const localize = useLocalize();
  const { properties } = node;
  const spec = properties.spec ?? '';
  const tagHeight = Number.parseFloat(properties.height ?? '');

  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: modelsConfig } = useGetModelsQuery();
  const { mutate } = useGenerateWidgetMutation();

  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [compiled, setCompiled] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<WidgetFailure | null>(null);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameReadyRef = useRef(false);
  const [dark, setDark] = useState(readWidgetDark);
  const postedDarkRef = useRef(dark);
  const initialHeight = Number.isFinite(tagHeight)
    ? clampWidgetHeight(tagHeight)
    : WIDGET_HEIGHT_DEFAULT;
  const [frameState, dispatch] = useReducer(
    widgetFrameReducer,
    initialHeight,
    initialWidgetFrameState,
  );

  /** Only endpoints the model catalog actually serves are offered, so a pick cannot
   *  produce a compile request the server's own model validation would reject. */
  const endpoints = useMemo(() => {
    if (!endpointsConfig || !modelsConfig) {
      return [];
    }
    return Object.keys(endpointsConfig).filter((key) => {
      const catalog = modelsConfig[resolveModelCatalogKey(key, modelsConfig)];
      return endpointsConfig[key] != null && catalog != null && catalog.length > 0;
    });
  }, [endpointsConfig, modelsConfig]);

  const models = useMemo(() => {
    if (!modelsConfig || endpoint === '') {
      return [];
    }
    return modelsConfig[resolveModelCatalogKey(endpoint, modelsConfig)] ?? [];
  }, [endpoint, modelsConfig]);

  const hasSelection = endpoint !== '' && model !== '';
  /* Endpoint keys and model ids cannot contain a pipe, so the first two fields of
     the key cannot be confused with the spec that follows them. */
  const cacheKey = hasSelection ? `${endpoint}|${model}|${spec}` : '';
  const code = compiled.get(cacheKey) ?? null;
  const isCompiling = pendingKey !== null && pendingKey === cacheKey;
  const failedCompile = failure !== null && failure.key === cacheKey ? failure.message : null;
  const frameFailed = frameState.status === 'failed';

  const postToFrame = useCallback((message: WidgetHostCommand) => {
    frameRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  /** The theme is read at post time, so a card compiled after a theme switch already
   *  carries the right one without either value being a dependency here. */
  const postCode = useCallback(
    (value: string) => {
      postToFrame({ type: 'widget:render', code: value, dark: readWidgetDark() });
    },
    [postToFrame],
  );

  const onGenerate = useCallback(() => {
    if (!hasSelection) {
      return;
    }
    setFailure(null);
    setPendingKey(cacheKey);
    mutate(
      { spec, endpoint, model },
      {
        onSuccess: (data) => {
          setCompiled((previous) => new Map(previous).set(cacheKey, data.code));
        },
        onError: (error) => {
          const message = readErrorMessage(error, localize('com_ui_widget_error'));
          setFailure({ key: cacheKey, message });
        },
        onSettled: () => {
          setPendingKey(null);
        },
      },
    );
  }, [cacheKey, endpoint, hasSelection, localize, model, mutate, spec]);

  const onFrameRetry = useCallback(() => {
    if (!code) {
      return;
    }
    dispatch({ type: 'widget:reset' });
    postCode(code);
  }, [code, postCode]);

  const onEndpointChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setEndpoint(event.target.value);
    setModel('');
  }, []);

  const onModelChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setModel(event.target.value);
  }, []);

  /**
   * The host answers only its own frame, and only with a payload the protocol
   * defines: the frame document is untrusted, so `event.origin` (which is `null`
   * for an opaque origin) settles nothing on its own.
   */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) {
        return;
      }
      const message = parseWidgetFrameEvent(event.data);
      if (!message) {
        return;
      }
      if (message.type === 'widget:ready') {
        frameReadyRef.current = true;
        if (code) {
          postCode(code);
        }
      }
      dispatch(message);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [code, postCode]);

  useEffect(() => {
    if (!code) {
      return;
    }
    dispatch({ type: 'widget:reset' });
    if (frameReadyRef.current) {
      postCode(code);
    }
  }, [code, postCode]);

  useEffect(() => observeWidgetDark(setDark), []);

  /**
   * The frame does not inherit the app's theme, so a change has to be pushed across.
   * It is a repaint there, not a re-render: nothing here invalidates `code`, so the
   * component the user is interacting with keeps its state. The first run is skipped
   * because the render payload already carries the theme.
   */
  useEffect(() => {
    if (postedDarkRef.current === dark) {
      return;
    }
    postedDarkRef.current = dark;
    postToFrame({ type: 'widget:theme', dark });
  }, [dark, postToFrame]);

  const title = localize('com_ui_widget_title');
  const frameTitle = localize('com_ui_widget_frame_title');
  const frameProps = getWidgetFrameProps(frameState.height);

  let body: React.ReactNode;
  if (endpointsConfig == null || modelsConfig == null) {
    body = <WidgetLoading label={localize('com_ui_loading')} />;
  } else if (endpoints.length === 0) {
    body = <p className="text-sm text-text-secondary">{localize('com_ui_widget_no_models')}</p>;
  } else if (!hasSelection) {
    body = <p className="text-sm text-text-secondary">{localize('com_ui_widget_choose_model')}</p>;
  } else if (isCompiling && code === null) {
    body = <WidgetLoading label={localize('com_ui_widget_generating')} />;
  } else if (failedCompile !== null) {
    body = <WidgetError message={failedCompile} onRetry={onGenerate} />;
  } else if (code === null) {
    body = (
      <Button onClick={onGenerate} size="sm" variant="outline">
        {localize('com_ui_widget_generate')}
      </Button>
    );
  } else {
    body = (
      <>
        {frameFailed ? (
          <WidgetError message={frameState.error ?? ''} onRetry={onFrameRetry} />
        ) : null}
        <iframe
          ref={frameRef}
          {...frameProps}
          title={frameTitle}
          className={frameFailed ? 'hidden' : frameProps.className}
        />
      </>
    );
  }

  /* Native selects rather than the shared popover: a message can carry several cards
     and re-renders on every streamed token, and the two fields are plain string lists,
     so the platform control carries the whole interaction. */
  return (
    <section
      aria-label={title}
      className="my-4 overflow-hidden rounded-lg border border-border-light bg-surface-secondary"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border-light px-3 py-2">
        <span className="text-sm font-medium text-text-primary">{title}</span>
        <div className="min-w-0 flex-1">
          <select
            aria-label={localize('com_ui_widget_endpoint')}
            className="w-full rounded-lg border border-border-light bg-surface-primary px-2 py-1 text-xs text-text-primary"
            value={endpoint}
            onChange={onEndpointChange}
          >
            <option value="">{localize('com_ui_widget_endpoint')}</option>
            {endpoints.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1">
          <select
            aria-label={localize('com_ui_widget_model')}
            className="w-full rounded-lg border border-border-light bg-surface-primary px-2 py-1 text-xs text-text-primary"
            value={model}
            onChange={onModelChange}
          >
            <option value="">{localize('com_ui_widget_model')}</option>
            {models.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
        {code ? (
          <Button disabled={isCompiling} onClick={onGenerate} size="sm" variant="outline">
            {localize('com_ui_widget_regenerate')}
          </Button>
        ) : null}
      </div>
      <div className="p-3">{body}</div>
    </section>
  );
}

/**
 * The deployment switch is read here so that with `interface.widgets` off the tag
 * never reaches the card: the message keeps the literal text the model wrote.
 */
export function GenerateWidget({ node }: WidgetNodeProps) {
  const { data: startupConfig } = useGetStartupConfig();
  /* `undefined` means the operator never set the key, which the server reads as enabled,
     so both sides gate on `!== false` over one value. */
  const widgetsEnabled = startupConfig?.interface?.widgets !== false;
  if (!widgetsEnabled || !node.properties.spec) {
    return <CardTagText raw={node.properties.raw ?? ''} />;
  }
  return <WidgetCard node={node} />;
}
