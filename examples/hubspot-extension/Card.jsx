/**
 * Minimal HubSpot UI extension card using stream-relay.
 *
 * Flow:
 *   1. User clicks "Run". We POST to the relay's /streams to kick off the
 *      upstream call and get back a streamId.
 *   2. We persist {streamId, offset} to the CRM card properties (or
 *      localStorage, your call) so a reload can resume.
 *   3. useStream polls the relay every 400ms, appending new tokens into
 *      local state until the run finishes.
 *
 * The card itself is HubSpot-specific (the Text/Button imports). The
 * stream-relay piece is exactly the same shape you'd use anywhere else.
 */

import { useEffect, useState } from "react";
import { hubspot, Button, Text, Flex } from "@hubspot/ui-extensions";
import { useStream, StreamNotFoundError } from "stream-relay/client";

const RELAY_URL = "https://your-relay.workers.dev";

hubspot.extend(() => <Card />);

function Card() {
  const [streamId, setStreamId] = useState(null);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);

  const { isStreaming, reconnecting, offset } = useStream({
    proxyUrl: RELAY_URL,
    streamId,
    fetcher: hubspot.fetch, // critical — sends portal context to your auth
    onChunk: (append) => setText((prev) => prev + append),
    onDone: ({ meta }) => {
      console.log("done", meta);
    },
    onError: (err) => {
      if (err instanceof StreamNotFoundError) {
        // Buffer was GC'd — caller decides whether to restart.
        setError("Stream expired. Click Run to restart.");
        setStreamId(null);
      } else {
        setError(err.message);
      }
    },
  });

  // Resume across reloads: persist {streamId, offset} so we can pick up
  // exactly where we left off. (Skipping actual storage wiring for brevity;
  // in real code use HubSpot card properties or localStorage.)
  useEffect(() => {
    if (streamId) {
      // savePersisted({ streamId, offset });
    }
  }, [streamId, offset]);

  const start = async () => {
    setText("");
    setError(null);
    const res = await hubspot.fetch(`${RELAY_URL}/streams`, {
      method: "POST",
      body: JSON.stringify({ payload: { prompt: "Tell me a joke." } }),
    });
    const { streamId: id } = await res.json();
    setStreamId(id);
  };

  return (
    <Flex direction="column" gap="sm">
      <Button onClick={start} disabled={isStreaming}>
        {isStreaming ? (reconnecting ? "Reconnecting…" : "Running…") : "Run"}
      </Button>
      {text && <Text>{text}</Text>}
      {error && <Text variant="error">{error}</Text>}
    </Flex>
  );
}
