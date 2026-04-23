# stream-relay

Resumable, pollable stream proxy for clients that can't hold long connections.

If your frontend lives somewhere with a short fetch ceiling (HubSpot UI extensions, sandboxed iframes, embedded SaaS surfaces) and your backend takes longer than that ceiling allows (LLM calls, agent runs, slow APIs), this package sits between them. The client polls a small endpoint at 400ms; the server buffers the upstream response in memory; reloads pick up exactly where they left off.

## Drop-in by design

You don't change how your client makes requests, you just point at the relay instead of the upstream and use a hook for the response. You don't change how your backend works either; the upstream handler receives a `write` function, you call it with chunks, the relay does the rest. Two endpoints (`POST /streams`, `GET /streams/:id`), one React hook, no SSE plumbing, no WebSocket configuration, no sticky load balancing.

## When to use it

Reach for stream-relay when the client environment caps individual fetch calls and you can't switch transports. HubSpot extensions are the canonical case: even with the new 120s ceiling, holding an SSE connection through `hubspot.fetch` is unreliable, page reloads kill the stream, and you have no good answer for resume.

If you control both ends and can use plain SSE or streamed `fetch` responses, you don't need this. Use those instead.

## How it works

```
+------------------+      poll every 400ms       +------------------+    long upstream     +------------------+
|   React client   | --------------------------> |   stream-relay   | -----------------> |   LLM / agent    |
|   useStream()    | <-- { append, nextOffset }- |     (server)     | <-- tokens ------- |  / any slow API  |
+------------------+                             +------------------+                    +------------------+
```

The relay buffers upstream output in memory. The client polls `GET /streams/:id?since=N` and asks for bytes past its last-known offset. On reload, the client sends the persisted offset and gets exactly the bytes it missed. No SSE, no WebSockets, no sticky load balancing required.

## Install

```sh
npm install stream-relay
```

One package, four entry points. Bundlers only pull in what you import.

## Server: Cloudflare Workers

```ts
// worker.ts
import { RelayBuffer, createRelayWorker } from "stream-relay/worker";

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

## Server: Node, Bun, or Deno via Hono

```ts
import { createRelayApp } from "stream-relay/hono";
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

## Client: React

```tsx
import { useStream } from "stream-relay/client";
import { useState } from "react";

function MyCard() {
  const [streamId, setStreamId] = useState(null);
  const [text, setText] = useState("");

  const { isStreaming, reconnecting } = useStream({
    proxyUrl: "https://your-relay.workers.dev",
    streamId,
    fetcher: hubspot.fetch,
    onChunk: (append) => setText((t) => t + append),
    onDone: ({ meta }) => console.log("usage:", meta),
  });

  const start = async () => {
    setText("");
    const res = await hubspot.fetch(`${RELAY_URL}/streams`, {
      method: "POST",
      body: JSON.stringify({ payload: { prompt: "Tell me a joke" } }),
    });
    const { streamId } = await res.json();
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

The call is idempotent: re-posting the same `streamId` while a stream is live returns the existing stream's metadata without restarting the upstream. Saves you from persisting an extra ID alongside whatever you already track.

## Resuming after reload

The hook returns the current `offset`. Persist it alongside `streamId` (in `localStorage`, HubSpot card properties, your DB, anywhere). On the next mount, pass the saved offset back as `resumeFrom` and the hook delivers only the bytes that arrived while you were gone.

```tsx
const { offset } = useStream({
  streamId: persisted.streamId,
  resumeFrom: persisted.offset,
  // ...
});
```

If the relay garbage-collected the buffer before you came back, `onError` fires with a `StreamNotFoundError`. Your app decides whether to restart the upstream or surrender.

## Persistence (optional)

Default behavior is in-memory. If the server restarts, in-flight streams die with it. For most uses (single-region edge deploy, LLM proxying) this is fine. When you need streams to survive deploys, evictions, or multi-day resume windows, opt into one of the bundled persistence helpers.

### Cloudflare: Durable Object storage

```ts
import { RelayBuffer, withDurableStorage } from "stream-relay/worker";

export class MyRelay extends RelayBuffer {
  constructor(state, env) {
    super(state, env, withDurableStorage(state, {
      upstream: async ({ payload, write }) => { /* ... */ },
    }));
  }
}
```

Every chunk is debounced into the DO's storage. On rehydrate (eviction, deploy, cold start) the buffer is read back transparently.

### Hono / Node / anywhere: KV interface

```ts
import { createRelayApp, withKvStorage } from "stream-relay/hono";

const myKv = {
  get: (k) => redis.get(k),
  set: (k, v) => redis.set(k, v),
  delete: (k) => redis.del(k),
};

