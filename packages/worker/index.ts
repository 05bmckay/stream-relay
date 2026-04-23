/**
 * Cloudflare Worker adapter.
 *
 * Why a Durable Object at all? Plain Workers isolates aren't sticky — two
 * polls 400ms apart can land on different isolates. We use the smallest
 * possible DO: a dumb in-memory buffer with no `state.storage` calls. If
 * the DO is evicted, the stream dies (same tradeoff as the Node version).
 * Hosts who need durability layer it on with the `onAppend` / `hydrate`
 * hooks just like in the Hono adapter.
 *
 * The DO is keyed by `streamId` via `idFromName`, so every poll for a given
 * stream is guaranteed to land on the same instance.
 */

import { createRelay, type RelayOptions, type Relay } from "../server";
import type { StartRequest } from "../shared/protocol";

// Re-exported so users can construct option types without importing from
// nested paths.
export type {
  Relay,
  RelayOptions,
  UpstreamHandler,
  UpstreamContext,
  FinalState,
  HydratedState,
} from "../server";
export { createRelay };

// ─────────────────────────────────────────────────────────────────────────
// Durable Object: holds one stream's buffer in memory.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Subclass this in your Worker to wire up your upstream:
 *
 *   export class MyRelay extends RelayBuffer<MyPayload, MyMeta> {
 *     constructor(state: DurableObjectState, env: Env) {
 *       super(state, env, {
 *         upstream: async ({ payload, write }) => {
 *           // call your LLM, write chunks, return meta
 *         },
 *       });
 *     }
 *   }
 *
 * Then bind it in `wrangler.toml`:
 *
 *   [[durable_objects.bindings]]
 *   name = "RELAY"
 *   class_name = "MyRelay"
 */
export abstract class RelayBuffer<TPayload = unknown, TMeta = unknown> {
  protected relay: Relay;
  protected env: unknown;

  constructor(
    _state: DurableObjectState,
    env: unknown,
    options: RelayOptions<TPayload, TMeta>,
  ) {
    this.env = env;
    this.relay = createRelay<TPayload, TMeta>(options);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      const body = (await request.json().catch(() => ({}))) as StartRequest;
      const result = await this.relay.handleStart(body);
      return Response.json(result);
    }

    if (request.method === "GET" && url.pathname === "/poll") {
      const streamId = url.searchParams.get("id") ?? "";
      const since = Number(url.searchParams.get("since") ?? 0);
      const result = await this.relay.handlePoll(streamId, since);
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Worker entry: routes external requests into the right DO instance.
// ─────────────────────────────────────────────────────────────────────────

export interface WorkerEnv {
  /** Binding name for your RelayBuffer subclass DO namespace. */
  RELAY: DurableObjectNamespace;
}

export interface RelayWorkerOptions {
  /**
   * Optional auth check. Receives the incoming request; throw or return a
   * Response to reject. Same rationale as the Hono adapter — we don't ship
   * auth, you bring your own.
   */
  auth?: (request: Request) => Promise<void | Response> | void | Response;
}

/**
 * Returns a `fetch` handler suitable for `export default { fetch }`. Routes:
 *
 *   POST /streams           → DO `/start`
 *   GET  /streams/:id       → DO `/poll`
 *
 * The DO instance is keyed by `streamId`, so all polls for one stream hit
 * the same isolate.
 */
export function createRelayWorker(options: RelayWorkerOptions = {}) {
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      if (options.auth) {
        const result = await options.auth(request);
        if (result instanceof Response) return result;
      }

      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);

      // POST /streams
      if (
        request.method === "POST" &&
        segments.length === 1 &&
        segments[0] === "streams"
      ) {
        const body = (await request.clone().json().catch(() => ({}))) as StartRequest;
        const streamId = body.streamId ?? crypto.randomUUID();
        const stub = env.RELAY.get(env.RELAY.idFromName(streamId));
        // Forward with the resolved id so the DO and client agree on it.
        return stub.fetch("https://relay/start", {
          method: "POST",
          body: JSON.stringify({ ...body, streamId }),
          headers: { "content-type": "application/json" },
        });
      }

      // GET /streams/:id
      if (
        request.method === "GET" &&
        segments.length === 2 &&
        segments[0] === "streams"
      ) {
        const streamId = segments[1];
        const since = url.searchParams.get("since") ?? "0";
        const stub = env.RELAY.get(env.RELAY.idFromName(streamId));
        return stub.fetch(
          `https://relay/poll?id=${encodeURIComponent(streamId)}&since=${since}`,
        );
      }

      return new Response("not found", { status: 404 });
    },
  };
}
