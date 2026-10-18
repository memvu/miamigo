# Mi Amigo

Local iMessage planning and bill-splitting assistant, using Backboard for classification and tool selection.
Run on the Mac signed into the bot's Messages account.

## Start

```sh
bun install
bun run list-chats
bun run setup
bun start --check
bun start
```

Set `BACKBOARD_API_KEY`, `BACKBOARD_LLM_PROVIDER`, `BACKBOARD_MODEL`, and `ALLOWED_CHAT_IDS` in `.env` before setup.
Copy complete group IDs from `list-chats`; separate multiple IDs with commas.
`setup` creates the classifier and planner template and saves their IDs without printing your API key.
Run setup once, not before every start.
See `.env.example` for optional settings.
The old `IMESSAGE_CHAT_IDS` setting is replaced by `ALLOWED_CHAT_IDS`.

Grant the terminal Full Disk Access and allow Messages Automation when macOS prompts on the first send.
Keep the Mac awake, logged in, and connected, with Messages open.
Stop an older listener with Ctrl+C before starting this version.
Only another participant's messages trigger the bot; the hosting account's outgoing messages are ignored.
`--check` starts and stops the native watcher without forwarding or sending messages; it does not prove outbound Automation permission.

## Demo

Start with these messages from another account in the selected group:

```text
/help
/plan Dinner | dinner | Cafe
/poll Which day? | Friday | Saturday | closes tomorrow at 9pm
1
/status
/split 50
/owe
paid
```

`/plan`, structured `/poll`, `/remind tomorrow at 6pm`, `/status`, `/cancel`, `/help`, `/split`, `/paid [name]`, `/owe`, `/settle`, `/forgive name`, `/quiet`, and `/loud` work locally.
Use `@amigo ...` or `amigo, ...` for natural-language requests through Backboard.
Only the payer can settle a bill, forgive a share, or report someone else's payment.
The bot records reported payments; it never moves money.

For passive planning, set `PASSIVE_MODE=live`.
Ordinary banter is buffered but does not itself trigger an API call.
Relevant conversations are classified after a 45-second lull or eight new messages; proactive replies still wait for a lull.
`PASSIVE_MODE=shadow` logs decisions and updates state without passive replies.
Explicit commands still work in shadow mode.

Planning responses are fixed templates, not model-authored free text.
Polls are text-based and accept numbers, `none`, and `all`.
A concrete proposal must be delivered before confirmation or the ten-minute no-objection window can lock it.
Locked plans schedule day-before and hour-before reminders when those times are still in the future.
Unpaid shares receive at most two payback nudges, at roughly 24 hours and three days.
Quiet mode pauses unsolicited output for 24 hours; `/loud` resumes it.

## Logs, state, and failures

Every selected incoming event prints an `[iMessage]` JSON line with timestamp, chat, sender, type, and text before model processing.
Backboard calls log status and duration, without API keys.
A provider failure stays silent in passive mode; an explicit AI request gets a short failure response.
Local commands and votes continue working during an API outage.
There is no automatic model fallback.

SQLite state lives in `.data/miamigo.db` by default.
Each chat has its own planner assistant/thread and isolated Backboard memory.
Raw buffered messages and classifier logs are pruned after seven days.
Terminal history and redirected stdout are not auto-pruned: they contain conversation text and must be handled as private data.
`/forget` deletes that chat's local state and remote AI memory, but cannot erase terminal captures.
Tell group participants the bot reads the selected chat and sends gated context to Backboard.

Optional `contacts.json` maps actual participant handles to display names and payment handles:

```json
{
  "+15555550123": { "name": "Alex", "venmo": "alex-example" }
}
```

Payment links appear only when configured.
Both `.env` and `contacts.json` are ignored by version control.

Native sends are spaced at least five seconds apart and capped at 30 per hour per chat.
The pinned imessage-kit dependency has a small Bun patch disabling hidden AppleScript retries, so one failed dispatch cannot bypass those limits or silently duplicate a send.
The watcher also checks its message cursor every second, because filesystem notifications can miss SQLite WAL writes on macOS.
Restart after updating, then send a new message; startup intentionally does not replay older messages.
Uncertain in-flight sends are not replayed after restart.

## Checks

```sh
bun run typecheck
bun test
bun start --check
bun run eval
```

`eval` sends synthetic cases to the configured Backboard classifier and reports its results; it requires working API access and incurs model calls.
Tests use synthetic data and never send real iMessages.
A real participant-to-bot round trip still requires testing in the selected group with outbound Messages permission.
