import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  EmptyState,
  Flex,
  Heading,
  LoadingSpinner,
  Text,
  Tile,
  hubspot,
} from "@hubspot/ui-extensions";
import { StreamNotFoundError, useStream } from "stream-relay/client";

const RELAY_URL = "https://your-relay.workers.dev";

const SUMMARY_PROPS = {
  streamId: "ai_summary_stream_id",
  offset: "ai_summary_stream_offset",
  summary: "ai_summary_text",
};

hubspot.extend<"crm.record.tab">(({ context, runServerlessFunction, actions }) => (
  <AiSummaryCard
    context={context}
    runServerlessFunction={runServerlessFunction}
    addAlert={actions.addAlert}
  />
));

function AiSummaryCard({ context, runServerlessFunction, addAlert }: any) {
  const contactId = context.crm?.objectId;

  const [hydrating, setHydrating] = useState(true);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [resumeFrom, setResumeFrom] = useState(0);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadSavedState() {
      if (!contactId) {
        setError("Open this card on a contact record to generate a summary.");
        setHydrating(false);
        return;
      }

      try {
        const result = await runServerlessFunction({
          name: "load-summary-state",
          parameters: { contactId },
        });

        if (cancelled) return;

        const properties = result.response?.properties || {};
        const savedSummary = properties[SUMMARY_PROPS.summary];
        const savedStreamId = properties[SUMMARY_PROPS.streamId];
        const savedOffset = Number(properties[SUMMARY_PROPS.offset] || 0);

        if (savedSummary) setSummary(savedSummary);
        if (savedStreamId) {
          setStreamId(savedStreamId);
          setResumeFrom(Number.isFinite(savedOffset) ? savedOffset : 0);
        }
      } catch (err) {
        const message = getErrorMessage(err, "Unable to load saved summary state");
        setError(message);
        addAlert({ type: "danger", title: "AI summary failed to load", message });
      } finally {
        if (!cancelled) setHydrating(false);
      }
    }

    loadSavedState();

    return () => {
      cancelled = true;
    };
  }, [addAlert, contactId, runServerlessFunction]);

  const { isStreaming, reconnecting, offset } = useStream({
    proxyUrl: RELAY_URL,
    streamId,
    fetcher: hubspot.fetch,
    resumeFrom,
    onChunk: (append) => setSummary((current) => current + append),
    onDone: ({ text }) => {
      void saveSummaryState(runServerlessFunction, contactId, {
        summary: text,
        streamId: null,
        offset: 0,
      });

      addAlert({
        type: "success",
        title: "AI summary complete",
        message: "The summary was saved to the contact.",
      });
    },
    onError: (err) => {
      if (err instanceof StreamNotFoundError) {
        setError("The saved relay stream expired. Click Generate to start again.");
        setStreamId(null);
        setResumeFrom(0);
        return;
      }

      setError(getErrorMessage(err, "Unable to continue the stream"));
    },
  });

  useEffect(() => {
    if (!contactId || !streamId || !isStreaming) return;

    void saveSummaryState(runServerlessFunction, contactId, {
      streamId,
      offset,
    });
  }, [contactId, isStreaming, offset, runServerlessFunction, streamId]);

  async function startSummary() {
    if (!contactId) return;

    setSummary("");
    setError("");
    setResumeFrom(0);

    const response = await hubspot.fetch(`${RELAY_URL}/streams`, {
      method: "POST",
      body: JSON.stringify({
        payload: { contactId, kind: "contact-summary" },
      }),
    });

    if (!response.ok) {
      const message = `Failed to start relay stream (${response.status})`;
      setError(message);
      addAlert({ type: "danger", title: "AI summary failed", message });
      return;
    }

    const body = await response.json();
    setStreamId(body.streamId);

    await saveSummaryState(runServerlessFunction, contactId, {
      streamId: body.streamId,
      offset: 0,
      summary: "",
    });
  }

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
          <Button variant="primary" onClick={startSummary} disabled={isStreaming || !contactId}>
            {isStreaming ? (reconnecting ? "Reconnecting..." : "Generating...") : summary ? "Regenerate" : "Generate"}
          </Button>
        </Flex>

        {error ? (
          <Alert variant="warning" title="Generation issue">
            {error}
          </Alert>
        ) : null}

        {reconnecting ? (
          <Alert variant="info" title="Reconnecting">
            Lost a poll, catching up from the last saved offset.
          </Alert>
        ) : null}

        <Divider />

        {summary ? (
          <Text>{summary}</Text>
        ) : (
          <EmptyState title="No summary yet" layout="vertical">
            <Text>Click Generate to produce an AI summary of this contact's recent activity.</Text>
          </EmptyState>
        )}
      </Flex>
    </Tile>
  );
}

async function saveSummaryState(runServerlessFunction: any, contactId: string | number | undefined, state: any) {
  if (!contactId) return;

  await runServerlessFunction({
    name: "save-summary-state",
    parameters: { contactId, ...state },
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
