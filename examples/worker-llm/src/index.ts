/**
 * Minimal stream-relay worker. Demonstrates the full server-side surface:
 *
 *   1. Subclass `RelayBuffer` to wire in your upstream (here: a fake LLM
 *      that streams "the quick brown fox..." one word at a time).
 *   2. Export `createRelayWorker()` as the default `fetch` handler.
 *   3. Export your DO subclass so wrangler can bind it.
 *
 * Replace `fakeLlm` with a real Anthropic / OpenAI / agent.ai call. The
 * relay doesn't care — anything that calls `write(chunk)` works.
 */

import { RelayBuffer, createRelayWorker, type WorkerEnv } from "stream-relay/worker";

interface Payload {
  prompt?: string;
}

interface Meta {
  tokens: number;
  durationMs: number;
}

export class MyRelay extends RelayBuffer<Payload, Meta> {
  constructor(state: DurableObjectState, env: WorkerEnv) {
    super(state, env, {
      streamTtlMs: 15 * 60 * 1000, // keep finished streams 15min for resume
      upstream: async ({ payload, write, heartbeat, signal }) => {
        const start = Date.now();
        const words = (payload.prompt ?? "the quick brown fox jumps over the lazy dog")
          .split(" ");

        for (let i = 0; i < words.length; i++) {
          if (signal.aborted) break;
          // Simulate variable latency (some "thinking", then a token).
          await sleep(i % 5 === 0 ? 1500 : 250);
          if (i % 5 === 0) heartbeat(); // long silent stretch — keep alive
          write((i === 0 ? "" : " ") + words[i]);
        }

        return { tokens: words.length, durationMs: Date.now() - start };
      },
    });
  }
}

const handler = createRelayWorker({
  // Bring-your-own-auth. Returning a Response rejects; void allows.
  auth: (request) => {
    // Example: require a shared secret header. Replace with HubSpot
    // install verification, JWT, etc.
    const expected = (globalThis as { SECRET?: string }).SECRET;
    if (expected && request.headers.get("x-relay-secret") !== expected) {
      return new Response("unauthorized", { status: 401 });
    }
  },
});

export default handler;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
