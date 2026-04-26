/**
 * React hook for consuming a relay stream.
 *
 * Polls the relay's `GET /streams/:id` endpoint at a fixed cadence, delivers
 * new string data via `onChunk`, and surfaces lifecycle via `onDone` / `onError`.
 *
 * The hook is deliberately string-oriented: the relay shuttles strings, and
 * the caller decides how to interpret them (plain text, markdown, NDJSON,
 * a custom event format). Anything richer than that belongs in a wrapper
 * hook, not here.
 */

import { useEffect, useRef, useState } from "react";
import type { PollResponse } from "../shared/protocol";

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface UseStreamOptions<TMeta = unknown> {
  /** Base URL of your deployed relay (no trailing slash). */
  proxyUrl: string;

  /**
   * Stream to subscribe to. Returned from your `POST /streams` call. `null`
   * means "not subscribed" — the hook is inert. Changing the value tears
   * down the previous loop and starts fresh.
   */
  streamId: string | null;

  /**
   * HTTP client. Defaults to global `fetch`. Pass `hubspot.fetch` inside a
   * UI extension so portal-context headers reach your relay's auth check.
   */
  fetcher?: typeof fetch;

  /** Poll cadence in ms. Default 400. */
  intervalMs?: number;

  /** Toggle without unmounting. Default true. */
  enabled?: boolean;

  /** Tuning knobs for resilience. See defaults in `DEFAULTS`. */
  reconnect?: {
    /** Client-side stale threshold for reconnecting UI hint. Default 3000. */
    staleResyncMs?: number;
    /** Server-side stall threshold → fires `onError`. Default 90000. */
    serverStallMs?: number;
    /** Transport retry budget per poll. Default 3. */
    maxFetchRetries?: number;
    /** Linear backoff base ms. Defaults to `intervalMs`. */
    retryBackoffMs?: number;
  };

  /**
   * Where to start reading from on subscribe.
   *   - `0` (default): replay everything the relay still has buffered
   *   - `N`: resume from string offset N (use after reload, paired with persisted offset)
   *   - `"live"`: skip backlog, only deliver new chunks from now
   */
  resumeFrom?: number | "live";

  onChunk?: (append: string, nextOffset: number) => void;
  onDone?: (final: { text: string; meta?: TMeta }) => void;
  onError?: (error: Error) => void;
}

export interface UseStreamResult {
  isStreaming: boolean;
  reconnecting: boolean;
  /** Persist alongside `streamId` to enable cross-reload resume. */
  offset: number;
}

const DEFAULTS = {
  intervalMs: 400,
  staleResyncMs: 3000,
  serverStallMs: 90000,
  maxFetchRetries: 3,
};

// Sentinel error class so callers can branch on `instanceof StreamNotFoundError`
// for restart-vs-surrender decisions without string-matching.
export class StreamNotFoundError extends Error {
  constructor(streamId: string) {
    super(`stream ${streamId} not found`);
    this.name = "StreamNotFoundError";
  }
}

export class StreamStalledError extends Error {
  constructor() {
    super("stream stalled");
    this.name = "StreamStalledError";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────

export function useStream<TMeta = unknown>(
  options: UseStreamOptions<TMeta>,
): UseStreamResult {
  const {
    proxyUrl,
    streamId,
    fetcher,
    intervalMs = DEFAULTS.intervalMs,
    enabled = true,
    reconnect,
    resumeFrom = 0,
  } = options;

  const staleResyncMs = reconnect?.staleResyncMs ?? DEFAULTS.staleResyncMs;
  const serverStallMs = reconnect?.serverStallMs ?? DEFAULTS.serverStallMs;
  const maxFetchRetries =
    reconnect?.maxFetchRetries ?? DEFAULTS.maxFetchRetries;
  const retryBackoffMs = reconnect?.retryBackoffMs ?? intervalMs;

  const [isStreaming, setIsStreaming] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [offset, setOffset] = useState(0);
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);

  // Refs so the loop doesn't restart when callers pass inline handlers/fetchers.
  const onChunkRef = useRef(options.onChunk);
  const onDoneRef = useRef(options.onDone);
  const onErrorRef = useRef(options.onError);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    onChunkRef.current = options.onChunk;
    onDoneRef.current = options.onDone;
    onErrorRef.current = options.onError;
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!enabled || !streamId || !proxyUrl) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;

    // Resolve initial offset.
    //   "live" → ask for current end-of-buffer; we'll seed from first poll.
    //   number → resume from there.
    let currentOffset = resumeFrom === "live" ? -1 : resumeFrom;
    let lastAdvanceAt = Date.now();
    let retries = 0;

