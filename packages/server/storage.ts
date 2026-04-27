/**
 * Pluggable persistence helpers. The relay core only needs four async
 * operations to durably save and rehydrate streams; this file bundles
 * common wiring against two minimal interfaces:
 *
 *   - `KVStore`: the surface every key-value store exposes (get/set/delete).
 *     Works with Cloudflare KV, Redis, Upstash, in-memory Maps, anything.
 *   - `withKvStorage(kv, options)`: takes a KVStore and returns a
 *     RelayOptions object with onAppend/onComplete/onError/hydrate
 *     pre-wired. Drop-in replacement for callers who want durability
 *     without writing their own hooks.
 *
 * If you need different semantics (per-chunk batching, compression,
 * sharded keys), copy this file and adapt. The relay core never reaches
 * into storage directly, so any layer you build between is fine.
 */

import type { RelayOptions, FinalState } from "./index";

export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

interface PersistedState<TMeta> {
  buffer: string;
  status: "streaming" | "complete" | "error";
  lastEventAt: number;
  final?: FinalState<TMeta>;
  completed_at?: number;
  error?: string;
}

export interface KvStorageOptions {
  /**
   * Key prefix for all relay entries. Defaults to `"stream-relay:"`. Lets
   * you share one KV namespace across multiple relays without collisions.
   */
  prefix?: string;
  /**
   * If set, KV writes are coalesced: chunks within `flushIntervalMs` of
   * each other are batched into one write. Reduces KV op cost on busy
   * streams at the cost of a slightly larger window where the in-memory
   * buffer is ahead of storage. Default: 500ms. Set to 0 to write on
   * every chunk (most durable, most expensive).
   */
  flushIntervalMs?: number;
  /** Optional TTL for persisted records, in seconds. Passed to KV adapters that support it. */
  ttlSeconds?: number;
  /** Delete persisted terminal records when the core GC evicts them. Default true. */
  deleteOnGc?: boolean;
}

/**
 * Wraps relay options with KV-backed persistence. The relay still runs
 * in-memory at full speed; KV writes happen asynchronously in the
 * background and never block the upstream.
 *
 *   const { app } = createRelayApp(
 *     withKvStorage(myKv, {
 *       upstream: async ({ payload, write }) => { ... },
 *     }),
 *   );
 *
 * On rehydrate, the relay reads the entire saved state and replays it.
 * This is the right tradeoff for streams up to a few MB; beyond that
 * you'll want chunked storage (copy this file and adapt).
 */
