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

import type { RelayOptions, FinalState, ProgressState, RelayEvent } from "./index";

export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

type MaybePromise<T> = T | Promise<T>;

export interface SqliteStatement {
  run: (...params: unknown[]) => MaybePromise<unknown>;
  get: (...params: unknown[]) => MaybePromise<unknown>;
}

export interface SqliteDatabase {
  /** Optional direct exec hook used for table/index creation. */
  exec?: (sql: string) => MaybePromise<unknown>;
  /** Async sqlite wrappers commonly expose run/get directly. */
  run?: (sql: string, params?: readonly unknown[]) => MaybePromise<unknown>;
  get?: (sql: string, params?: readonly unknown[]) => MaybePromise<unknown>;
  /** better-sqlite3 and node:sqlite expose prepared statements. */
  prepare?: (sql: string) => SqliteStatement;
}

interface PersistedState<TMeta> {
  buffer: string;
  events?: RelayEvent[];
  status: "streaming" | "complete" | "error";
  lastEventAt: number;
  final?: FinalState<TMeta>;
  completed_at?: number;
  progress?: ProgressState;
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

export interface SqliteStorageOptions extends KvStorageOptions {
  /** Table used for persisted stream records. Default: `stream_relay`. */
  tableName?: string;
  /** Create the table/index on first use. Default true. */
  initialize?: boolean;
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
  const seedPromises = new Map<string, Promise<PersistedState<TMeta>>>();
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

  const emptyState = (): PersistedState<TMeta> => ({
    buffer: "",
    events: [],
    status: "streaming",
    lastEventAt: Date.now(),
  });