    setActiveStreamId(streamId);
    setIsStreaming(true);
    setReconnecting(false);
    setOffset(typeof currentOffset === "number" && currentOffset >= 0 ? currentOffset : 0);

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });

    const stop = (phase: "done" | "error" | "cancel") => {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (inFlight) inFlight.abort();
      if (phase !== "cancel") {
        setIsStreaming(false);
        setReconnecting(false);
      }
    };

    const fail = (err: Error) => {
      stop("error");
      onErrorRef.current?.(err);
    };

    const tick = async (): Promise<{ done: boolean; nextDelay: number }> => {
      if (cancelled) return { done: true, nextDelay: 0 };

      // "live" mode: first request asks for since=very-large so we get
      // nextOffset back without any append, then settle there.
      const sinceParam =
        currentOffset < 0
          ? Number.MAX_SAFE_INTEGER
          : currentOffset;

      let res: Response;
      try {
        inFlight = new AbortController();
        const fetchImpl = fetcherRef.current ?? fetch;
        res = await fetchImpl(
          `${proxyUrl}/streams/${encodeURIComponent(streamId)}?since=${sinceParam}`,
          { method: "GET", signal: inFlight.signal },
        );
      } catch (err) {
        if (cancelled) return { done: true, nextDelay: 0 };
        return handleTransientError(err);
      } finally {
        inFlight = null;
      }

      if (cancelled) return { done: true, nextDelay: 0 };

      if (!res.ok) {
        return handleTransientError(
          new Error(`relay poll ${res.status}`),
        );
      }

      let data: PollResponse<TMeta>;
      try {
        data = (await res.json()) as PollResponse<TMeta>;
      } catch (err) {
        return handleTransientError(err);
      }

      if (cancelled) return { done: true, nextDelay: 0 };
      retries = 0;

      if (data.status === "not_found") {
        fail(new StreamNotFoundError(streamId));
        return { done: true, nextDelay: 0 };
      }

      // Normalize "live" mode after first response.
      if (currentOffset < 0) {
        currentOffset = data.nextOffset;
        setOffset(currentOffset);
      } else if (data.append && data.append.length > 0) {
        currentOffset = data.nextOffset;
        setOffset(currentOffset);
        lastAdvanceAt = Date.now();
        onChunkRef.current?.(data.append, currentOffset);
      }

      // Reconnecting hint: server says streaming, client hasn't seen
      // progress recently. Distinct from server-stall failure.
      if (data.status === "streaming") {
        const now = Date.now();
        const reconnectingHint = now - lastAdvanceAt > staleResyncMs;
        setReconnecting(reconnectingHint);

        // Server-stall detection: trust the relay's lastEventAt over our
        // local perception. If the server itself hasn't seen activity in
        // serverStallMs, the run is dead.
        if (
          data.serverNow - data.lastEventAt > serverStallMs &&
          data.lastEventAt > 0
        ) {
          fail(new StreamStalledError());
          return { done: true, nextDelay: 0 };
        }
      } else {
        setReconnecting(false);
      }

      if (data.status === "done") {
        stop("done");
        onDoneRef.current?.({
          text: data.final?.text ?? "",
          meta: data.final?.meta,
        });
        return { done: true, nextDelay: 0 };
      }

      if (data.status === "error") {
        fail(new Error(data.error || "stream error"));
        return { done: true, nextDelay: 0 };
      }

      return { done: false, nextDelay: intervalMs };
    };

    const handleTransientError = (
      err: unknown,
    ): { done: boolean; nextDelay: number } => {
      if (cancelled) return { done: true, nextDelay: 0 };
      if (retries < maxFetchRetries) {
        retries += 1;
        return { done: false, nextDelay: retryBackoffMs * (retries + 1) };
      }
      const e = err instanceof Error ? err : new Error(String(err));
      fail(e);
      return { done: true, nextDelay: 0 };
    };

    (async () => {
      while (!cancelled) {
        const { done, nextDelay } = await tick();
        if (done) return;
        await sleep(nextDelay);
      }
    })();

    return () => {
      stop("cancel");
      setIsStreaming(false);
      setReconnecting(false);
      setActiveStreamId((current) => (current === streamId ? null : current));
    };
    // We intentionally exclude the callback refs from deps — they're refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    proxyUrl,
    streamId,
    intervalMs,
    enabled,
    resumeFrom,
    staleResyncMs,
    serverStallMs,
    maxFetchRetries,
    retryBackoffMs,
  ]);

  const currentStreamOwnsState = !!streamId && activeStreamId === streamId;

  return {
    isStreaming: currentStreamOwnsState && isStreaming,
    reconnecting: currentStreamOwnsState && reconnecting,
    offset: currentStreamOwnsState ? offset : 0,
  };
}