export function withKvStorage<TPayload, TMeta>(
  kv: KVStore,
  options: RelayOptions<TPayload, TMeta> & KvStorageOptions,
): RelayOptions<TPayload, TMeta> {
  const prefix = options.prefix ?? "stream-relay:";
  const flushInterval = options.flushIntervalMs ?? 500;
  const ttlSeconds = options.ttlSeconds;
  const deleteOnGc = options.deleteOnGc ?? true;

  // Per-stream batched writers. A trailing-edge debounce: chunks within
  // `flushInterval` accumulate, then one write fires. The latest chunk's
  // offset becomes the saved offset, so a crash mid-flush still leaves
  // a coherent state at some prior offset.
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingState = new Map<string, PersistedState<TMeta>>();
  const queues = new Map<string, Promise<unknown>>();

  const keyFor = (id: string) => `${prefix}${id}`;
  const enqueue = <T>(id: string, fn: () => Promise<T>) => {
    const next = (queues.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(fn);
    queues.set(id, next);
    void next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    });
    return next;
  };
  const setState = (id: string, state: PersistedState<TMeta>) =>
    enqueue(id, () => kv.set(keyFor(id), JSON.stringify(state), { ttlSeconds }));

  const scheduleFlush = (id: string) => {
    if (flushTimers.has(id)) return;
    const timer = setTimeout(async () => {
      flushTimers.delete(id);
      const state = pendingState.get(id);
      if (!state) return;
      try {
        await setState(id, state);
      } catch (err) {
        console.error("[stream-relay] kv flush failed", err);
      }
    }, flushInterval);
    flushTimers.set(id, timer);
  };

  return {
    ...options,

    onAppend: async (id, _chunk, offset) => {
      const prior = pendingState.get(id) ?? {
        buffer: "",
        status: "streaming" as const,
        lastEventAt: Date.now(),
      };
      // Reconstruct the running buffer. We can't ask the relay core for
      // the full buffer here (it'd be circular), so we accumulate from
      // chunks. `offset` is the new total length, which lets us validate
      // accumulation matches.
      const state = {
        ...prior,
        buffer: prior.buffer + _chunk,
        lastEventAt: Date.now(),
      };
      pendingState.set(id, state);
      // Sanity check, mostly for debugging upstreams that emit weird
      // chunks. The relay core itself enforces monotonic offsets.
      const expected = prior.buffer.length + _chunk.length;
      if (expected !== offset) {
        console.warn(
          `[stream-relay] offset mismatch for ${id}: ${expected} vs ${offset}`,
        );
      }
      if (flushInterval === 0) {
        await setState(id, state);
      } else {
        scheduleFlush(id);
      }

      // Chain user-provided hook if they also want raw onAppend events.
      if (options.onAppend) await options.onAppend(id, _chunk, offset);
    },

    onComplete: async (id, final) => {
      const state: PersistedState<TMeta> = {
        buffer: final.text,
        status: "complete",
        lastEventAt: Date.now(),
        final,
        completed_at: Date.now(),
      };
      pendingState.set(id, state);
      // Cancel any pending debounce; write final state immediately.
      const t = flushTimers.get(id);
      if (t) {
        clearTimeout(t);
        flushTimers.delete(id);
      }
      try {
        await setState(id, state);
      } catch (err) {
        console.error("[stream-relay] kv complete write failed", err);
      }
      pendingState.delete(id);

      if (options.onComplete) await options.onComplete(id, final);
    },

    onError: async (id, message) => {
      const prior = pendingState.get(id) ?? {
        buffer: "",
        status: "streaming" as const,
        lastEventAt: Date.now(),
      };
      const state: PersistedState<TMeta> = {
        ...prior,
        status: "error",
        error: message,
        lastEventAt: Date.now(),
      };
      const t = flushTimers.get(id);
      if (t) {
        clearTimeout(t);
        flushTimers.delete(id);
      }
      try {
        await setState(id, state);
      } catch (err) {
        console.error("[stream-relay] kv error write failed", err);
      }
      pendingState.delete(id);

      if (options.onError) await options.onError(id, message);
    },

    onGc: async (id) => {
      if (options.onGc) await options.onGc(id);
      if (deleteOnGc && kv.delete) {
        await enqueue(id, () => kv.delete?.(keyFor(id)) ?? Promise.resolve());
      }
    },

    hydrate: async (id) => {
      // User-provided hydrate wins if set. Otherwise read from KV.
      if (options.hydrate) {
        const fromUser = await options.hydrate(id);
        if (fromUser) return fromUser;
      }
      try {
        const raw = await kv.get(keyFor(id));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedState<TMeta>;
        return {
          buffer: parsed.buffer,
          status: parsed.status,
          lastEventAt: parsed.lastEventAt,
          final: parsed.final,
          completed_at: parsed.completed_at,
          error: parsed.error,
        };
      } catch (err) {
        console.error("[stream-relay] kv hydrate failed", err);
        return null;
      }
    },
  };
}

/**
 * Tiny adapter: turns a Cloudflare KV namespace into the generic KVStore
 * shape this module expects. Use this when wiring withKvStorage in a
 * Worker that uses the Hono adapter (or the relay core directly).
 *
 *   import { kvFromCloudflare } from "@hs-uix/stream-relay/server";
 *   const kv = kvFromCloudflare(env.MY_KV);
 *   createRelayApp(withKvStorage(kv, { upstream: ... }));
 */
export function kvFromCloudflare(
  ns: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  },
): KVStore {
  return {
    get: (key) => ns.get(key),
    set: (key, value, opts) =>
      ns.put(key, value, opts?.ttlSeconds ? { expirationTtl: opts.ttlSeconds } : undefined),
    delete: (key) => ns.delete(key),
  };
}
