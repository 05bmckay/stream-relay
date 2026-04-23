# HubSpot UI extension example

A complete HubSpot developer-platform app example for a CRM card that uses
`stream-relay` to generate a resumable AI summary for the current contact.

This example follows the current HubSpot project layout used by the developer
platform:

```text
hsproject.json
src/app/stream_relay_ai_summary-hsmeta.json
src/app/cards/ai_summary_card-hsmeta.json
src/app/cards/AiSummaryCard.tsx
src/app/cards/package.json
src/app/functions/load-summary-state-hsmeta.json
src/app/functions/load-summary-state.js
src/app/functions/save-summary-state-hsmeta.json
src/app/functions/save-summary-state.js
src/app/functions/package.json
```

The React side is intentionally kept in one file (`src/app/cards/AiSummaryCard.tsx`) instead of being split into hooks/components. The only separate files are HubSpot-required metadata and app functions.

The card demonstrates:

- registering a React extension with `hubspot.extend()`
- reading HubSpot context from the extension callback
- using SDK actions such as `actions.addAlert`
- starting relay work through `hubspot.fetch()`
- polling streamed tokens with `useStream()`
- persisting `{ streamId, offset, summary }` with HubSpot app functions
- resuming from the last saved offset after a card reload
- handling relay expiry with `StreamNotFoundError`

## Configure the example

1. Replace every `https://your-relay.workers.dev` value with your deployed
   relay URL:
   - `src/app/stream_relay_ai_summary-hsmeta.json` under `permittedUrls.fetch`
   - `src/app/cards/AiSummaryCard.tsx` in `RELAY_URL`
2. Create a HubSpot private app token with contact read/write access and add it
   as the project secret `PRIVATE_APP_ACCESS_TOKEN`.
3. Create these contact properties before installing the card:

| Internal name | Type | Field type |
| --- | --- | --- |
| `ai_summary_stream_id` | Single-line text | Text |
| `ai_summary_stream_offset` | Number | Number |
| `ai_summary_text` | Multi-line text | Multi-line text |

## Install dependencies

HubSpot card and function dependencies are installed in their own app folders:

```sh
cd examples/hubspot-extension/src/app/cards
npm install

cd ../functions
npm install
```

If you copy this into a separate HubSpot project instead of running it from this
repository, change the card dependency from the local file reference to the npm
package:

```json
"stream-relay": "latest"
```

or run:

```sh
npm install stream-relay react @hubspot/ui-extensions
```

## Develop and deploy

From `examples/hubspot-extension`, use the HubSpot CLI for the app/project
lifecycle. From the card package you can run the UI extension dev server:

```sh
cd src/app/cards
npm run dev
```

The relay server itself is not part of the HubSpot app. Use
`examples/worker-llm/` as the relay backend, deploy it with `wrangler deploy`,
and point this HubSpot app at that URL.
