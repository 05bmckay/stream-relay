# stream-relay

> Resumable, pollable stream proxy for environments where the client can't hold long connections.

**Use this when:** your client (HubSpot UI extension, Salesforce LWC, embedded iframe, mobile webview) can only do short-lived `fetch()` calls, but your upstream (LLM, agent, long-running job) takes longer than the client's timeout window.

**Don't use this when:** you control both ends and can use plain SSE / WebSockets / streamed `fetch` responses. You don't need a proxy.

## The problem

HubSpot UI extensions cap `fetch()` at 15s (recently raised to 120s, optionally). LLM and agent calls regularly run longer than that. Even when they don't, holding an SSE connection through a sandboxed fetch proxy is unreliable — connections drop, page reloads happen, and you lose the stream.

## How it works

```
┌──────────────┐      poll every 400ms       ┌──────────────┐    long upstream     ┌──────────────┐
│ React client │ ──────────────────────────▶ │ stream-relay │ ──────────────────▶ │  LLM / agent │
│  useStream() │ ◀── { append, nextOffset } ─│   (server)   │ ◀── tokens ──────── │   / whatever │
└──────────────┘                             └──────────────┘                     └──────────────┘
```

The relay buffers upstream output in memory. The client polls a tiny `GET /streams/:id?since=N` endpoint and asks for bytes past its last-known offset. Reload the page? Send the persisted offset, get exactly the bytes you missed. No SSE, no WebSockets, no sticky load balancing.

## Install

```sh
npm install stream-relay
```

One package, four entry points, only what you import gets bundled.

## Quickstart

### Server (Cloudflare Workers)

```ts
// worker.ts
import { RelayBuffer, createRelayWorker } from "stream-relay/worker";

export class MyRelay extends RelayBuffer {
  constructor(state, env) {
    super(state, env, {
      upstream: async ({ payload, write }) => {
        // Call your real upstream here. Anthropic, OpenAI, agent.ai,
        // a slow internal API — anything. Stream tokens via write().
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

`wrangler deploy` and you're done.

### Server (Node / Bun / Deno via Hono)

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

### Client (React, anywhere)

```tsx
import { useStream } from "stream-relay/client";

function Card() {
  const [streamId, setStreamId] = useState(null);
  const [text, setText] = useState("");

  const { isStreaming, reconnecting } = useStream({
    proxyUrl: "https://your-relay.workers.dev",
    streamId,
    fetcher: hubspot.fetch, // or plain `fetch` outside HubSpot
    onChunk: (append) => setText((t) => t + append),
    onDone: ({ meta }) => console.log("usage:", meta),
  });

  const start = async () => {
    const res = await fetch(`${RELAY_URL}/streams`, {
      method: "POST",
      body: JSON.stringify({ payload: { prompt: "Tell me a joke" } }),
    });
    const { streamId } = await res.json();
    setStreamId(streamId);
  };

  return (
    <>
      <button onClick={start} disabled={isStreaming}>
        {reconnecting ? "Reconnecting…" : isStreaming ? "Running…" : "Run"}
      </button>
      <div>{text}</div>
    </>
  );
}
```

That's the whole API on the happy path.

## Resuming after reload

Persist `{ streamId, offset }` (returned from the hook) anywhere you like — `localStorage`, HubSpot card properties, your DB. On mount, re-supply them:

```tsx
const { offset } = useStream({
  streamId: persisted.streamId,
  resumeFrom: persisted.offset, // pick up exactly where we left off
  // ...
});
```

If the relay has GC'd the buffer, `onError` fires with a `StreamNotFoundError` — caller decides whether to restart the upstream or surrender.

## Persistence (optional)

In-memory by default. Server restart = active streams die. For most uses (single-region edge deploy, LLM proxying) that's fine. If you want durability:

```ts
createRelayApp({
  upstream: ...,
  onAppend:   async (id, chunk, offset) => myDb.append(id, chunk),
  onComplete: async (id, final)         => myDb.complete(id, final),
  onError:    async (id, message)       => myDb.error(id, message),
  hydrate:    async (id)                => myDb.load(id),
});
```

The relay calls these best-effort and never blocks the upstream on them.

## Auth

stream-relay ships **no built-in auth**. Every host has different needs (HubSpot install verification, JWT, mTLS, API keys). Bring your own:

```ts
createRelayWorker({
  auth: (request) => {
    if (!isValidHubSpotInstall(request)) {
      return new Response("unauthorized", { status: 401 });
    }
  },
});
```

## API reference

### `useStream(options)` — `stream-relay/client`

See [`packages/client/index.ts`](./packages/client/index.ts) for full JSDoc. Key options:

| Option | Default | Meaning |
|---|---|---|
| `proxyUrl` | (required) | Base URL of your deployed relay |
| `streamId` | (required) | Stream to subscribe to (`null` = inert) |
| `fetcher` | `fetch` | HTTP client (use `hubspot.fetch` in extensions) |
| `intervalMs` | 400 | Poll cadence |
| `resumeFrom` | 0 | `0` / byte offset / `"live"` |
| `reconnect.serverStallMs` | 90000 | Give-up threshold for silent server |
| `reconnect.staleResyncMs` | 3000 | Force `since=0` resync threshold |

### `createRelay(options)` — `stream-relay/server`

Framework-agnostic core if you're rolling your own HTTP layer. Returns `{ handleStart, handlePoll }` — pure functions.

### `createRelayApp(options)` — `stream-relay/hono`

Hono app with `POST /streams` and `GET /streams/:id` mounted. Drop into Node, Bun, Deno, Vercel, Lambda.

### `RelayBuffer` + `createRelayWorker()` — `stream-relay/worker`

Cloudflare Workers + Durable Object. Subclass `RelayBuffer` to wire your upstream; `createRelayWorker()` returns the routing `fetch` handler.

## Wire protocol

If you want to implement a relay in another language, the contract is tiny:

```
POST /streams          { streamId?, payload? }       → { streamId, startedAt }
GET  /streams/:id?since=N
                       → { status, append, nextOffset, lastEventAt, serverNow,
                           final?: { text, meta? }, error? }
```

`status` is `"streaming" | "done" | "error" | "not_found"`. The client uses `serverNow - lastEventAt > serverStallMs` to detect dead streams. That's it.

## Why not...

- **Vercel `resumable-stream`** — Redis pub/sub + SSE. Doesn't help when the client environment can't hold an SSE connection (HubSpot fetch proxy, sandboxed iframes). Different problem.
- **Inngest / Trigger.dev / Defer** — workflow engines. Way more than you need; their clients aren't built for token-by-token UI streaming.
- **Convex / Liveblocks / Replicache** — sync engines. Adopt-a-backend, not a 200-line proxy.

## Status

Pre-alpha. API may change. Feedback and issues welcome.

## License

MIT
