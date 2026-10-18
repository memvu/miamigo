# Local iMessage and Backboard listener

## Outcome
Run a Bun application that receives selected iMessage chats, requests a context-aware Backboard decision, and sends useful text replies to the original chat.

## Scope
In scope: local provider, text messages, relevance decisions, persistent per-chat threads, environment configuration, and graceful shutdown.
Out of scope: native polls, payments, scheduled nudges, calendar actions, deployment daemons, and cloud Photon credentials.

## Current Architecture
The parent package.json already installs spectrum-ts, @spectrum-ts/imessage-local, and backboard-sdk.
The parent .env supplies Backboard credentials and model settings.
There is no application entry point.

```mermaid
flowchart LR
  P[package.json] --> S[spectrum-ts]
  P --> I[@spectrum-ts/imessage-local]
  P --> B[backboard-sdk]
```

## Proposed Architecture
The new application files below are proposed additions.
Use one sequential message loop to preserve ordering.
Use Bun SQLite to retain chat-to-thread mappings across restarts.
Disable assistant-wide memory to keep chat contexts separate.
Require IMESSAGE_CHAT_IDS before receiving and forwarding messages.
Use a structured reply-or-silence decision instead of a keyword filter that loses contextual replies.

```mermaid
flowchart LR
  M[macOS Messages] --> I[@spectrum-ts/imessage-local]
  I --> R[src/index.ts: selected inbound text]
  R --> B[src/backboard.ts]
  B <--> D[.data/backboard.sqlite]
  B <--> A[Backboard sendMessage]
  B --> Q{Reply or silence}
  Q -->|reply| R
  R -->|space.send| I
  Q -->|silence| X[No outgoing message]
  A -->|failure| E[Report locally; send nothing]
```

## Implementation Steps
1. Add the Backboard adapter and validate structured model output before sending text.
2. Add the local provider entry point, selected chat filter, environment handling, and shutdown.
3. Add Bun scripts and ignore local dependencies and thread state.
4. Exercise the real Backboard API with synthetic messages and start and stop the actual local provider.

## Risks and Tradeoffs
Every selected text message reaches Backboard so relevance decisions can use context.
Ordinary conversation receives no reply but still incurs an API request.
Messages from the host account are excluded by the provider's incoming-message watcher.
A global sequential loop is simple but delays other selected chats during a slow request.
Invalid API credentials, unavailable models, and macOS permissions are runtime prerequisites, not reasons to fabricate responses.
No live iMessage is sent during verification without a selected destination.

## Open Questions
Which chat should receive replies?
The application requires an explicit allowlist and the README explains how to obtain chat GUIDs locally.
The unused NUDGE_AFTER_MIN and DEBOUNCE_MS settings do not enable features outside this listener task.

## Verification
Check type safety and reply-or-silence parsing boundaries.
Use synthetic planning and banter inputs against the configured Backboard model.
Verify persisted thread reuse and separate threads for different synthetic chat IDs.
Start and stop the installed local provider without forwarding personal messages or sending an unsolicited iMessage.
Document any blocked external check exactly.
