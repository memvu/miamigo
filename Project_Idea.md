# Mi Amigo - Group chat assistant to help the plan get out of the group chat.

- Personal AI assistant on iMessage that automatically responds to group messages about planning a hangout.
- Creates polls for available dates or decisions, mentions people, and sends reminders before events.
- After the hangout, splits the bill ("bill was $50 total" → $ per person) and reminds people to pay back whoever paid.

## 1. Architecture

```
                         ( dedicated Apple ID signed into Messages on the Mac )
┌──────────────┐   iMessage   ┌──────────────────────── Mac (localhost) ─────────────────────────┐
│ iMessage GC  │ ───────────▶ │ chat.db ──▶ Photon imessage-kit watcher (onGroupMessage)         │
│ (friends +   │              │                    │                                             │
│  Mi Amigo)   │ ◀─────────── │   AppleScript ◀── sdk.send({ to: chatId })                       │
└──────────────┘              │                    │                                             │
                              │        ┌───────────▼───────────┐     ┌──────────────────────┐    │
                              │        │ Mi Amigo app (TS/Bun) │ ◀─▶ │ SQLite state          │    │
                              │        │ trigger → router →    │     │ (plans, polls, votes, │    │
                              │        │ tools → reply format  │     │  reminders)           │    │
                              │        └───────────┬───────────┘     └──────────────────────┘    │
                              └────────────────────┼─────────────────────────────────────────────┘
                                                   │ HTTPS (backboard-sdk)
                                       ┌───────────▼───────────┐
                                       │ Backboard             │
                                       │ assistant + thread per│
                                       │ GC, memory = "Auto",  │
                                       │ tool calling          │
                                       └───────────────────────┘
```

Everything except the LLM runs on the Mac. The Mac must stay awake, logged in, with Messages.app open.

## 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Bun (TypeScript) | imessage-kit runs on Bun with no extra deps (Node needs `better-sqlite3`) |
| iMessage I/O | `@photon-ai/imessage-kit` | Reads `~/Library/Messages/chat.db`, sends with AppleScript. Needs **Full Disk Access** for the terminal/Bun. |
| LLM + memory | `backboard-sdk` (Backboard.io) | One assistant, one thread per group chat, `memory: "Auto"` to remember people's preferences |
| Local state | `bun:sqlite` (`miamigo.db`) | Polls, votes, plans, and reminders. This is the source of truth, not the LLM. |
| Scheduler | `setInterval` tick (every 30s) on top of the reminders table | Survives restarts because reminders are stored in the DB |
| Config | `.env` | `BACKBOARD_API_KEY`, `BACKBOARD_ASSISTANT_ID`, `ALLOWED_CHAT_IDS`, `BOT_NAME=amigo` |

> If you later need threaded replies or tapbacks sent *by* the bot, Photon's `@photon-ai/advanced-imessage` (gRPC server) covers that. The basic kit is enough for this MVP.

## 3. Passive Planning Mode (core feature)

Nobody has to summon Mi Amigo. It quietly reads the group chat, notices when a hangout is being discussed, keeps track of who said what, and steps in **only when it can move the plan forward**, for example when the chat is stalling or going in circles. Mentions and slash commands are secondary overrides.

### 3.1 Pipeline

```
every incoming GC message
   │
   ▼
① buffer ─ append to `messages` table (always, no LLM)
   │
   ▼
② cheap gate ─ local regex/keyword score > 0  OR  an active plan exists in this chat?
   │ no → stop (still buffered)
   ▼
③ debounce ─ wait for a lull: 45s with no new message, or 8 new messages, whichever comes first
   │        (planning happens across many messages, so judge the whole burst, not one line)
   ▼
④ classify (LLM, small/cheap model, memory off) on the last ~20 messages + plan state
   → JSON { is_planning, confidence, stage, extracted, should_speak, reason }
   │
   ├─ update plan state silently (always, if is_planning)
   ▼
⑤ speak? ─ should_speak && confidence ≥ 0.7 && guardrails pass (3.4)
   │ no → stay silent
   ▼
⑥ act (main Backboard assistant, memory Auto, tool calling) → templated reply (section 4)
```

### 3.2 Plan stages it tracks

