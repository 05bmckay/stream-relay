/**
 * Framework-agnostic core. Holds an in-memory map of stream buffers and
 * exposes two pure functions: `handleStart` and `handlePoll`. The Hono and
 * Worker adapters wrap these with their respective HTTP machinery; tests can
 * call them directly without spinning up a server.
 *
 * Persistence is opt-in via callbacks. Default behavior is in-memory only —
 * if the process dies, in-flight streams die with it. That's fine for the
 * common case (LLM proxy with single-region deployment); users who need
 * durability wire up `onAppend` / `hydrate` to their store of choice.
 */

import {
  PROTOCOL_VERSION,
  type PollResponse,
  type ProgressState,
  type RelayEvent,
  type RelayError,
  type StartRequest,
  type StartResponse,
  type StreamStatus,
} from "../shared/protocol";

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Function the host app provides to actually run the upstream work. Receives
 * the `payload` from `StartRequest` and a `writer` to push string data back
 * into the relay buffer. Resolve to mark `complete`; throw to mark `error`.
 *
 * Hosts can stream plain visible text with `write()` and structured side-channel
 * messages with `emit()`. These are intentionally separate resumable channels.
 */
export type UpstreamHandler<TPayload = unknown, TMeta = unknown> = (
  ctx: UpstreamContext<TPayload, TMeta>,
) => Promise<TMeta | void>;

export interface UpstreamContext<TPayload = unknown, TMeta = unknown> {
  streamId: string;
  payload: TPayload;
  /** Append string data to the visible text buffer. Bumps `lastEventAt`. */
  write: (chunk: string) => void;
  /** Emit an ordered structured event without appending to the visible text buffer. */
  emit: <TEvent extends RelayEvent>(event: TEvent) => void;
  /**
   * Bump `lastEventAt` without writing. Use during long silent operations
   * (tool calls, "thinking" phases) to keep the client's stall detector
   * happy without polluting the visible buffer.
   */
  heartbeat: () => void;
  /**
   * Publish app-level progress without appending to the visible text buffer.
   * Use for messages like "Searching CRM..." or "Calling tool...".
   */
  progress: (update: string | Omit<ProgressState, "updated_at">) => void;
  /** Aborted when no client has polled in `streamTtlMs`. */
  signal: AbortSignal;
}

export interface RelayOptions<TPayload = unknown, TMeta = unknown> {
  /** Required: how to actually run the upstream work. */
  upstream: UpstreamHandler<TPayload, TMeta>;

  /**
   * Garbage-collect finished streams and abort streaming streams that haven't
   * been polled in this long. Default 10 minutes. Set high if you want long
   * resume windows, low if memory/upstream cost is tight.
   */
  streamTtlMs?: number;

  /**
   * Optional persistence hooks. All async, all best-effort: the relay logs
   * failures and continues. None of these are required for correctness;
   * they exist so durable backends can layer on without forking.
   */
  onAppend?: (streamId: string, chunk: string, offset: number) => Promise<void>;
  /**
   * Called after an event has been appended. `eventOffset` is the new total
   * event count (1-indexed), equivalent to the `nextEventOffset` a client
   * poll would see immediately after this event.
   */
  onEvent?: (streamId: string, event: RelayEvent, eventOffset: number) => Promise<void>;
  onComplete?: (streamId: string, final: FinalState<TMeta>) => Promise<void>;
  onError?: (streamId: string, error: string) => Promise<void>;
  onProgress?: (streamId: string, progress: ProgressState) => Promise<void>;
  /** Called when in-memory GC removes a terminal stream record. */
  onGc?: (streamId: string) => Promise<void>;

  /**
   * Called when a poll lands for a streamId we don't have in memory. Return
   * the persisted state to rehydrate, or null to return `not_found`. This is
   * the durability escape hatch.
   */
  hydrate?: (streamId: string) => Promise<HydratedState<TMeta> | null>;

  /**
   * ID generator for `POST /streams` when the client doesn't supply one.
   * Defaults to `crypto.randomUUID()` where available.
   */
  generateId?: () => string;
}

export interface FinalState<TMeta = unknown> {
  text: string;
  /** Snapshot of structured events at completion. */
  events?: RelayEvent[];
  meta?: TMeta;
}

export interface HydratedState<TMeta = unknown> {
  buffer: string;
  events?: RelayEvent[];
  status: Exclude<StreamStatus, "not_found">;
  lastEventAt: number;
  final?: FinalState<TMeta>;
  error?: string;
  completed_at?: number;
  progress?: ProgressState;
}

