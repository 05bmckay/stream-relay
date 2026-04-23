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
const PROP_STREAM_ID = "ai_summary_stream_id";
const PROP_STREAM_OFFSET = "ai_summary_stream_offset";
const PROP_LAST_SUMMARY = "ai_summary_text";

type HubSpotContext = {
  crm?: {
    objectId?: number | string;
    objectTypeId?: string;
  };
};

type AlertType = "info" | "tip" | "success" | "warning" | "danger";

type AddAlert = (alert: {
  title?: string;
  message: string;
  type?: AlertType;
}) => void;

type RunServerlessFunction = (request: {
  name: string;
  parameters?: Record<string, unknown>;
}) => Promise<{ response?: unknown }>;

type SummaryState = {
  properties?: Partial<Record<typeof PROP_STREAM_ID | typeof PROP_STREAM_OFFSET | typeof PROP_LAST_SUMMARY, string>>;
};

type AiSummaryCardProps = {
  context: HubSpotContext;
  runServerlessFunction: RunServerlessFunction;
  addAlert: AddAlert;
};

hubspot.extend<"crm.record.tab">(({ context, runServerlessFunction, actions }) => (
  <AiSummaryCard
    context={context as HubSpotContext}
    runServerlessFunction={runServerlessFunction as RunServerlessFunction}
    addAlert={actions.addAlert as AddAlert}
  />
));

function AiSummaryCard({
  context,
  runServerlessFunction,
  addAlert,
}: AiSummaryCardProps) {
  const contactId = context.crm?.objectId;

  const [streamId, setStreamId] = useState<string | null>(null);
  const [resumeFrom, setResumeFrom] = useState(0);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      if (!contactId) {
        setError("This card must be opened on a contact record.");
        setHydrating(false);
        return;
      }

      try {
        const result = await runServerlessFunction({
          name: "load-summary-state",
          parameters: { contactId },
        });

        if (cancelled) return;

        const state = result.response as SummaryState | undefined;
        const properties = state?.properties ?? {};
        const savedSummary = properties[PROP_LAST_SUMMARY];
        const savedStreamId = properties[PROP_STREAM_ID];
        const savedOffset = Number(properties[PROP_STREAM_OFFSET] ?? 0);

        if (savedSummary) setText(savedSummary);
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

    hydrate();

    return () => {
      cancelled = true;
    };
  }, [addAlert, contactId, runServerlessFunction]);

  const { isStreaming, reconnecting, offset } = useStream({
    proxyUrl: RELAY_URL,
    streamId,
    fetcher: hubspot.fetch,
    resumeFrom,
    onChunk: (append) => setText((previous) => previous + append),
    onDone: ({ text: finalText }) => {
      void saveState(runServerlessFunction, contactId, {
        summary: finalText,
        streamId: null,
        offset: 0,
      });
      addAlert({ type: "success", title: "AI summary complete", message: "The summary was saved to the contact." });
    },
    onError: (err) => {
      if (err instanceof StreamNotFoundError) {
        setError("The saved relay stream expired. Click Generate to start a new summary.");
        setStreamId(null);
        setResumeFrom(0);
        return;
      }

      setError(getErrorMessage(err, "Unable to continue the stream"));
    },
  });

  useEffect(() => {
    if (!contactId || !streamId || !isStreaming) return;

    void saveState(runServerlessFunction, contactId, {
      streamId,
      offset,
    });
  }, [contactId, isStreaming, offset, runServerlessFunction, streamId]);

  const start = async () => {
    if (!contactId) return;

    setText("");
    setError(null);
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

    const body = (await response.json()) as { streamId: string };
    setStreamId(body.streamId);

    await saveState(runServerlessFunction, contactId, {
      streamId: body.streamId,
      offset: 0,
      summary: "",
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
          <Button variant="primary" onClick={start} disabled={isStreaming || !contactId}>
            {isStreaming ? (reconnecting ? "Reconnecting..." : "Generating...") : text ? "Regenerate" : "Generate"}
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

        {text ? (
          <Text>{text}</Text>
        ) : (
          <EmptyState title="No summary yet" layout="vertical">
            <Text>Click Generate to produce an AI summary of this contact's recent activity.</Text>
          </EmptyState>
        )}
      </Flex>
    </Tile>
  );
}

async function saveState(
  runServerlessFunction: RunServerlessFunction,
  contactId: number | string | undefined,
  state: {
    streamId?: string | null;
    offset?: number;
    summary?: string;
  }
) {
  if (!contactId) return;

  await runServerlessFunction({
    name: "save-summary-state",
    parameters: { contactId, ...state },
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
