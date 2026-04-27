# stream-relay

[![npm beta](https://img.shields.io/npm/v/@hs-uix/stream-relay/beta?label=npm%20beta)](https://www.npmjs.com/package/@hs-uix/stream-relay)

Resumable, pollable stream proxy for clients that can't hold long connections.

If your frontend lives somewhere with a short fetch ceiling (HubSpot UI extensions, sandboxed iframes, embedded SaaS surfaces) and your backend takes longer than that ceiling allows (LLM calls, agent runs, slow APIs), this package sits between them. The client polls a small endpoint at 400ms; the server buffers the upstream response in memory; reloads pick up exactly where they left off.

## Drop-in by design

You don't change how your client makes requests, you just point at the relay instead of the upstream and use a hook for the response. You don't change how your backend works either; the upstream handler receives a `write` function, you call it with chunks, the relay does the rest. Two endpoints (`POST /streams`, `GET /streams/:id`), one React hook, no SSE plumbing, no WebSocket configuration, no sticky load balancing.

## When to use it

Reach for stream-relay when the client environment caps individual fetch calls and you can't switch transports. HubSpot extensions are the canonical case: holding an SSE connection through `hubspot.fetch` is unreliable, page reloads kill the stream, and you have no good answer for resume.

If you control both ends and can use plain SSE or streamed `fetch` responses, you don't need this. Use those instead.

## How it works

```
+------------------+      poll every 400ms       +------------------+    long upstream     +------------------+
|   React client   | --------------------------> |   stream-relay   | -----------------> |   LLM / agent    |
|   useStream()    | <-- { append, nextOffset }- |     (server)     | <-- tokens ------- |  / any slow API  |
+------------------+                             +------------------+                    +------------------+
```

The relay buffers upstream output in memory. The client polls `GET /streams/:id?since=N` and asks for string data past its last-known offset. On reload, the client sends the persisted offset and gets exactly the data it missed. No SSE, no WebSockets, no sticky load balancing required.

## Install

Published on npm as [`@hs-uix/stream-relay`](https://www.npmjs.com/package/@hs-uix/stream-relay). The current release is under the `beta` dist-tag:

```sh
npm install @hs-uix/stream-relay@beta
```

One package, four entry points. Bundlers only pull in what you import.

## Quickstart

### Client: React

```tsx
import { useStream } from "@hs-uix/stream-relay/client";
import { useState } from "react";

function MyCard() {
  const [streamId, setStreamId] = useState(null);
  const [text, setText] = useState("");

  // Polls while streamId is set; each response includes only new text.
  const { isStreaming, reconnecting } = useStream({
    proxyUrl: "https://your-relay.workers.dev",
    streamId,
    fetcher: hubspot.fetch,
    onChunk: (append) => setText((t) => t + append),
    onDone: ({ meta }) => console.log("usage:", meta),
  });

  const start = async () => {
    setText("");

    // Starts the upstream work and returns immediately with a streamId.
    const res = await hubspot.fetch(`${RELAY_URL}/streams`, {
      method: "POST",
      body: JSON.stringify({ payload: { prompt: "Tell me a joke" } }),
    });
    const { streamId } = await res.json();

    // Setting streamId kicks off the polling loop above.
    setStreamId(streamId);
  };

  return (
    <>
      <button onClick={start} disabled={isStreaming}>
        {reconnecting ? "Reconnecting..." : isStreaming ? "Running..." : "Run"}
      </button>
      <div>{text}</div>
    </>
  );
}
```

A complete HubSpot CRM card example with serverless-function-backed property persistence lives in [`examples/hubspot-extension/`](./examples/hubspot-extension/).

### Server: Cloudflare Workers

```ts
// worker.ts
import { RelayBuffer, createRelayWorker } from "@hs-uix/stream-relay/worker";

export class MyRelay extends RelayBuffer {
  constructor(state, env) {
    super(state, env, {
      upstream: async ({ payload, write }) => {
        for await (const token of callYourLLM(payload.prompt)) {
          write(token);
        }
      },
    });
  }
}

export default createRelayWorker();
```

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "RELAY"
class_name = "MyRelay"

[[migrations]]
tag = "v1"
new_classes = ["MyRelay"]
```

`wrangler deploy` and the relay is live.

### Server: Node, Bun, or Deno via Hono

```ts
import { createRelayApp } from "@hs-uix/stream-relay/hono";
import { serve } from "@hono/node-server";

const { app } = createRelayApp({
  upstream: async ({ payload, write }) => {
    for await (const token of callYourLLM(payload.prompt)) {
      write(token);
    }
  },
});

serve({ fetch: app.fetch, port: 8787 });
```

## Bring your own stream IDs

If you already track a `runId`, `jobId`, or any other stable identifier in your app, pass it as `streamId` on the start call and the relay uses it directly:

```ts
const res = await fetch(`${RELAY_URL}/streams`, {
  method: "POST",
  body: JSON.stringify({
    streamId: existingRunId,
    payload: { prompt: "..." },
  }),
});
```

The call is idempotent while the old record is still retained: re-posting the same `streamId` returns the existing stream's metadata without restarting the upstream. Saves you from persisting an extra ID alongside whatever you already track.

## Resuming after reload

The hook returns the current string `offset` (a JavaScript UTF-16 string offset). Persist it alongside `streamId` (in `localStorage`, HubSpot card properties, your DB, anywhere). On the next mount, pass the saved offset back as `resumeFrom` and the hook delivers only the data that arrived while you were gone.

```tsx
const { offset } = useStream({
  streamId: persisted.streamId,
  resumeFrom: persisted.offset,
  // ...
});
```

If the relay garbage-collected the buffer before you came back, `onError` fires with a `StreamNotFoundError`. Your app decides whether to restart the upstream or surrender.

If nobody polls a still-running stream for `streamTtlMs` (10 minutes by default), the relay aborts the upstream via `ctx.signal` and marks the stream as `error`. Upstream handlers should pass `signal` into fetch/SDK calls when possible or check `signal.aborted` in long loops.

## Persistence (optional)

Default behavior is in-memory. If the server restarts, in-flight streams die with it. For most uses (single-region edge deploy, LLM proxying) this is fine. When you need completed stream output to survive deploys, evictions, or multi-day resume windows, opt into one of the bundled persistence helpers.

### Cloudflare: Durable Object storage

```ts
import { RelayBuffer, withDurableStorage } from "@hs-uix/stream-relay/worker";

export class MyRelay extends RelayBuffer {
  constructor(state, env) {
    super(state, env, withDurableStorage(state, {
      upstream: async ({ payload, write }) => { /* ... */ },
    }));
  }
}
```

Every chunk is debounced into the DO's storage. On rehydrate (eviction, deploy, cold start), completed or errored buffers are read back transparently. If eviction interrupts an actively-running upstream, the stream rehydrates as an error because arbitrary upstream work cannot be resumed generically.

### Hono / Node / anywhere: KV interface

```ts
import { createRelayApp, withKvStorage } from "@hs-uix/stream-relay/hono";

const myKv = {
  get: (k) => redis.get(k),
  set: (k, v) => redis.set(k, v),
  delete: (k) => redis.del(k),
};

const { app } = createRelayApp(withKvStorage(myKv, {
  upstream: async ({ payload, write }) => { /* ... */ },
}));
```

`withKvStorage` accepts any `{ get, set, delete? }` shape. Drop in Redis, Upstash, Cloudflare KV (via `kvFromCloudflare`), or your own database. Writes are debounced (default 500ms); set `flushIntervalMs: 0` for synchronous-per-chunk durability. Use `prefix` to namespace keys when sharing a store.

### Roll your own

The persistence helpers are thin wrappers over four optional callbacks on `RelayOptions`. If you want different semantics (chunked storage, compression, multi-tenant key prefixing), wire `onAppend`, `onComplete`, `onError`, and `hydrate` directly. The relay core never reaches into storage.

## Auth

This package does not ship built-in auth. Every host has different requirements (HubSpot install verification, JWT, mTLS, API keys), so we leave the choice to you:

```ts
createRelayWorker({
  auth: ({ request, env, streamId, method }) => {
    if (!isValidHubSpotInstall(request, env, streamId, method)) {
      return new Response("unauthorized", { status: 401 });
    }
  },
});
```

The same `auth` option works on both the Worker and Hono adapters. Worker auth receives `{ request, env, streamId, method }`; Hono auth receives the Hono `Context`.

## API reference

### `useStream(options)` from `@hs-uix/stream-relay/client`

| Option | Default | Purpose |
|---|---|---|
| `proxyUrl` | required | Base URL of your deployed relay |
| `streamId` | required | Stream to subscribe to (`null` = inert) |
| `fetcher` | global `fetch` | HTTP client (use `hubspot.fetch` in extensions) |
| `intervalMs` | 400 | Poll cadence |
| `resumeFrom` | 0 | JavaScript string offset, or `"live"` to skip backlog |
| `reconnect.serverStallMs` | 90000 | Give-up threshold for silent server |
| `reconnect.staleResyncMs` | 3000 | Reconnecting UI hint threshold |

Full JSDoc on every option in [`packages/client/index.ts`](./packages/client/index.ts).

### `createRelay(options)` from `@hs-uix/stream-relay/server`

Framework-agnostic core if you're rolling your own HTTP layer. Returns `{ handleStart, handlePoll }` as pure async functions. `streamTtlMs` controls both finished-buffer retention and inactivity aborts for still-running streams.

### `createRelayApp(options)` from `@hs-uix/stream-relay/hono`

Hono app with `POST /streams` and `GET /streams/:id` mounted. Runs on Node, Bun, Deno, Vercel, AWS Lambda, or Cloudflare Pages.

### `RelayBuffer`, `createRelayWorker()`, `withDurableStorage()` from `@hs-uix/stream-relay/worker`

Cloudflare Workers + Durable Object. Subclass `RelayBuffer` to wire your upstream; `createRelayWorker()` returns the routing `fetch` handler; `withDurableStorage()` opts into DO-backed durability.

### `withKvStorage(kv, options)` from `@hs-uix/stream-relay/server`

Persistence helper for any KV-shaped store. Accepts `{ get, set, delete? }`. Use directly with `createRelay` or wrap a Hono app's options.

## Wire protocol

The contract is small enough to reimplement in any language:

```
POST /streams          { streamId?, payload? }
                       -> { protocolVersion: 1, streamId, startedAt }

GET  /streams/:id?since=N
                       -> { protocolVersion: 1, streamId, status, complete,
                            completed_at?, append, nextOffset, lastEventAt,
                            serverNow, final?: { text, meta? }, error?,
                            errorInfo?: { code, message } }
```

`status` is one of `streaming`, `complete`, `error`, `not_found`. `complete` is `true` only after the upstream resolves successfully; `completed_at` is populated at that point with server time in ms since epoch. `since` and `nextOffset` are JavaScript string offsets (UTF-16 code units), matching the package's string-in/string-out API. Clients use `serverNow - lastEventAt > serverStallMs` to detect dead streams without trusting their own clock.

## What we tested

The package was built test-driven. Validation runs through five layers, each catching a different class of bug.

### Unit tests against the framework-agnostic core

Direct calls into `handleStart` and `handlePoll`, no HTTP. Covers happy-path streaming, upstream throws surfaced as `status=error`, unknown streamId returning `not_found`, out-of-range `since` clamped to buffer length, idempotent start (second POST with same id returns existing metadata, upstream runs once), heartbeat advancing `lastEventAt` without polluting the buffer, persistence hooks firing in order with correct chunk and offset arguments, rehydrate hook supplying state when a stream is missing from memory, resume from arbitrary offset returning only new bytes, and concurrent polls returning identical state.

### Hono integration tests over real HTTP

A real `@hono/node-server` on a random port, real `fetch` calls. Validates: end-to-end POST plus poll loop until complete with byte-perfect accumulated content, `not_found` returned for unknown stream id, mid-stream disconnect-then-resume yielding zero gaps and zero overlap, three concurrent clients on the same stream observing identical content, and idempotent start where the second POST reuses the existing stream rather than restarting the upstream.

### Stress tests

Bursty 25-token stream with periodic 800ms silent phases protected by server heartbeats, completing without false stall detection. 50 concurrent streams started in parallel, each verified for byte-perfect content and unique stream id. Five-cycle reload chaos on a single stream (poll for 50ms, pause 40ms, repeat five times, then drain to completion) reconstructing the full expected output.

### Live test against Hono

Spawns the built `dist/hono.mjs` artifact, runs basic streaming, mid-stream resume, and 10 concurrent streams. Catches packaging bugs that pre-build tests miss.

### Live test against Cloudflare Workers

Against `wrangler dev --local` with real Durable Objects. Same three scenarios as the Hono live test, plus DO routing via `idFromName` (10 concurrent streams across 10 distinct DO instances, each with isolated buffer state).

### Soak test

A single long-running stream of 720 tokens at 1-second cadence, with 4-second silent pauses every 10 tokens (during which the server emits heartbeats), targeting roughly 12 minutes of total runtime. The client polls at 400ms throughout, persists its offset at the 5-minute mark, simulates a 3-second reload, then resumes. Cross-checked locally past the 5-minute reload mark with `withDurableStorage` enabled and zero data loss across the resume; server-reported `lastEventAt` gap stayed under 2 seconds throughout, well below the 90-second client stall threshold. Longer runtimes (10+ minute windows, real LLM upstreams) have been validated in deployed environments outside `wrangler dev`.

## Comparisons

A few things in adjacent territory and why they don't fit this problem.

Vercel's `resumable-stream` package solves resume after a dropped SSE connection using Redis pub/sub. It assumes the client environment can hold an SSE connection in the first place, which doesn't help when the fetch surface caps you at 15 seconds.

Inngest, Trigger.dev, Defer, and similar workflow engines durably execute long-running jobs. They're full backends with their own opinions, and their clients are built for "render the final result" rather than token-by-token UI streaming.

Convex, Liveblocks, and Replicache are sync engines. They solve a superset of this problem at the cost of adopting an entire backend paradigm.

## Status

Pre-alpha. The wire protocol and hook surface may shift before 1.0. Issues and feedback welcome.

## License

MIT