export interface Relay {
  handleStart: (req: StartRequest) => Promise<StartResponse>;
  handlePoll: (
    streamId: string,
    since: number,
    eventSince?: number,
  ) => Promise<PollResponse>;
  /** Test/admin helper. Returns undefined if unknown. */
  inspect: (streamId: string) => StreamRecord | undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────

interface StreamRecord<TMeta = unknown> {
  streamId: string;
  buffer: string;
  events: RelayEvent[];
  status: StreamStatus;
  lastEventAt: number;
  lastPolledAt: number;
  startedAt: number;
  final?: FinalState<TMeta>;
  error?: string;
  completed_at?: number;
  progress?: ProgressState;
  abort: AbortController;
  /** Serializes async persistence hooks while keeping write()/emit() synchronous. */
  hookQueue: Promise<unknown>;
  inactivityTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createRelay<TPayload = unknown, TMeta = unknown>(
  options: RelayOptions<TPayload, TMeta>,
): Relay {
  const streams = new Map<string, StreamRecord<TMeta>>();
  const ttl = options.streamTtlMs ?? DEFAULT_TTL_MS;
  const genId =
    options.generateId ??
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const randomUUID = (globalThis as any).crypto?.randomUUID;
      if (typeof randomUUID !== "function") {
        throw new Error("crypto.randomUUID is required; provide options.generateId in this runtime");
      }
      return randomUUID.call((globalThis as any).crypto);
    });

  function gc() {
    const now = Date.now();
    for (const [id, rec] of streams) {
      if (rec.status === "streaming") continue;
      if (now - rec.lastPolledAt > ttl) {
        if (rec.inactivityTimer) clearTimeout(rec.inactivityTimer);
        streams.delete(id);
        if (options.onGc) {
          options
            .onGc(id)
            .catch((e) => console.error("[relay] onGc hook failed", e));
        }
      }
    }
  }

  function scheduleInactivityAbort(rec: StreamRecord<TMeta>) {
    if (rec.inactivityTimer) clearTimeout(rec.inactivityTimer);
    if (rec.status !== "streaming") return;

    rec.inactivityTimer = setTimeout(() => {
      if (rec.status !== "streaming") return;
      const now = Date.now();
      if (now - rec.lastPolledAt < ttl) {
        scheduleInactivityAbort(rec);
        return;
      }

      const message = "stream aborted after client inactivity";
      rec.status = "error";
      rec.error = message;
      rec.lastEventAt = now;
      rec.abort.abort();
      if (options.onError) {
        queueHook(rec, "onError", () => options.onError!(rec.streamId, message));
      }
    }, ttl);
  }

  async function handleStart(req: StartRequest): Promise<StartResponse> {
    gc();
    const streamId = req.streamId ?? genId();

    // Idempotency: re-starting an existing live stream is a no-op.
    const existing = streams.get(streamId);
    if (existing) {
      return { protocolVersion: PROTOCOL_VERSION, streamId, startedAt: existing.startedAt };
    }

    const now = Date.now();
    const abort = new AbortController();
    const rec: StreamRecord<TMeta> = {
      streamId,
      buffer: "",
      events: [],
      status: "streaming",
      lastEventAt: now,
      lastPolledAt: now,
      startedAt: now,
      abort,
      hookQueue: Promise.resolve(),
    };
    streams.set(streamId, rec);
    scheduleInactivityAbort(rec);

    // Fire-and-forget. Errors are caught and stored on the record; the
    // poll endpoint surfaces them. We deliberately don't `await` here —
    // the client is going to start polling regardless.
    void runUpstream(rec, req.payload as TPayload);

    return { protocolVersion: PROTOCOL_VERSION, streamId, startedAt: now };
  }

  function queueHook(
    rec: StreamRecord<TMeta>,
    label: string,
    fn: () => Promise<void>,
  ): void {
    const next = rec.hookQueue
      .catch(() => undefined)
      .then(fn)
      .catch((err) => console.error(`[relay] ${label} hook failed`, err));
    rec.hookQueue = next;
  }

  async function runUpstream(
    rec: StreamRecord<TMeta>,
    payload: TPayload,
  ): Promise<void> {
    const ctx: UpstreamContext<TPayload, TMeta> = {
      streamId: rec.streamId,
      payload,
      write: (chunk) => {
        if (rec.status !== "streaming") return;
        rec.buffer += chunk;
        rec.lastEventAt = Date.now();
        if (options.onAppend) {
          const offset = rec.buffer.length;
          queueHook(rec, "onAppend", () => options.onAppend!(rec.streamId, chunk, offset));
        }
      },
      emit: (event) => {
        if (rec.status !== "streaming") return;
        const now = Date.now();
        const normalized = normalizeEvent(event, now);
        if (!normalized) return;
        rec.events.push(normalized);
        rec.lastEventAt = now;
        if (options.onEvent) {
          const eventOffset = rec.events.length;
          queueHook(rec, "onEvent", () => options.onEvent!(rec.streamId, normalized, eventOffset));
        }
      },
      heartbeat: () => {
        rec.lastEventAt = Date.now();
      },
      progress: (update) => {
        if (rec.status !== "streaming") return;
        const now = Date.now();
        const progress = normalizeProgress(update, now);
        rec.progress = progress;
        rec.lastEventAt = now;
        if (options.onProgress) {
          queueHook(rec, "onProgress", () => options.onProgress!(rec.streamId, progress));
        }
      },
      signal: rec.abort.signal,
    };

    try {
      const meta = await options.upstream(ctx);
      if (rec.status !== "streaming") return; // aborted
      if (rec.inactivityTimer) {
        clearTimeout(rec.inactivityTimer);
        rec.inactivityTimer = undefined;
      }
      const final: FinalState<TMeta> = {
        text: rec.buffer,
        events: rec.events.slice(),
        meta: meta ?? undefined,
      };
      const completedAt = Date.now();
      rec.status = "complete";
      rec.final = final;
      rec.completed_at = completedAt;
      rec.lastEventAt = completedAt;
      if (options.onComplete) {
        queueHook(rec, "onComplete", () => options.onComplete!(rec.streamId, final));
      }
    } catch (err) {
      if (rec.status !== "streaming") return;
      if (rec.inactivityTimer) {
        clearTimeout(rec.inactivityTimer);
        rec.inactivityTimer = undefined;
      }
      const message = err instanceof Error ? err.message : String(err);
      rec.status = "error";
      rec.error = message;
      rec.lastEventAt = Date.now();
      if (options.onError) {
        queueHook(rec, "onError", () => options.onError!(rec.streamId, message));
      }
    }
  }

