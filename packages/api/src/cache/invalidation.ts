import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';

/**
 * Every config-invalidation event travels one channel: the topic stays constant
 * so a subscriber needs exactly one subscription no matter how many tenants the
 * deployment serves, and the event itself carries what changed.
 */
export const CONFIG_INVALIDATION_CHANNEL = 'config:invalidate';

export const DEFAULT_INVALIDATION_THROTTLE_MS = 250;

/** Bounds the dedupe memory: a redelivery follows its original by one round
 *  trip, so an id evicted long before that cannot come back. */
export const DEFAULT_INVALIDATION_DEDUPE_LIMIT = 256;

export type ConfigInvalidationScope = 'base' | 'overrides';

/** What a peer instance should drop. Deliberately not an instruction to clear a
 *  specific key: the receiving instance owns its own key set. */
export interface ConfigInvalidationRequest {
  scope: ConfigInvalidationScope;
  /** Absent targets every tenant. */
  tenantId?: string;
}

export interface ConfigInvalidationEvent extends ConfigInvalidationRequest {
  /** Distinguishes a replayed copy of an event from a new one. */
  messageId: string;
  /** The emitting process, so a publisher can ignore its own echo. */
  originId: string;
}

/** Minimal publish surface; the shared ioredis client satisfies it. */
export interface ConfigInvalidationBus {
  publish: (channel: string, payload: string) => Promise<unknown>;
}

/** A subscribed Redis connection cannot serve ordinary commands, so this is
 *  always a dedicated connection rather than the shared cache client. */
export interface ConfigInvalidationSubscriber {
  subscribe: (channel: string) => Promise<unknown>;
  on: (event: 'message', listener: (channel: string, payload: string) => void) => unknown;
  disconnect: () => unknown;
}

export interface ConfigInvalidationChannelOptions {
  bus: ConfigInvalidationBus;
  /** Built lazily on `start`, so importing this module opens no connection. */
  createSubscriber: () => ConfigInvalidationSubscriber;
  /** Peer events arriving inside this window are applied together. Zero or
   *  less applies each event as it arrives. */
  throttleMs?: number;
  /** How many recently applied message ids to remember. */
  dedupeLimit?: number;
  instanceId?: string;
}

export interface ConfigInvalidationChannel {
  /** Applies peer events to the caller's caches. Repeat calls replace the handler. */
  start: (apply: (request: ConfigInvalidationRequest) => Promise<void>) => void;
  /** Notifies peer instances. Resolves without throwing. */
  broadcast: (scope: ConfigInvalidationScope, tenantId?: string) => Promise<void>;
  stop: () => void;
}

function isInvalidationEvent(value: unknown): value is ConfigInvalidationEvent {
  if (typeof value !== 'object' || value == null) {
    return false;
  }
  if (!('messageId' in value) || typeof value.messageId !== 'string') {
    return false;
  }
  if (!('originId' in value) || typeof value.originId !== 'string') {
    return false;
  }
  if (!('scope' in value) || (value.scope !== 'base' && value.scope !== 'overrides')) {
    return false;
  }
  return (
    !('tenantId' in value) || value.tenantId === undefined || typeof value.tenantId === 'string'
  );
}

/**
 * Minimal cross-instance invalidation channel for the app config caches.
 *
 * The caches it invalidates live in process memory by design, so a mutation on
 * one replica leaves every other replica serving the old config until its
 * entries expire — indefinitely for the base config, which is cached without a
 * TTL. Pub/sub is what makes such a write visible to its peers; nothing here
 * reads the keyspace, so an invalidation never issues a SCAN.
 *
 * A deployment with one instance, or without Redis, passes no channel at all:
 * the caller keeps only its local invalidation and no connection is opened.
 *
 * Messages are deduped by id and a burst inside `throttleMs` collapses into one
 * apply per scope, so N replicas saving config in quick succession cost a peer
 * one cache clear rather than N.
 */
