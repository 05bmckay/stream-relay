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

import type {
  PollResponse,
  StartRequest,
  StartResponse,
  StreamStatus,
} from "../shared/protocol";

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Function the host app provides to actually run the upstream work. Receives
 * the `payload` from `StartRequest` and a `writer` to push bytes back into
 * the relay buffer. Resolve to mark `done`; throw to mark `error`.
 *
 * The writer is intentionally byte-oriented (string in, string out). Hosts
 * doing structured streaming (JSON events, SSE frames) should serialize on
 * the way in and parse on the way out — keeps the relay dumb.
 */
export type UpstreamHandler<TPayload = unknown, TMeta = unknown> = (
  ctx: UpstreamContext<TPayload, TMeta>,
) => Promise<TMeta | void>;

export interface UpstreamContext<TPayload = unknown, TMeta = unknown> {
  streamId: string;
  payload: TPayload;
  /** Append bytes to the buffer. Bumps `lastEventAt`. */
  write: (chunk: string) => void;
  /**
   * Bump `lastEventAt` without writing. Use during long silent operations
   * (tool calls, "thinking" phases) to keep the client's stall detector
   * happy without polluting the visible buffer.
   */
  heartbeat: () => void;
  /** Aborted when no client has polled in `streamTtlMs`. */
  signal: AbortSignal;
}

export interface RelayOptions<TPayload = unknown, TMeta = unknown> {
  /** Required: how to actually run the upstream work. */
  upstream: UpstreamHandler<TPayload, TMeta>;

  /**
   * Garbage-collect streams that haven't been polled in this long. Default
   * 10 minutes. Set high if you want long resume windows, low if memory is
   * tight. Streams in `streaming` status are never GC'd by inactivity —
   * only finished/errored ones.
   */
  streamTtlMs?: number;

  /**
   * Optional persistence hooks. All async, all best-effort: the relay logs
   * failures and continues. None of these are required for correctness;
   * they exist so durable backends can layer on without forking.
   */
  onAppend?: (streamId: string, chunk: string, offset: number) => Promise<void>;
  onComplete?: (streamId: string, final: FinalState<TMeta>) => Promise<void>;
  onError?: (streamId: string, error: string) => Promise<void>;

  /**
   * Called when a poll lands for a streamId we don't have in memory. Return
   * the persisted state to rehydrate, or null to return `not_found`. This is
   * the durability escape hatch.
   */
  hydrate?: (streamId: string) => Promise<HydratedState<TMeta> | null>;

  /**
   * ID generator for `POST /streams` when the client doesn't supply one.
   * Defaults to a 16-byte hex string from `crypto.randomUUID()`.
   */
  generateId?: () => string;
}

export interface FinalState<TMeta = unknown> {
  text: string;
  meta?: TMeta;
}

export interface HydratedState<TMeta = unknown> {
  buffer: string;
  status: Exclude<StreamStatus, "not_found">;
  lastEventAt: number;
  final?: FinalState<TMeta>;
  error?: string;
}

export interface Relay {
  handleStart: (req: StartRequest) => Promise<StartResponse>;
  handlePoll: (
    streamId: string,
    since: number,
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
  status: StreamStatus;
  lastEventAt: number;
  lastPolledAt: number;
  startedAt: number;
  final?: FinalState<TMeta>;
  error?: string;
  abort: AbortController;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createRelay<TPayload = unknown, TMeta = unknown>(
  options: RelayOptions<TPayload, TMeta>,
): Relay {
  const streams = new Map<string, StreamRecord<TMeta>>();
  const ttl = options.streamTtlMs ?? DEFAULT_TTL_MS;
  const genId =
    options.generateId ??
    (() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).crypto?.randomUUID?.() ??
      Math.random().toString(36).slice(2) + Date.now().toString(36));

  function gc() {
    const now = Date.now();
    for (const [id, rec] of streams) {
      if (rec.status === "streaming") continue;
      if (now - rec.lastPolledAt > ttl) streams.delete(id);
    }
  }

  async function handleStart(req: StartRequest): Promise<StartResponse> {
    gc();
    const streamId = req.streamId ?? genId();

    // Idempotency: re-starting an existing live stream is a no-op.
    const existing = streams.get(streamId);
    if (existing) {
      return { streamId, startedAt: existing.startedAt };
    }

    const now = Date.now();
    const abort = new AbortController();
    const rec: StreamRecord<TMeta> = {
      streamId,
      buffer: "",
      status: "streaming",
      lastEventAt: now,
      lastPolledAt: now,
      startedAt: now,
      abort,
    };
    streams.set(streamId, rec);

    // Fire-and-forget. Errors are caught and stored on the record; the
    // poll endpoint surfaces them. We deliberately don't `await` here —
    // the client is going to start polling regardless.
    void runUpstream(rec, req.payload as TPayload);

    return { streamId, startedAt: now };
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
          options
            .onAppend(rec.streamId, chunk, rec.buffer.length)
            .catch((err) => console.error("[relay] onAppend failed", err));
        }
      },
      heartbeat: () => {
        rec.lastEventAt = Date.now();
      },
      signal: rec.abort.signal,
    };

    try {
      const meta = await options.upstream(ctx);
      if (rec.status !== "streaming") return; // aborted
      const final: FinalState<TMeta> = {
        text: rec.buffer,
        meta: meta ?? undefined,
      };
      rec.status = "done";
      rec.final = final;
      rec.lastEventAt = Date.now();
      if (options.onComplete) {
        options
          .onComplete(rec.streamId, final)
          .catch((err) => console.error("[relay] onComplete failed", err));
      }
    } catch (err) {
      if (rec.status !== "streaming") return;
      const message = err instanceof Error ? err.message : String(err);
      rec.status = "error";
      rec.error = message;
      rec.lastEventAt = Date.now();
      if (options.onError) {
        options
          .onError(rec.streamId, message)
          .catch((e) => console.error("[relay] onError hook failed", e));
      }
    }
  }

  async function handlePoll(
    streamId: string,
    since: number,
  ): Promise<PollResponse> {
    let rec = streams.get(streamId);

    // Cold path: try to rehydrate from the host's store.
    if (!rec && options.hydrate) {
      const hydrated = await options.hydrate(streamId);
      if (hydrated) {
        const now = Date.now();
        rec = {
          streamId,
          buffer: hydrated.buffer,
          status: hydrated.status,
          lastEventAt: hydrated.lastEventAt,
          lastPolledAt: now,
          startedAt: now,
          final: hydrated.final,
          error: hydrated.error,
          abort: new AbortController(),
        };
        streams.set(streamId, rec);
      }
    }

    const now = Date.now();
    if (!rec) {
      return {
        status: "not_found",
        append: "",
        nextOffset: 0,
        lastEventAt: 0,
        serverNow: now,
      };
    }

    rec.lastPolledAt = now;

    const safeSince = Math.max(0, Math.min(since, rec.buffer.length));
    const append = rec.buffer.slice(safeSince);

    return {
      status: rec.status,
      append,
      nextOffset: rec.buffer.length,
      lastEventAt: rec.lastEventAt,
      serverNow: now,
      final: rec.status === "done" ? rec.final : undefined,
      error: rec.status === "error" ? rec.error : undefined,
    };
  }

  return {
    handleStart,
    handlePoll,
    inspect: (id) => streams.get(id),
  };
}

export type { StreamRecord };
export type { PollResponse, StartRequest, StartResponse, StreamStatus } from "../shared/protocol";
