/**
 * Hono adapter. Mounts the two relay routes onto an existing Hono app or a
 * new one. The actual logic lives in `../server`; this file is only HTTP
 * plumbing.
 *
 * Why Hono and not Express? Hono runs on Node, Bun, Deno, Cloudflare,
 * Vercel, and AWS Lambda with the same code. That covers the realistic
 * deployment targets for a relay (anywhere with HTTP) without picking a
 * favorite.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { createRelay, type Relay, type RelayOptions } from "../server";
import type { StartRequest } from "../shared/protocol";

export interface HonoRelayOptions<TPayload = unknown, TMeta = unknown>
  extends RelayOptions<TPayload, TMeta> {
  /**
   * Optional auth middleware. Called for both `/streams` POST and
   * `/streams/:id` GET. Throw or return a Response to reject.
   *
   * The relay package deliberately ships no built-in auth — every host has
   * different requirements (HubSpot install verification, JWT, API key,
   * mTLS). Bring your own.
   */
  auth?: (c: Context) => Promise<void | Response> | void | Response;
}

export interface MountedRelay<TPayload = unknown, TMeta = unknown> {
  app: Hono;
  relay: Relay;
}

export function createRelayApp<TPayload = unknown, TMeta = unknown>(
  options: HonoRelayOptions<TPayload, TMeta>,
): MountedRelay<TPayload, TMeta> {
  const app = new Hono();
  const relay = createRelay<TPayload, TMeta>(options);

  if (options.auth) {
    const authFn = options.auth;
    const wrap = async (c: Context, next: () => Promise<void>) => {
      const result = await authFn(c);
      if (result instanceof Response) return result;
      await next();
      return undefined;
    };
    app.use("/streams", wrap);
    app.use("/streams/*", wrap);
  }

  app.post("/streams", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as StartRequest;
    const result = await relay.handleStart(body);
    return c.json(result);
  });

  app.get("/streams/:id", async (c) => {
    const streamId = c.req.param("id");
    const since = parseOffset(c.req.query("since"));
    const eventSince = parseOffset(c.req.query("eventSince"));
    const result = await relay.handlePoll(streamId, since, eventSince);
    return c.json(result);
  });

  return { app, relay };
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export { createRelay, withKvStorage, withSqliteStorage, kvFromCloudflare, sqliteKvFromDatabase } from "../server";
export type {
  Relay,
  RelayOptions,
  UpstreamHandler,
  UpstreamContext,
  FinalState,
  HydratedState,
  ProgressState,
  RelayEvent,
  KVStore,
  KvStorageOptions,
  SqliteDatabase,
  SqliteStorageOptions,
} from "../server";