export function createConfigInvalidationChannel(
  options: ConfigInvalidationChannelOptions,
): ConfigInvalidationChannel {
  const {
    bus,
    createSubscriber,
    throttleMs = DEFAULT_INVALIDATION_THROTTLE_MS,
    dedupeLimit = DEFAULT_INVALIDATION_DEDUPE_LIMIT,
  } = options;
  const instanceId = options.instanceId ?? randomUUID();

  let apply: ((request: ConfigInvalidationRequest) => Promise<void>) | undefined;
  let subscriber: ConfigInvalidationSubscriber | null = null;
  /** Insertion-ordered, so the first entry is always the oldest. */
  const seenMessageIds = new Set<string>();
  let pendingBase = false;
  /** `undefined` in the set means a clear that already covers every tenant. */
  let pendingTenants = new Set<string | undefined>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Returns false for a message id that was already applied. */
  function rememberMessageId(messageId: string): boolean {
    if (seenMessageIds.has(messageId)) {
      return false;
    }
    seenMessageIds.add(messageId);
    if (seenMessageIds.size > dedupeLimit) {
      for (const oldest of seenMessageIds) {
        seenMessageIds.delete(oldest);
        break;
      }
    }
    return true;
  }

  async function flush(): Promise<void> {
    const base = pendingBase;
    const tenants = pendingTenants;
    pendingBase = false;
    pendingTenants = new Set();
    flushTimer = null;

    const current = apply;
    if (current == null) {
      return;
    }

    const requests: ConfigInvalidationRequest[] = [];
    if (base) {
      requests.push({ scope: 'base' });
    }
    for (const tenantId of tenants) {
      requests.push(
        tenantId === undefined ? { scope: 'overrides' } : { scope: 'overrides', tenantId },
      );
    }

    for (const request of requests) {
      try {
        await current(request);
      } catch (error) {
        /** A peer's failed clear is not a reason to drop the rest of the batch. */
        logger.error('[ConfigInvalidation] Failed to apply peer invalidation:', error);
      }
    }
  }

  function enqueue(event: ConfigInvalidationEvent): void {
    if (event.scope === 'base') {
      pendingBase = true;
    } else {
      pendingTenants.add(event.tenantId);
    }
    if (flushTimer != null) {
      return;
    }
    if (throttleMs <= 0) {
      void flush();
      return;
    }
    flushTimer = setTimeout(() => {
      void flush();
    }, throttleMs);
    flushTimer.unref();
  }

  function onMessage(channel: string, payload: string): void {
    if (channel !== CONFIG_INVALIDATION_CHANNEL) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isInvalidationEvent(parsed)) {
      return;
    }
    /** Redis delivers a published message back to the publisher's own connection. */
    if (parsed.originId === instanceId) {
      return;
    }
    if (!rememberMessageId(parsed.messageId)) {
      return;
    }
    enqueue(parsed);
  }

  function start(next: (request: ConfigInvalidationRequest) => Promise<void>): void {
    apply = next;
    if (subscriber != null) {
      return;
    }
    let created: ConfigInvalidationSubscriber;
    try {
      created = createSubscriber();
    } catch (error) {
      logger.error(
        '[ConfigInvalidation] Subscriber unavailable; peer invalidations will go unobserved:',
        error,
      );
      return;
    }
    created.on('message', onMessage);
    subscriber = created;
    created.subscribe(CONFIG_INVALIDATION_CHANNEL).catch((error: unknown) => {
      /** ioredis re-issues subscriptions after a reconnect, so a failure here is
       *  not permanent — peers simply keep their cached config until then. */
      logger.error('[ConfigInvalidation] Subscribe failed:', error);
    });
  }

  async function broadcast(scope: ConfigInvalidationScope, tenantId?: string): Promise<void> {
    const event: ConfigInvalidationEvent = {
      messageId: randomUUID(),
      originId: instanceId,
      scope,
    };
    if (tenantId !== undefined) {
      event.tenantId = tenantId;
    }
    try {
      await bus.publish(CONFIG_INVALIDATION_CHANNEL, JSON.stringify(event));
    } catch (error) {
      /** The mutation is already persisted; a peer that misses the notification
       *  converges when its cache TTL expires. Failing the request here would
       *  report a saved config as unsaved. */
      logger.error('[ConfigInvalidation] Broadcast failed:', error);
    }
  }

  function stop(): void {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const current = subscriber;
    subscriber = null;
    if (current == null) {
      return;
    }
    try {
      current.disconnect();
    } catch (error) {
      logger.warn('[ConfigInvalidation] Subscriber disconnect failed:', error);
    }
  }

  return { start, broadcast, stop };
}
