/**
 * Wire protocol shared by client and server. This file is the source of truth
 * for what the relay endpoint returns and what the client expects.
 *
 * The protocol is intentionally tiny:
 *   - One POST to start (`StartRequest` → `StartResponse`)
 *   - One GET to poll (`?since=N` → `PollResponse`)
 *   - That's it.
 *
 * Everything else (auth, rate limiting, persistence) is the host app's job
 * and lives outside this package.
 */

export const PROTOCOL_VERSION = 1;

export type StreamStatus = "streaming" | "complete" | "error" | "not_found";

export interface RelayError {
  code: "stream_error" | "stream_not_found" | "stream_interrupted" | "stream_inactive";
  message: string;
}

export interface ProgressState<TData = unknown> {
  /** Short machine-readable phase, e.g. "retrieval", "tool_call", "generation". */
  phase?: string;
  /** Human-readable progress message for UI. */
  message?: string;
  /** Optional host-defined progress payload. */
  data?: TData;
  /** Server time when progress was last updated, ms since epoch. */
  updated_at: number;
}

export interface StartRequest {
  /**
   * Optional client-supplied id. If omitted, the server generates one and
   * returns it in `StartResponse.streamId`. Supplying an id makes the call
   * idempotent — re-POSTing the same id while a stream is live is a no-op
   * and returns the existing stream's metadata.
   */
  streamId?: string;

  /**
   * Opaque payload forwarded to the upstream handler the host app
   * registered with `createRelay({ upstream })`. The relay package never
   * inspects this — it's the contract between the caller and their own
   * upstream.
   */
  payload?: unknown;
}

export interface StartResponse {
  /** Wire protocol version. */
  protocolVersion: typeof PROTOCOL_VERSION;
  streamId: string;
  /** Server time at start, ms since epoch. Useful for clock-skew debugging. */
  startedAt: number;
}

export interface PollResponse<TMeta = unknown, TProgressData = unknown> {
  /** Wire protocol version. */
  protocolVersion: typeof PROTOCOL_VERSION;

  /** Echoes the stream id being polled so clients can discard stale pairs. */
  streamId: string;

  status: StreamStatus;

  /** True once the upstream resolved successfully. */
  complete: boolean;

  /** Server time when the upstream completed successfully, ms since epoch. */
  completed_at?: number;

  /** Latest app-level progress update, if the upstream emitted one. */
  progress?: ProgressState<TProgressData>;

  /**
   * New string data appended since the `since` offset the client requested.
   * Empty string when no new data this tick.
   */
  append: string;

  /**
   * Absolute JavaScript string offset (UTF-16 code units) after `append`.
   * The next poll should send `?since=nextOffset` (the client hook handles
   * this automatically).
   */
  nextOffset: number;

  /**
   * Server's monotonic timestamp of the most recent upstream event, even
   * silent ones (tool calls, thinking deltas). The client uses this to
   * detect genuinely-dead streams vs. legitimately-quiet long operations.
   *
   * ms since epoch.
   */
  lastEventAt: number;

  /**
   * Server's current wall clock when this response was generated, ms since
   * epoch. Pair with `lastEventAt` to compute "how long since the server
   * last saw activity" without trusting the client's clock.
   */
  serverNow: number;

  /**
   * Populated when `status === "complete"`. The full final buffer plus whatever
   * structured metadata the host app attached on completion.
   */
  final?: {
    text: string;
    meta?: TMeta;
  };

  /** Populated when `status === "error"`. Human-readable message. */
  error?: string;

  /** Structured error for protocol-aware clients. */
  errorInfo?: RelayError;
}

/**
 * Default URL paths. Hosts can mount the relay anywhere; these are just the
 * conventional defaults the example servers and the client hook assume.
 */
export const DEFAULT_PATHS = {
  start: "/streams",
  poll: "/streams/:id",
} as const;
