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

import {
  RelayBuffer,
  createRelayWorker,
  withDurableStorage,
  type WorkerEnv,
  type RelayOptions,
} from "stream-relay/worker";

// Long streams (multi-minute LLM calls, agent runs) almost always want
// this on: it makes every stream survive DO eviction, Workers deploys,
// accidental restarts, and multi-day resume windows. Costs one DO storage
// write per chunk with built-in debouncing. Flip to false only if you're
// confident your streams complete inside a single DO lifetime.
const DURABLE = true;

interface Payload {
  prompt?: string;
  /** Per-token delay in ms (default 250). Set higher to simulate slow LLMs. */
  wordDelayMs?: number;
  /** Insert a longer pause every N tokens (default 5). */
  pauseEvery?: number;
  /** Length of the periodic pause in ms (default 1500). */
  pauseDelayMs?: number;
  /**
   * Override token count. If omitted, splits prompt by whitespace. Useful
   * for soak tests where you want N synthetic tokens without typing them.
   */
  tokenCount?: number;
}

interface Meta {
  tokens: number;
  durationMs: number;
}

export class MyRelay extends RelayBuffer<Payload, Meta> {
  constructor(state: DurableObjectState, env: WorkerEnv) {
    const baseOptions: RelayOptions<Payload, Meta> = {
      streamTtlMs: 30 * 60 * 1000, // keep finished streams 30min for resume
      upstream: async ({ payload, write, heartbeat, signal }) => {
        const start = Date.now();
        const wordDelay = payload.wordDelayMs ?? 250;
        const pauseEvery = payload.pauseEvery ?? 5;
        const pauseDelay = payload.pauseDelayMs ?? 1500;

        const words = payload.tokenCount
          ? Array.from({ length: payload.tokenCount }, (_, i) => `t${i}`)
          : (payload.prompt ?? "the quick brown fox jumps over the lazy dog").split(" ");

        for (let i = 0; i < words.length; i++) {
          if (signal.aborted) break;

          // Periodic long silent stretch with heartbeats so the client's
          // server-stall detector stays happy through tool-call-style pauses.
          if (i > 0 && i % pauseEvery === 0) {
            const heartbeats = Math.max(1, Math.floor(pauseDelay / 2000));
            for (let h = 0; h < heartbeats; h++) {
              await sleep(pauseDelay / heartbeats);
              heartbeat();
            }
          }

          await sleep(wordDelay);
          write((i === 0 ? "" : " ") + words[i]);
        }

        return { tokens: words.length, durationMs: Date.now() - start };
      },
    };

    // Same upstream, optional persistence layer. The relay still runs
    // in-memory at full speed; storage writes happen in the background.
    super(
      state,
      env,
      DURABLE ? withDurableStorage(state, baseOptions) : baseOptions,
    );
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