  const seed = async (id: string): Promise<PersistedState<TMeta>> => {
    const cached = pendingState.get(id);
    if (cached) return cached;
    const existing = seedPromises.get(id);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const raw = await kv.get(keyFor(id));
        if (!raw) return emptyState();
        const parsed = JSON.parse(raw) as PersistedState<TMeta>;
        return { ...parsed, events: parsed.events ?? [] };
      } catch (err) {
        console.error("[stream-relay] kv seed failed", err);
        return emptyState();
      }
    })();

    seedPromises.set(id, promise);
    const state = await promise;
    seedPromises.delete(id);
    const current = pendingState.get(id);
    if (current) return current;
    pendingState.set(id, state);
    return state;
  };

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
      const prior = await seed(id);
      // Reconstruct the running buffer. We can't ask the relay core for
      // the full buffer here (it'd be circular), so we accumulate from
      // chunks. `offset` is the new total length, which lets us validate
      // accumulation matches.
      const state: PersistedState<TMeta> = {
        ...prior,
        events: prior.events ?? [],
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

    onEvent: async (id, event, eventOffset) => {
      const prior = await seed(id);
      const events = [...(prior.events ?? []), event];
      const state: PersistedState<TMeta> = {
        ...prior,
        events,
        lastEventAt: Date.now(),
      };
      pendingState.set(id, state);
      if (eventOffset !== events.length) {
        console.warn(
          `[stream-relay] event offset mismatch for ${id}: ${events.length} vs ${eventOffset}`,
        );
      }
      if (flushInterval === 0) {
        await setState(id, state);
      } else {
        scheduleFlush(id);
      }
      if (options.onEvent) await options.onEvent(id, event, eventOffset);
    },

    onProgress: async (id, progress) => {
      const prior = await seed(id);
      const state: PersistedState<TMeta> = {
        ...prior,
        events: prior.events ?? [],
        progress,
        lastEventAt: progress.updated_at,
      };
      pendingState.set(id, state);
      if (flushInterval === 0) {
        await setState(id, state);
      } else {
        scheduleFlush(id);
      }
      if (options.onProgress) await options.onProgress(id, progress);
    },

    onComplete: async (id, final) => {
      const pending = await seed(id);
      const state: PersistedState<TMeta> = {
        buffer: final.text,
        events: final.events ?? pending.events ?? [],
        status: "complete",
        lastEventAt: Date.now(),
        final,
        completed_at: Date.now(),
        progress: pending?.progress,
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
      const prior = await seed(id);
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
      const t = flushTimers.get(id);
      if (t) {
        clearTimeout(t);
        flushTimers.delete(id);
      }
      pendingState.delete(id);
      seedPromises.delete(id);
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
          events: parsed.events ?? [],
          status: parsed.status,
          lastEventAt: parsed.lastEventAt,
          final: parsed.final,
          completed_at: parsed.completed_at,
          progress: parsed.progress,
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
 * SQLite-backed persistence for local Node servers. This is intentionally
 * driver-neutral: pass a database object from `better-sqlite3`, `node:sqlite`,
 * or an async wrapper that exposes `run/get`.
 *
 *   import Database from "better-sqlite3";
 *   createRelayApp(withSqliteStorage(new Database("relay.db"), { upstream }));
 *
 * No sqlite driver is bundled with stream-relay; choose the one that fits your
 * runtime and pass the opened database here.
 */
export function withSqliteStorage<TPayload, TMeta>(
  db: SqliteDatabase,
  options: RelayOptions<TPayload, TMeta> & SqliteStorageOptions,
): RelayOptions<TPayload, TMeta> {
  return withKvStorage(sqliteKvFromDatabase(db, options), options);
}

export function sqliteKvFromDatabase(
  db: SqliteDatabase,
  options: SqliteStorageOptions = {},
): KVStore {
  const table = validateSqliteIdentifier(options.tableName ?? "stream_relay");
  const initialize = options.initialize ?? true;
  let initPromise: Promise<void> | undefined;

  const init = async () => {
    if (!initialize) return;
    if (!initPromise) {
      initPromise = (async () => {
        await execSql(db, `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`);
        await execSql(db, `CREATE INDEX IF NOT EXISTS ${table}_expires_at_idx ON ${table} (expires_at)`);
      })();
    }
    await initPromise;
  };

  return {
    get: async (key) => {
      await init();
      const row = await getSql<{ value: string; expires_at?: number | null }>(
        db,
        `SELECT value, expires_at FROM ${table} WHERE key = ?`,
        [key],
      );
      if (!row) return null;
      if (row.expires_at && row.expires_at <= Date.now()) {
        await runSql(db, `DELETE FROM ${table} WHERE key = ?`, [key]);
        return null;
      }
      return row.value;
    },
    set: async (key, value, opts) => {
      await init();
      const expiresAt = opts?.ttlSeconds ? Date.now() + opts.ttlSeconds * 1000 : null;
      await runSql(
        db,
        `INSERT INTO ${table} (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
        [key, value, expiresAt],
      );
    },
    delete: async (key) => {
      await init();
      await runSql(db, `DELETE FROM ${table} WHERE key = ?`, [key]);
    },
  };
}

function validateSqliteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid sqlite table name: ${identifier}`);
  }
  return identifier;
}

async function execSql(db: SqliteDatabase, sql: string): Promise<void> {
  if (db.exec) {
    await db.exec(sql);
    return;
  }
  await runSql(db, sql, []);
}

async function runSql(db: SqliteDatabase, sql: string, params: readonly unknown[]): Promise<void> {
  if (db.run) {
    await db.run(sql, params);
    return;
  }
  if (db.prepare) {
    await db.prepare(sql).run(...params);
    return;
  }
  throw new Error("sqlite database must expose run() or prepare()");
}

async function getSql<T>(db: SqliteDatabase, sql: string, params: readonly unknown[]): Promise<T | null | undefined> {
  if (db.get) {
    return (await db.get(sql, params)) as T | null | undefined;
  }
  if (db.prepare) {
    return (await db.prepare(sql).get(...params)) as T | null | undefined;
  }
  throw new Error("sqlite database must expose get() or prepare()");
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