| Stage | What it looks like in chat | What Mi Amigo does |
|---|---|---|
| `idea` | "we should hang soon", "anyone down for food" | Silent. Creates a `draft` plan once 2+ people show interest. |
| `gathering` | "yesss", "I'm down", "depends when" | Tracks who's in. Speaks only if the plan is stalling (no concrete proposal after ~10 msgs or 20 min): kickoff (4.1) + a poll (4.2). |
| `choosing_time` | "fri?", "I can't sat", "sunday works" | **Silently records availability from natural language** ("fri works for me" counts as a vote for Fri). Posts a tally (4.3) when 2+ conflicting options are on the table or when most people have weighed in. |
| `choosing_place` | "pho or kbbq", "somewhere near campus" | Same pattern: collects options, offers a poll when there are 3+ suggestions or the debate lasts more than ~8 messages. |
| `ready_to_lock` | time + place both have a clear majority | Proposes the lock (4.4). If nobody objects within ~10 min (or someone says "bet", "yes", or 👍), it locks and schedules reminders. |
| `locked` | n/a | Silent until reminders. Re-opens if someone says "wait can we move it". |

### 3.3 Silent extraction is the main value

Most of the time the bot **doesn't post anything**. The classifier's `extracted` field updates state on every evaluated burst:
```json
{ "interested": ["Alex","Jess"], "availability": {"Jess": {"yes":["Fri"],"no":["Sat"]}},
  "time_options": ["Fri evening","Sun brunch"], "place_options": ["Pho Bac"], "activity": "dinner" }
```
So when the bot does speak, its message already reflects everything people said, like "Fri: 4 yes · Sat: 1 yes, 2 can't", without anyone formally voting.

### 3.4 Guardrails against being annoying

- **Proactive budget**: at most 1 unprompted message per stage change, and at most 4 per chat per day.
- **Don't interrupt**: only speak after a lull (the debounce in step ③). Never speak mid-burst.
- **Value check**: the classifier must give a `reason` that names the stall or conflict (for example "3 time options, no convergence for 15 msgs"). If it can't, the bot doesn't speak.
- **Back-off**: if someone replies "amigo shh" or "stop", or nobody engages with the bot's last 2 proactive messages, it goes quiet in that chat for 24h. `/quiet` and `/loud` toggle this manually.
- **Confidence floor**: anything below 0.7 means track silently, never post.

### 3.5 Bill split & payback reminders

After the hangout, someone usually pays and says "bill was $50 total" in the GC. Mi Amigo turns that into a split and makes sure people pay the payer back.