  async function handlePoll(
    streamId: string,
    since: number,
    eventSince = 0,
  ): Promise<PollResponse> {
    let rec = streams.get(streamId);

    // Cold path: try to rehydrate from the host's store.
    if (!rec && options.hydrate) {
      const hydrated = await options.hydrate(streamId);
      if (hydrated) {
        const now = Date.now();
        const interrupted = hydrated.status === "streaming";
        rec = {
          streamId,
          buffer: hydrated.buffer,
          events: hydrated.events ?? [],
          status: interrupted ? "error" : hydrated.status,
          lastEventAt: interrupted ? now : hydrated.lastEventAt,
          lastPolledAt: now,
          startedAt: now,
          final: hydrated.final,
          completed_at: hydrated.completed_at,
          progress: hydrated.progress,
          error: interrupted
            ? "stream was interrupted before completion"
            : hydrated.error,
          abort: new AbortController(),
          hookQueue: Promise.resolve(),
        };
        streams.set(streamId, rec);
        if (interrupted && options.onError) {
          queueHook(rec, "onError", () => options.onError!(streamId, rec!.error ?? "stream was interrupted before completion"));
        }
      }
    }

    const now = Date.now();
    if (!rec) {
      const errorInfo: RelayError = {
        code: "stream_not_found",
        message: `stream ${streamId} not found`,
      };
      return {
        protocolVersion: PROTOCOL_VERSION,
        streamId,
        status: "not_found",
        complete: false,
        append: "",
        nextOffset: 0,
        events: [],
        nextEventOffset: 0,
        lastEventAt: 0,
        serverNow: now,
        error: errorInfo.message,
        errorInfo,
      };
    }

    rec.lastPolledAt = now;
    gc();
    scheduleInactivityAbort(rec);

    const safeSince = Number.isFinite(since)
      ? Math.max(0, Math.min(since, rec.buffer.length))
      : rec.buffer.length;
    const append = rec.buffer.slice(safeSince);
    const safeEventSince = Number.isFinite(eventSince)
      ? Math.max(0, Math.min(eventSince, rec.events.length))
      : rec.events.length;
    const events = rec.events.slice(safeEventSince);

    const errorInfo = rec.status === "error"
      ? errorInfoFor(rec.error ?? "stream error")
      : undefined;

    return {
      protocolVersion: PROTOCOL_VERSION,
      streamId,
      status: rec.status,
      complete: rec.status === "complete",
      completed_at: rec.completed_at,
      progress: rec.progress,
      append,
      nextOffset: rec.buffer.length,
      events,
      nextEventOffset: rec.events.length,
      lastEventAt: rec.lastEventAt,
      serverNow: now,
      final: rec.status === "complete" ? rec.final : undefined,
      error: rec.status === "error" ? rec.error : undefined,
      errorInfo,
    };
  }

  function normalizeEvent<TEvent extends RelayEvent>(
    event: TEvent,
    timestamp: number,
  ): TEvent | null {
    if (!event || typeof event.type !== "string") {
      console.warn("[relay] dropping malformed event; expected an object with a string type");
      return null;
    }
    return { ...event, timestamp: event.timestamp ?? timestamp } as TEvent;
  }

  function normalizeProgress(
    update: string | Omit<ProgressState, "updated_at">,
    updated_at: number,
  ): ProgressState {
    return typeof update === "string"
      ? { message: update, updated_at }
      : { ...update, updated_at };
  }

  function errorInfoFor(message: string): RelayError {
    if (message === "stream aborted after client inactivity") {
      return { code: "stream_inactive", message };
    }
    if (message === "stream was interrupted before completion") {
      return { code: "stream_interrupted", message };
    }
    return { code: "stream_error", message };
  }

  return {
    handleStart,
    handlePoll,
    inspect: (id) => streams.get(id),
  };
}

export type { StreamRecord };
export type { PollResponse, ProgressState, RelayEvent, StartRequest, StartResponse, StreamStatus } from "../shared/protocol";
export { withKvStorage, withSqliteStorage, kvFromCloudflare, sqliteKvFromDatabase } from "./storage";
export type { KVStore, KvStorageOptions, SqliteDatabase, SqliteStorageOptions } from "./storage";
