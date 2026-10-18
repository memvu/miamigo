# mi amigo — 2:30 pitch

**Roles:** Speaker tells the story. Driver runs the screen.  
**Screen:** Landing site. Demo = scroll to iMessage mock (live Photon only if the line is hot).

---

## Speak-aloud script (~2:30)

### 0:00–0:25 — Inspiration *(THE pitch)*
**[Driver: hero only — “mi amigo” / slogan. Don’t scroll.]**

Friend group chats are amazing at talking about plans and terrible at finishing them.  
“We should hang out” dies in the scroll. “I’ll pay you back” becomes one person chasing everyone.  
Nobody wants to be the nag — and nobody wants another app.

We built **mi amigo** for that gap: a Photon iMessage group agent that sits at the table like a quiet friend who actually follows through. Not Meta AI dumping essays. A neutral dealer that turns chaos into locked decisions — splits, plans, sealed whispers — and kicks long stuff out to Sheets or Docs so the chat stays human.

---

### 0:25–1:20 — What it does + demo
**[Speaker:]**  
It’s a unique phone number you add to the group. No app install. The product is the group chat.

It stays quiet during banter and only steps in when the group needs coordination.  
Hangouts become decisions — short poll, votes, lock.  
Shared expenses get split, tracked, and nudged politely.  
Whisper a private constraint and it stays sealed — the group never hears who said it.  
Person cards show picks and tab; long jobs go to a Sheet or Doc link, not a wall of text.

It succeeds when the group follows through with fewer messages — not when the bot talks more.

**[Driver: on “Watch” / “Here’s the same weekend” — scroll to the chat mock. Freeze after “$30 each to bmt”.]**

**[Speaker, pointing at chat:]**  
Wednesday — bowling this weekend, Sat or Sun. mi amigo drops a poll. Everyone picks Sat 7.  
“sat 7 we in.” You’re going.

Saturday night — dinner was $120 on bmt. “chase??”  
“$30 each to bmt.” Tab’s done. Chat’s quiet again.

Same weekend: without us it’s still open. With us, it’s closed.

---

### 1:20–1:45 — How we built it + challenges
**[Driver: stay on site or one static arch slide — no live coding.]**

We built on Photon 2.0 for a real iMessage presence, with a shared job engine for plan, split, whisper, and lock — short cards, not freeform spam. Cards render into chat; Sheets and Docs take over when a job is too fat for iMessage.

Challenges: dedicated lines for groups ate early hours. Proactive help is easy to overdo — we had to hard-rule quiet mode. Whisper had to change the deal without leaking who said it. And iMessage isn’t Discord — no slash menu, so it has to feel native in a group chat.

---

### 1:45–2:10 — Proud + learned
We’re proud of a story judges can feel in one minute: chaos → lock → settle.  
Whisper and person cards — differentiation you can screenshot, SEALED badge and all.  
And designing for Photon’s brief: agents that participate in human-to-human chat, not a web chatbot cosplay.

What we learned: on messaging platforms, silence is a feature.  
Multi-party decisions need per-person state — treating the group as one user makes mush.  
Hackathon Photon wins come from a live channel and a sharp wedge, not feature count.

---

### 2:10–2:30 — What’s next + close
Next: harden onboarding, deepen settle, calendars with consent — once core follow-through is airtight.

**mi amigo** — gettin’ out of the group chat.  
Thanks.

---

## Cue card *(print / second screen)*

| Time | Section | Speaker says (keywords) | Driver |
|------|---------|-------------------------|--------|
| 0:00 | Inspiration | plans die · chase money · no nag / no app · quiet friend · locked decisions · Sheets/Docs | **Hero only** |
| 0:25 | What it does | phone # · product = groupchat · quiet · poll/lock · split · whisper SEALED · cards · fewer messages | Hold hero |
| ~0:50 | Demo | Wed poll → sat 7 we in · Sat $120 → $30 each · same weekend closed | **Scroll to chat → freeze on $30** |
| 1:20 | Built / hard | Photon · job engine · cards · Sheets · quiet mode · whisper trust · iMessage ≠ Discord | Stay / arch slide |
| 1:45 | Proud / learned | chaos→lock→settle · SEALED · silence is a feature · sharp wedge | Stay |
| 2:10 | Next / close | onboarding · settle · calendars · “gettin’ out of the group chat” · thanks | Hero or chat |

**Cut unless asked:** surprise, voice nudges, flights, Visa, model names, full `\` command list.

**Backup:** screenshot of poll + “$30 each to bmt” if laptop dies.

**Rehearse:** Inspiration ≤25s alone; full run with timer; cut words if over 2:35.