**Detection (passive).** The local gate also fires on a dollar amount (`\$?\d+(\.\d{1,2})?`) next to a bill word (`bill|total|check|tab|came out to|split|owe|venmo|zelle`). The classifier returns an extra field:
```json
"bill": { "is_shared_expense": true, "total": 50.00, "payer": "Minh",
          "includes_tip": "unknown", "split_hint": null, "confidence": 0.9 }
```
Lines like "this jacket was $50" get `is_shared_expense: false` and are ignored. A detected bill **skips the per-stage budget** (it's high-value), but still needs confidence ≥ 0.8 and a lull.

**Who splits it**, in priority order:
1. An explicit hint in the message: "split 4 ways", "me, Alex and Jess", or "Sam didn't come".
2. If the bill comes within ~6h after a **locked plan**, the plan's "Going" list.
3. Otherwise **everyone in the GC** (participant count, including the payer).

**Math.**
- `share = round(total / N, 2)`. Leftover cents go to the first non-payer people in the list, so the shares always add up to the exact total.
- The payer owes nothing. Everyone else owes their share **to the payer**.
- If `includes_tip` is `"no"` ("$50 before tip"), the bot asks once whether to add 18%, 20%, or an amount (template 4.7). If it's `"unknown"`, it splits the number as given.
- Uneven corrections ("I only got a drink, I owe $8") make that person's share fixed, and the rest is re-split among the others.

**Tracking payment.** Each share is marked paid when:
- The person says "paid", "sent", "venmo'd you", or similar (detected by the classifier, `bill.paid_by`).
- The person tapbacks 👍 or ‼️ on the split message.
- The payer says "Alex paid me" or `/paid Alex`.

**Reminders.** The scheduler sends payback nudges **only to people who still owe**: +24h, then +3 days, then it stops (at most 2 nudges). The payer can `/settle` to close the bill or `/forgive Sam` for one person. All shares paid → a one-line ✅ "all settled" message.

### 3.6 Explicit triggers (secondary)

These skip the gate and the debounce and go straight to step ⑥:
1. **Mention**: `@amigo` / `amigo,` (case-insensitive).
2. **Slash command**: `/plan`, `/poll`, `/status`, `/remind`, `/cancel`, `/quiet`, `/loud`, `/forget`, `/help`, plus bills: `/split 50 [4 ways]`, `/paid [name]`, `/owe` (who owes whom), `/settle`.
3. **Poll reply**: a message that is only numbers (`1`, `2 3`) while a poll is open. This is recorded locally with **no LLM call**.

Always ignore: `isFromMe` messages (the bot's own), reactions (`excludeReactions`, except tapbacks on a lock proposal), and chats not in `ALLOWED_CHAT_IDS`.

## 4. Response Patterns (the "specific patterns")

The LLM never sends free-form text. It must call a tool, and the app renders that tool's result with a fixed template. This keeps replies short, scannable, and consistent in iMessage.

### 4.1 Plan kickoff (`start_plan`)
```
📍 New plan: Dinner this weekend
What: dinner  •  Where: TBD  •  When: TBD
Next step: vote on a day 👇
```

### 4.2 Poll (`create_poll`)
```
🗳️ POLL #3: Which day works?
1) Fri 10/24 evening
2) Sat 10/25 afternoon
3) Sun 10/26 brunch
Reply with the number(s) you can do, e.g. "1 3". Closes Thu 9pm.
```
iMessage polls can't be created through AppleScript, so polls are text-based. The vote parser accepts `1`, `1 3`, `1,3`, `none`, and `all`.

### 4.3 Poll tally (`get_poll_status`, or automatically after each vote, throttled)
```
🗳️ POLL #3 so far (4/6 voted)
1) Fri ▓▓▓▓ 4  ← leading
2) Sat ▓▓ 2
3) Sun ▓ 1
Still waiting on: @Minh, @Jess
```

### 4.4 Decision lock (`finalize_plan`)
```
✅ LOCKED IN: Dinner @ Pho Bac
🗓️ Fri 10/24, 7:00 PM
👥 Going: Minh, Jess, Alex, Sam
I'll remind everyone the day before and 1 hour before.
```

### 4.5 Nudge / mention (`nudge`)
```
👋 @Jess @Sam, we just need your votes for POLL #3 to lock this in!
```
iMessage has no real @mention API in the basic kit, so mentions are plain text with contact names taken from the plan's participant list.

### 4.6 Reminder (sent by the scheduler, no LLM)
```
⏰ Reminder: Dinner @ Pho Bac is TOMORROW, Fri 7:00 PM.
```

### 4.7 Clarifying question (`ask_clarify`)
Use this when key details are missing. Ask at most **one** question, with options:
```
🤔 Quick q: is this a dinner or a daytime thing?
1) Dinner  2) Daytime  3) Either
```

### 4.8 Bill split (`split_bill`)
```
💸 Bill split: $50.00 total, 4 people → $12.50 each
Pay back @Minh: Alex, Jess, Sam
Venmo: venmo.com/minh-b · reply "paid" when done
(wrong total or people? reply "amigo fix")
```
The Venmo/Zelle line only appears if the payer has a handle in `contacts.json`.

### 4.9 Balances (`get_balances`, `/owe`)
```
💸 Pho Bac bill ($50.00) — 2/3 paid
✅ Alex  ✅ Jess  ⏳ Sam owes Minh $12.50
```

### 4.10 Payback reminder (sent by the scheduler, no LLM)
```
💸 Friendly reminder: @Sam still owes @Minh $12.50 for Pho Bac 🍜
```

### Style rules (in the system prompt)
- 4 lines or fewer, except for polls and tallies. Emoji header on line 1.
- Never invent times, places, or attendees. Pull them only from the chat or from tool results.
- Dates must be absolute (`Fri 10/24`), resolved in the GC's timezone (`TZ` in `.env`).
- Money: the LLM only extracts `total`, the people, and tip info. **The app does all the arithmetic**, so amounts are always computed locally and never written by the model.
- If the group is just chatting and not planning, call `no_reply`.

## 5. Backboard Setup

**Two assistants** are created once by `scripts/setup-assistant.ts`, and their IDs are saved to `.env`.

**Classifier assistant** (`BACKBOARD_CLASSIFIER_ID`): this runs often, so it needs to be cheap and fast.
- Small model, `memory: "off"`, no tools, and a JSON-only output contract (the schema in 3.1 step ④).
- Stateless. A new short thread per call (or one reused thread that gets reset) so old bursts don't leak into new ones. All state comes from the context block.
- Few-shot examples in the system prompt: banter, then a planning start, then a stall, then convergence, with the right `should_speak` for each.

**Planner assistant** (`BACKBOARD_ASSISTANT_ID`): this runs only when the bot is about to speak.
- `system_prompt`: persona, the style rules above, the current date and timezone, and "always respond by calling exactly one tool".
- `tools`: `start_plan`, `create_poll`, `get_poll_status`, `finalize_plan`, `nudge`, `schedule_reminder`, `ask_clarify`, `split_bill`, `mark_paid`, `adjust_share`, `get_balances`, `no_reply`.

The planner also gets the classifier's `stage` and `reason` in its context, so it knows *why* it was woken up.

**One planner thread per group chat.** The `chatId → threadId` mapping is stored in SQLite. Memory is assistant-level with `memory: "Auto"`, so the bot can recall facts like "Alex is vegetarian" or "Sam can't do Sundays".

**Context sent per turn.** Backboard threads keep history, but iMessage messages that didn't trigger the bot never reach the thread. Before every LLM call, the app prepends a compact context block:
```
[context]
now: 2026-10-18 Sat 14:05 PT
participants: Minh, Jess, Alex, Sam, Linh
active_plan: #2 "Dinner this weekend" (status: polling)
open_poll: #3 votes {1:4, 2:2, 3:1}, missing: Jess, Sam
recent_messages (last 15):
  Alex: anyone down for food this weekend
  Jess: yesss
  ...
[new message] Minh: @amigo set up a poll for fri/sat/sun
```

**Tool loop** (based on the Backboard SDK docs):
```ts
let res = await bb.sendMessage({ threadId, content, tools, memory: "Auto" });
while (res.status === "REQUIRES_ACTION" && res.toolCalls) {
  const outputs = await Promise.all(res.toolCalls.map(async tc => ({
    tool_call_id: tc.id,
    output: JSON.stringify(await dispatchTool(chatId, tc.function.name, tc.function.parsedArguments)),
  })));
  res = await bb.submitToolOutputsSimple({ threadId: res.threadId, toolOutputs: outputs });
}
```
`dispatchTool` writes to SQLite **and** queues the templated iMessage. The LLM's final text output is thrown away, so only templates reach the chat.

## 6. Data Model (SQLite)

```sql
chats(chat_id TEXT PK, bb_thread_id TEXT, display_name TEXT, tz TEXT, last_bot_msg_at INTEGER,
      quiet_until INTEGER, proactive_today INTEGER, last_eval_rowid INTEGER)
participants(chat_id TEXT, handle TEXT, name TEXT, PRIMARY KEY(chat_id, handle))
plans(id INTEGER PK, chat_id TEXT, title TEXT, what TEXT, location TEXT, starts_at INTEGER,
      stage TEXT CHECK(stage IN ('idea','gathering','choosing_time','choosing_place','ready_to_lock','locked','done','cancelled')),
      extracted_json TEXT, stage_changed_at INTEGER, spoke_in_stage INTEGER DEFAULT 0)
availability(plan_id INTEGER, handle TEXT, option TEXT, answer TEXT CHECK(answer IN ('yes','no','maybe')),
      source TEXT CHECK(source IN ('chat','poll','tapback')), PRIMARY KEY(plan_id, handle, option))
classifier_log(id INTEGER PK, chat_id TEXT, at INTEGER, input_rowids TEXT, output_json TEXT, spoke INTEGER)
polls(id INTEGER PK, plan_id INTEGER, chat_id TEXT, question TEXT, options_json TEXT,
      closes_at INTEGER, status TEXT)  -- 'open' | 'closed'
votes(poll_id INTEGER, handle TEXT, choices_json TEXT, updated_at INTEGER, PRIMARY KEY(poll_id, handle))
reminders(id INTEGER PK, chat_id TEXT, plan_id INTEGER, fire_at INTEGER, text TEXT, sent INTEGER DEFAULT 0)
messages(rowid INTEGER PK, chat_id TEXT, handle TEXT, text TEXT, created_at INTEGER) -- rolling buffer for context
bills(id INTEGER PK, chat_id TEXT, plan_id INTEGER NULL, payer_handle TEXT, total_cents INTEGER,
      tip_cents INTEGER DEFAULT 0, label TEXT, split_msg_guid TEXT,  -- to match tapbacks on the split message
      status TEXT CHECK(status IN ('open','settled','cancelled')), created_at INTEGER, nudges_sent INTEGER DEFAULT 0)
bill_shares(bill_id INTEGER, handle TEXT, amount_cents INTEGER, fixed INTEGER DEFAULT 0,
      paid_at INTEGER NULL, PRIMARY KEY(bill_id, handle))
```
Money is stored as integer **cents** to avoid floating-point errors.

Participant names come from the user-editable `contacts.json`, because `chat.db` doesn't store contact names. Each entry maps a handle to `{ name, venmo?, zelle? }`.

## 7. Project Layout

```
miamigo/
├── src/
│   ├── index.ts            # boot: load env, open DB, start watcher + scheduler
│   ├── imessage.ts         # IMessageSDK wrapper: watch, send w/ rate limit, dedupe by message id
│   ├── passive/            # ★ core feature
│   │   ├── gate.ts         # keyword score + "active plan?" check
│   │   ├── debounce.ts     # per-chat lull timer / burst counter
│   │   ├── classify.ts     # classifier call → validated JSON (zod)
│   │   ├── state.ts        # merge `extracted` into plans/availability, stage transitions
│   │   └── policy.ts       # should we speak? budget, quiet, back-off, confidence
│   ├── bills/
│   │   ├── split.ts        # pure fn: (totalCents, people, fixedShares, payer) → shares (unit-tested)
│   │   ├── track.ts        # create bill, mark paid (text/tapback/payer), settle
│   │   └── links.ts        # Venmo/Zelle text from contacts.json
│   ├── explicit.ts         # mentions, slash commands, numeric poll replies
│   ├── commands.ts         # slash commands that don't need the LLM (/status, /cancel, /help)
│   ├── votes.ts            # parse "1 3" → record vote → maybe post tally
│   ├── llm/
│   │   ├── backboard.ts    # client, thread-per-chat, tool loop
│   │   ├── prompt.ts       # planner + classifier system prompts, per-turn context builder
│   │   └── tools.ts        # tool JSON schemas + dispatchTool()
│   ├── templates.ts        # the response patterns from section 4
│   ├── scheduler.ts        # event reminders, payback nudges, auto-close polls
│   ├── db.ts               # bun:sqlite schema + queries
│   └── time.ts             # natural date → absolute date in chat TZ (chrono-node)
├── scripts/
│   ├── setup-assistant.ts  # creates Backboard assistant, prints ID
│   └── list-chats.ts       # prints group chatIds to fill ALLOWED_CHAT_IDS
├── contacts.json
├── .env.example
└── package.json
```

## 8. Implementation Milestones

Passive mode is the product, so it gets built first. Explicit commands and polls are layered on later.

**M0: Mac setup (≈30 min)**
- [ ] Create a dedicated Apple ID, sign into Messages on the Mac, and add it to a test GC.
- [ ] Grant Full Disk Access to Terminal/iTerm (and Bun). Allow Automation access to Messages on the first send.
- [ ] Set System Settings → Energy so the Mac doesn't sleep.

**M1: Listener + buffer (≈1 hr)**
- [ ] `bun init`, then `bun add @photon-ai/imessage-kit backboard-sdk chrono-node zod`.
- [ ] `scripts/list-chats.ts` → pick the test GC `chatId`.
- [ ] `onGroupMessage` → write every allowlisted message to `messages`. Skip `isFromMe` and messages with no `chatId`. Smoke test: `@amigo` → `👋 heard you`.
- ✅ Done when: the GC's live messages land in SQLite and the bot can reply.

**M2: Shadow-mode classifier (≈2.5 hr)** ★
- [ ] Gate + debounce + classifier assistant, with the JSON validated by zod.
- [ ] **Shadow mode** (`PASSIVE_MODE=shadow`): log every decision to `classifier_log` and to the console, but never post.
- [ ] Build a small eval set: about 15 pasted chat snippets (banter, sarcasm like "we should hang lol never", real plans, stalls) and run them with `bun run eval`. Tune the prompt and thresholds until it has almost no false "speak" calls.
- ✅ Done when: in a live test GC, the log shows the right stage and `should_speak` for a natural planning conversation.

**M3: Silent state tracking (≈2 hr)** ★
- [ ] `state.ts`: merge `extracted` into `plans` and `availability`, resolve "fri" to an absolute date with chrono-node, and handle stage transitions.
- [ ] `/status` renders the current state (template 4.3) so the silent tracking can be checked.
- ✅ Done when: after people chat naturally ("fri works", "can't do sat"), `/status` shows the correct tally.

**M4: Speaking (≈2.5 hr)** ★
- [ ] `policy.ts`: budget, lull, value check, quiet/back-off.
- [ ] Planner assistant + tool loop + templates. Wake it when `policy` says yes (`PASSIVE_MODE=live`).
- [ ] Stall → kickoff + poll. Conflict → tally. Convergence → lock proposal, auto-lock after no objection, plus tapback/"bet" detection.
- ✅ Done when: a 3-person GC goes from "we should get food" to a locked plan **without anyone mentioning the bot**.

**M5: Explicit layer + reminders + memory (≈2 hr)**
- [ ] Mentions, slash commands, and numeric poll replies (section 3.6).
- [ ] `finalize_plan` schedules T-24h and T-1h reminders, and the scheduler sends them.
- [ ] Planner `memory: "Auto"`. Demo: "Sam can't do Sundays" is said once and remembered next week.

**M6: Bill split & payback (≈2 hr)** ★
- [ ] `bills/split.ts` as a pure function with unit tests (`bun test`): even split, leftover cents, payer excluded, fixed shares, tip.
- [ ] Gate regex for amounts + the classifier's `bill` field. `/split 50` as the explicit fallback.
- [ ] Choosing who splits: hint, then locked-plan attendees, then the whole GC. Post template 4.8 and store `split_msg_guid`.
- [ ] Mark paid from text, tapbacks, and the payer. Scheduler payback nudges (+24h, +3d). `/owe`, `/settle`.
- ✅ Done when: after the locked dinner, "bill was $50 total" → the split posts, 2 people say "paid", and the 3rd gets a reminder.

**M7: Polish & demo (≈1.5 hr)**
- [ ] Error fallback (stay silent on passive failures, `😵 brain freeze` only on explicit ones), `/help`, `/forget`, and log every LLM call.
- [ ] Demo script: show the GC chatting normally while a side terminal shows the shadow log and state updating live, then the bot steps in exactly once at the stall and once to lock. Then "bill was $50 total" → split → "paid" replies → a payback reminder. Use short reminder offsets for the demo.

## 9. Safety & Guardrails

- **Allowlist**: respond only in `ALLOWED_CHAT_IDS`, never in DMs unless they're enabled.
- **Loop protection**: ignore `isFromMe`, dedupe by message `id`, allow at most 1 bot message per 5s per chat (enforced by a plugin `onBeforeSend` hook), and cap at 30 messages per hour.
- **Passive cost control**: the local gate drops casual chat without an LLM call, and the debounce turns a 10-message burst into 1 classifier call. Rough budget: a busy GC (about 300 msgs/day) leads to about 20–40 classifier calls and 2–4 planner calls per day.
- **Privacy**: passive mode means the bot reads everything in allowlisted chats. Only gated bursts (about 20 messages) are sent to Backboard. Raw messages stay in local SQLite and are pruned after 7 days. Everyone in the GC should know the bot is there (`/help` explains this). `/forget` deletes that chat's thread and memories through the Backboard memory API.
- **Failure mode**: if Backboard errors or times out (over 15s), slash commands and votes keep working locally.
- **Money**: the bot never moves money. It only computes splits and posts reminders. Every split message says how to correct it ("amigo fix"), and payback nudges are capped at 2 per person per bill, so no one gets nagged forever.

## 10. Stretch Ideas

- Read iMessage tapbacks (`msg.reaction`) as votes: 👍 on an option message means a yes vote.
- Suggest venues using a places API tool (`search_places`).
- Export a locked plan as an `.ics` attachment (`sdk.send({ attachments: [path] })`).
- Shared calendar free/busy lookup for people who opt in.
- Receipt photo → total: read `msg.attachments` and send the image to a vision model to pull out the total and tip (and itemized splits).
- Running tab across hangouts ("Sam owes Minh $12.50, Minh owes Sam $8 → net $4.50").
