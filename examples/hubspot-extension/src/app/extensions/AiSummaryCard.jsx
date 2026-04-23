/**
 * Believable HubSpot CRM card. Generates an AI summary for the current
 * contact via a long-running upstream (LLM call, agent run, internal
 * research API), streamed through stream-relay so the card never blocks
 * on a single fetch.
 *
 * Persists {streamId, offset} to the contact's CRM properties. If the
 * user closes the card mid-generation and reopens it, we pick up exactly
 * where we left off without re-running the upstream.
 *
 * Drop this in apps/<your-app>/src/app/extensions/ and register it in
 * your hsproject's serverless config.
 */

import React, { useEffect, useState } from "react";
import {
  hubspot,
  Button,
  Text,
  Heading,
  Flex,
  Tile,
  EmptyState,
  Alert,
  LoadingSpinner,
  Divider,
} from "@hubspot/ui-extensions";
import { useStream, StreamNotFoundError } from "stream-relay/client";

const RELAY_URL = "https://your-relay.workers.dev";
const PROP_STREAM_ID = "ai_summary_stream_id";
const PROP_STREAM_OFFSET = "ai_summary_stream_offset";
const PROP_LAST_SUMMARY = "ai_summary_text";

hubspot.extend(({ context, runServerlessFunction, actions }) => (
  <AiSummaryCard
    context={context}
    runServerless={runServerlessFunction}
    actions={actions}
  />
));

function AiSummaryCard({ context, runServerless, actions }) {
  const contactId = context.crm.objectId;

  const [streamId, setStreamId] = useState(null);
  const [resumeFrom, setResumeFrom] = useState(0);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [hydrating, setHydrating] = useState(true);

  // On mount, check if the contact has a previous in-flight (or completed)
  // summary we should rehydrate. This is the "I closed the card and came
  // back five minutes later" path.
  useEffect(() => {
    let cancelled = false;
    runServerless({
      name: "loadSummaryState",
      parameters: { contactId },
    }).then((res) => {
      if (cancelled) return;
      const props = res?.response?.properties ?? {};
      if (props[PROP_LAST_SUMMARY]) setText(props[PROP_LAST_SUMMARY]);
      if (props[PROP_STREAM_ID]) {
        setStreamId(props[PROP_STREAM_ID]);
        setResumeFrom(Number(props[PROP_STREAM_OFFSET] ?? 0));
      }
      setHydrating(false);
    });
    return () => {
      cancelled = true;
    };
  }, [contactId, runServerless]);

  const { isStreaming, reconnecting, offset } = useStream({
    proxyUrl: RELAY_URL,
    streamId,
    fetcher: hubspot.fetch,
    resumeFrom,
    onChunk: (append) => setText((prev) => prev + append),
    onDone: ({ text: finalText }) => {
      // Persist the final summary and clear the in-flight pointers.
      runServerless({
        name: "saveSummaryState",
        parameters: {
          contactId,
          summary: finalText,
          streamId: null,
          offset: 0,
        },
      });
    },
    onError: (err) => {
      if (err instanceof StreamNotFoundError) {
        // Relay buffer expired before we could resume. Show what we had.
        setError("Previous summary expired. Click Generate to start a new one.");
        setStreamId(null);
        setResumeFrom(0);
      } else {
        setError(err.message);
      }
    },
  });

  // Persist the offset every time it advances so reload-resume always
  // picks up at the latest known position.
  useEffect(() => {
    if (!streamId || !isStreaming) return;
    runServerless({
      name: "saveSummaryState",
      parameters: { contactId, streamId, offset },
    });
  }, [streamId, offset, isStreaming, contactId, runServerless]);

  const start = async () => {
    setText("");
    setError(null);
    setResumeFrom(0);

    const res = await hubspot.fetch(`${RELAY_URL}/streams`, {
      method: "POST",
      body: JSON.stringify({
        payload: { contactId, kind: "summary" },
      }),
    });

    if (!res.ok) {
      setError(`Failed to start (${res.status})`);
      return;
    }

    const { streamId: newId } = await res.json();
    setStreamId(newId);

    // Persist the streamId immediately so a reload before any tokens
    // arrive can still resume from offset 0.
    runServerless({
      name: "saveSummaryState",
      parameters: { contactId, streamId: newId, offset: 0 },
    });
  };

  if (hydrating) {
    return (
      <Tile>
        <LoadingSpinner label="Loading summary..." />
      </Tile>
    );
  }

  return (
    <Tile>
      <Flex direction="column" gap="md">
        <Flex direction="row" justify="between" align="center">
          <Heading>AI summary</Heading>
          <Button
            variant="primary"
            onClick={start}
            disabled={isStreaming}
          >
            {isStreaming
              ? reconnecting
                ? "Reconnecting..."
                : "Generating..."
              : text
                ? "Regenerate"
                : "Generate"}
          </Button>
        </Flex>

        {error && (
          <Alert variant="warning" title="Generation issue">
            {error}
          </Alert>
        )}

        {reconnecting && (
          <Alert variant="info" title="Reconnecting">
            Lost a poll, catching up...
          </Alert>
        )}

        <Divider />

        {text ? (
          <Text>{text}</Text>
        ) : (
          <EmptyState title="No summary yet" layout="vertical">
            <Text>
              Click Generate to produce an AI summary of this contact's recent
              activity.
            </Text>
          </EmptyState>
        )}
      </Flex>
    </Tile>
  );
}
