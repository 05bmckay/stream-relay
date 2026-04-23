# HubSpot CRM card example

A realistic HubSpot UI extension card that uses stream-relay to generate
an AI summary for the current contact. Demonstrates:

- Kicking off a long upstream call from `hubspot.fetch`
- Streaming tokens into the card via `useStream`
- Persisting `{streamId, offset}` to a contact property so a reload picks
  up exactly where it left off
- Handling `StreamNotFoundError` when a stream expires before resume
- Showing the `reconnecting` affordance when polls drop

## Required serverless functions

The card uses two serverless functions for state persistence:

- `loadSummaryState({ contactId })` reads the three custom properties below
  from the contact and returns them.
- `saveSummaryState({ contactId, streamId?, offset?, summary? })` writes
  whichever subset is supplied.

Both are thin wrappers around the HubSpot Contacts API. Implement them in
your project's `app.functions/` directory.

## Required custom contact properties

Create these in HubSpot before installing the card:

| Internal name | Type | Field type |
|---|---|---|
| `ai_summary_stream_id` | Single-line text | Text |
| `ai_summary_stream_offset` | Number | Number |
| `ai_summary_text` | Multi-line text | Multi-line text |

## Required deps

```sh
npm install stream-relay react @hubspot/ui-extensions
```

## Where to put it

Drop `AiSummaryCard.jsx` into your project at
`src/app/extensions/AiSummaryCard.jsx`, then register it in your
`hsproject.json` extension config like any other UI extension card.

## Pointing at your relay

Replace the `RELAY_URL` constant at the top of `AiSummaryCard.jsx` with
your deployed relay's URL. The relay is the example in
`../worker-llm/`; deploy it with `wrangler deploy` and use that URL.