const { app } = createRelayApp(withKvStorage(myKv, {
  upstream: async ({ payload, write }) => { /* ... */ },
}));
```

`withKvStorage` accepts any `{ get, set, delete? }` shape. Drop in Redis, Upstash, Cloudflare KV (via `kvFromCloudflare`), or your own database. Writes are debounced (default 500ms); set `flushIntervalMs: 0` for synchronous-per-chunk durability.

### Roll your own

The persistence helpers are thin wrappers over four optional callbacks on `RelayOptions`. If you want different semantics (chunked storage, compression, multi-tenant key prefixing), wire `onAppend`, `onComplete`, `onError`, and `hydrate` directly. The relay core never reaches into storage.

## Auth

This package does not ship built-in auth. Every host has different requirements (HubSpot install verification, JWT, mTLS, API keys), so we leave the choice to you:

```ts
createRelayWorker({
  auth: (request) => {
    if (!isValidHubSpotInstall(request)) {
      return new Response("unauthorized", { status: 401 });
    }
  },
});
```

The same `auth` option works on both the Worker and Hono adapters.

## API reference

### `useStream(options)` from `stream-relay/client`

| Option | Default | Purpose |
|---|---|---|
| `proxyUrl` | required | Base URL of your deployed relay |
| `streamId` | required | Stream to subscribe to (`null` = inert) |
| `fetcher` | global `fetch` | HTTP client (use `hubspot.fetch` in extensions) |
| `intervalMs` | 400 | Poll cadence |
| `resumeFrom` | 0 | Byte offset, or `"live"` to skip backlog |
| `reconnect.serverStallMs` | 90000 | Give-up threshold for silent server |
| `reconnect.staleResyncMs` | 3000 | Force-resync threshold for client |

Full JSDoc on every option in [`packages/client/index.ts`](./packages/client/index.ts).

### `createRelay(options)` from `stream-relay/server`

Framework-agnostic core if you're rolling your own HTTP layer. Returns `{ handleStart, handlePoll }` as pure async functions.

### `createRelayApp(options)` from `stream-relay/hono`

Hono app with `POST /streams` and `GET /streams/:id` mounted. Runs on Node, Bun, Deno, Vercel, AWS Lambda, or Cloudflare Pages.

### `RelayBuffer`, `createRelayWorker()`, `withDurableStorage()` from `stream-relay/worker`

Cloudflare Workers + Durable Object. Subclass `RelayBuffer` to wire your upstream; `createRelayWorker()` returns the routing `fetch` handler; `withDurableStorage()` opts into DO-backed durability.

### `withKvStorage(kv, options)` from `stream-relay/server`

Persistence helper for any KV-shaped store. Accepts `{ get, set, delete? }`. Use directly with `createRelay` or wrap a Hono app's options.

## Wire protocol

The contract is small enough to reimplement in any language:

```
POST /streams          { streamId?, payload? }
                       -> { streamId, startedAt }

GET  /streams/:id?since=N
                       -> { status, append, nextOffset, lastEventAt, serverNow,
                            final?: { text, meta? }, error? }
```

`status` is one of `streaming`, `done`, `error`, `not_found`. Clients use `serverNow - lastEventAt > serverStallMs` to detect dead streams without trusting their own clock.

## What we tested

The package was built test-driven. Validation runs through:

- **Unit tests** against the framework-agnostic core: happy path, error cases, idempotent start, heartbeat behavior, persistence hooks, rehydration, resume semantics, concurrent polls, out-of-range offset clamping.
- **Integration tests** against a live Hono server: full HTTP round-trips, mid-stream disconnect-and-resume, multiple concurrent clients on the same stream, idempotent POST behavior with user-supplied IDs.
- **Stress tests**: bursty streams with simulated tool-call pauses, 50 concurrent streams running in parallel, five disconnect-and-reconnect cycles on a single stream.
- **Hono live test**: spins up a real `@hono/node-server`, exercises basic streaming, mid-stream resume, and 10 concurrent streams.
- **Worker live test**: against the `wrangler dev` Cloudflare runtime with real Durable Objects, exercises basic streaming, mid-stream resume across simulated reload, and 10 concurrent streams across distinct DO instances.
- **Soak test**: a 12-minute single stream (720 tokens at 1s cadence with periodic 4-second silent phases protected by server heartbeats), one mid-stream reload at the 5-minute mark, and full byte-level verification of the result.

## Comparisons

A few things in adjacent territory and why they don't fit this problem.

Vercel's `resumable-stream` package solves resume after a dropped SSE connection using Redis pub/sub. It assumes the client environment can hold an SSE connection in the first place, which doesn't help when the fetch surface caps you at 15 or 120 seconds.

Inngest, Trigger.dev, Defer, and similar workflow engines durably execute long-running jobs. They're full backends with their own opinions, and their clients are built for "render the final result" rather than token-by-token UI streaming.

Convex, Liveblocks, and Replicache are sync engines. They solve a superset of this problem at the cost of adopting an entire backend paradigm.

## Status

Pre-alpha. The wire protocol and hook surface may shift before 1.0. Issues and feedback welcome.

## License

MIT
