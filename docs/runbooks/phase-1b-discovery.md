# Runbook: scheduled discovery, tracker and notifications

This covers Phase 1B only. There is no browser automation, no form filling and no submission
anywhere in this system. Every step below reads public job adverts or your own local records.

Secrets stay on this machine. Nothing in this runbook asks you to paste a token, password, CV or
profile value into a chat, and you should never do so.

---

## 1. Start it locally

```text
pnpm install --package-import-method=copy
pnpm setup:local          # once; writes the ignored .env with fresh local secrets
pnpm db:migrate
pnpm api
```

Open `http://127.0.0.1:3210/tracker`. You need two things from your own machine:

- **Profile admin token** — the `PROFILE_ADMIN_TOKEN` line in `.env`. Treat it like a password.
- **Profile ID** — the ID shown when you created your profile at `/onboarding`.

The page keeps both in the open tab's memory only. They are not saved in the browser.

---

## 2. Shortlist-quality review

The exit gate asks you to confirm the shortlist is actually useful. Do it in two passes.

### 2z. Re-score first, or you will judge a stale decision

Do this before anything else in this section. A tracker row shows the decision of the match run that
last scored it, and that run can predate the current matcher by several releases. On 2026-09-29 the
local database held ten adverts still scored by `shadow-1.3.0` and forty-five by `shadow-1.5.0`
while the matcher was `shadow-1.6.0` — so the tracker reported "no requirements read" for adverts
that had 65,000 characters of criteria text stored against them and ninety extracted requirement
rows. Judging that would have been judging work the agent had already done but never applied.

Start the API, open `/tracker`, and choose **Score anything new**. Since the re-score-on-matcher-change
fix, that picks up every job whose last decision came from a different matcher, not only newly
discovered ones. Then confirm with:

```text
pnpm shortlist:report
```

Every advert should now sit under a heading that matches what you would expect, and the
"requirements read" total at the bottom should be far above zero.

### 2y. Judge the grouping, not the score

The tracker groups vacancies by how much of the advert the agent could actually check, and the score
is now a secondary pill rather than the headline. That change was made because the score did not
separate anything: across ten real adverts it sat in a 17-point band, and every rejection was a hard
gate rather than a score. The bands are:

| Group                        | What it means                                                              |
| ---------------------------- | -------------------------------------------------------------------------- |
| Checked against your profile | Every requirement the advert states was judged either way.                 |
| Partly checked               | Some judged, some not. Read the ones it could not judge.                   |
| Yours to judge               | Requirements were read and none could be judged. The agent has no opinion. |
| Requirements never read      | Nothing was established at all. Open the advert.                           |
| Blocked                      | A hard gate failed. Nothing in your profile changes it.                    |

None of those boundaries is a tunable number: each is decided by whether a count is zero. So there is
nothing to tune here, and the question for the gate is simply whether the groups put the right
vacancies in front of you.

### 2a. The synthetic corpus

```text
pnpm shadow:corpus
```

This prints the decision for nine invented adverts covering a strong match, an unrelated role, a
salary below your floor, a negotiable salary, a range straddling the floor, hourly pay, a missing
mandatory licence, a closed vacancy, and one your own exclusion rule rules out. For each, check:

- Does the recommended action match what you would have decided?
- Is the salary result right — `pass` only when the bottom of the range clears £25,000?
- Does anything the advert requires that your profile cannot evidence show as needing your review,
  rather than being treated as met?

Write down every case where you disagree. Do not tune thresholds to hide a disagreement.

### 2b. Ten real adverts

1. On `/tracker`, paste a public MyJobScotland vacancy link into **Add a vacancy link** and choose
   **Add and check it**. The agent reads the advert, scores it against your approved profile and
   shows the decision straight away, under the box.
2. Repeat for about ten adverts: some you would apply for, some you would not, and at least one with
   a vague or missing salary.
3. For each, open **Why this decision** in the list and check the reasons and the essential
   requirements it could not confirm.
4. Record how many of the ten you agree with. The architecture's target is agreement on at least
   90% of a representative sample before any later phase.

Known behaviour to judge for yourself: a role that suits you but carries a requirement your profile
cannot evidence (a PVG membership, a driving licence) can score below the shortlist threshold and be
auto-rejected rather than surfaced. If that costs you roles you would have wanted, say so — the fix
is a configuration decision about scoring weights or the shortlist threshold, not a code change to
make quietly.

### Criteria in a linked document

Many MyJobScotland adverts carry only a summary on the page and put the person specification in a
downloadable document. The agent now reads that document when the advert links one. Check the
**Criteria seen** column in `pnpm review:real-adverts`, and on `/tracker` check whether the essential
requirements shown look like the real person specification rather than a summary.

Three outcomes are possible, and they mean different things:

- **read** — the criteria were fetched, scanned and extracted. The essentials you see are the real
  ones. Requirements your profile cannot evidence are listed for your review.
- **absent** — the advert linked no document. The page text is all there is.
- **unreadable** — the advert linked something the agent could not safely read. It says so, blocks
  anything automatic, and **keeps the role on your shortlist rather than rejecting it**, because the
  score was worked out without criteria it knows it missed. Expect to look at these yourself.

One thing to judge deliberately: because reading the criteria removes a default coverage allowance,
an advert whose document is read can score lower than an otherwise identical advert whose document is
not. `pnpm review:real-adverts` prints a worked demonstration at the end. If the drop looks wrong to
you, that is a threshold decision to take through versioned configuration, not something to tune
quietly.

---

## 3. Turn scheduled discovery on

Scheduled discovery is off until you deliberately switch it on, and it refuses to run while
anything is misconfigured.

1. Put your profile ID in `.env` as `AGENT_USER_ID`, and set `DISCOVERY_SCHEDULER_ENABLED=true`.
2. Add vacancy links on `/tracker` (they are saved to the `myjobscotland_manual` source).
3. Switch the source on: `POST /v1/sources/myjobscotland_manual/enabled` with `{"enabled":true}`.
   This is refused, with a reason you can read, unless all of the following hold:
   - a reviewed site policy exists for the domain;
   - that review has not expired;
   - its terms permit the action this source performs (page reads, or feed polling);
   - this project contains a purpose-written reader for the domain.
4. Restart `pnpm api`.

Open `/tracker` and choose **Show my jobs**. The panel under the buttons says whether scheduled
searching is ready, or lists exactly what is stopping it — an invalid `AGENT_USER_ID`, a profile
that is not finished, no source switched on, or a source whose site policy has since expired. While
anything is listed there, the scheduler stays idle: it re-checks on each tick and attempts no
network work, so a bad configuration does not produce repeated failures. Fixing the profile or a
source takes effect at the next tick without a restart; fixing `AGENT_USER_ID` needs a restart
because it is read from `.env`.

Polling never runs more often than every 15 minutes per source and honours the reviewed rate limit.

---

## 4. Add a new source

A source cannot be created or switched on unless every check in step 3 passes. A feed source also
needs an explicit, documented feed address — the agent never looks for one, and refuses a feed
source that has none. If any check fails the source stays off and the refusal is recorded in the
audit log.

---

## 5. Pause everything

- Tracker page: **Pause the agent**.
- API: `POST /v1/agent/pause`.
- Discord: `/agent pause`.

While paused, no source is polled, no notification is delivered, and scheduled ticks do nothing.
`GET /health` and `GET /v1/agent/status` both report the paused state.

---

## 6. Discord: set up the bot

Discord stays completely inert until these five values exist in `.env`. Until then the code is
present but sends nothing and accepts nothing.

| `.env` name               | Where it comes from                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID`  | Discord Developer Portal → your application → General Information                                          |
| `DISCORD_PUBLIC_KEY`      | Same page, "Public Key"                                                                                    |
| `DISCORD_BOT_TOKEN`       | Same application → Bot → Reset Token                                                                       |
| `DISCORD_ALLOWED_USER_ID` | Your own Discord user ID (Settings → Advanced → Developer Mode, then right-click your name → Copy User ID) |
| `DISCORD_CHANNEL_ID`      | Right-click the private channel you want → Copy Channel ID                                                 |

Steps:

1. At <https://discord.com/developers/applications>, create an application. Under **Bot**, create the
   bot and reset the token once. Copy the token straight into `.env` on this machine.
2. Make a private server, or a private channel in one you own, that only you can read.
3. Invite the bot with the **bot** and **applications.commands** scopes and permission to send
   messages in that channel only.
4. Paste the five values into `.env`. Do not paste any of them into a chat, a commit, or a note.
5. Also set `AGENT_USER_ID` to your agent profile ID. Slash commands stay disabled without it,
   even when all five Discord values are present.
6. Restart `pnpm api`. Check `GET /health`: `notificationsConfigured` should now be `true`.

Then check the values without starting the service, and without exposing anything:

```text
pnpm discord:check
```

It reports which variables are set (never their values), confirms the bot token identifies a bot,
confirms the channel is reachable and is in a server rather than a direct message, and says whether
you are currently inside quiet hours. `pnpm discord:check --send` additionally posts one harmless
test message.

Quiet hours default to 22:00–07:00 Europe/London (`QUIET_HOURS_START` / `QUIET_HOURS_END`). Nothing
is sent during them; queued messages wait.

### 6a. Register the slash commands

```text
pnpm discord:register
```

The command list lives in `scripts/discord-commands.mjs`. Registration is **guild-scoped**: the
guild is resolved from `DISCORD_CHANNEL_ID`, so the commands exist only in your private server and
appear immediately. Global commands are deliberately not used — they would be visible in every
server the application is ever added to. `pnpm discord:register --list` shows what is registered
and `--clear` removes it all.

Registering commands changes nothing about what the agent can do. The command surface is read and
workflow-intent only; `/job apply` always refuses, and the application commands reach the local
fake ATS and nothing else.

### 6b. The interaction endpoint, and why notifications do not need one

These are two separate directions, with very different exposure:

| Direction                    | How it works                                       | Needs inbound access? |
| ---------------------------- | -------------------------------------------------- | --------------------- |
| Agent → you (notifications)  | Outbound HTTPS to `discord.com` with the bot token | **No**                |
| You → agent (slash commands) | Discord POSTs to an Interactions Endpoint URL      | **Yes, public HTTPS** |

Discord's HTTP interactions model, which this implementation uses, requires a publicly reachable
HTTPS URL that Discord can POST to. It will not call a loopback address, and it verifies the URL by
sending a signed PING before it will save it. There is no offline or localhost option for this
model. `POST /v1/discord/interactions` verifies the Ed25519 signature against
`DISCORD_PUBLIC_KEY` and rejects a timestamp more than five minutes old, so an unsigned or stale
request is refused — but that check only runs on requests that reach the service, and the service
binds to `127.0.0.1` only.

So: **step 7 below needs no tunnel at all.** Do it first, on its own. Only steps 8 and 9, which
exercise commands, need the endpoint.

When you get there, the options, safest first:

1. **A tunnel you start by hand, only while testing, and stop afterwards** (`cloudflared tunnel
--url http://127.0.0.1:3210`, or ngrok). One ephemeral hostname, alive for minutes, torn down
   when the checks are done. This is the recommended option.
2. **A small always-on relay** you own, forwarding only `/v1/discord/interactions`. More moving
   parts and a permanent public surface; not worth it for a personal agent.
3. **Deploying the control plane publicly.** Out of scope, and contrary to the loopback-only design.

Whichever you use, while the tunnel is up the whole control plane is reachable, not just the
interactions path. `PROFILE_ADMIN_TOKEN` is what stands between the tunnel and the profile routes,
so it must be a strong value before you open one. Treat the tunnel as a supervised, time-boxed
window: start it, run the checks, stop it, and clear the Interactions Endpoint URL in the portal
afterwards so a stale hostname is not left configured.

**Do not create a tunnel without deciding this deliberately.** Nothing in the repository opens one.

---

## 7. Confirm one live notification

This needs no interaction endpoint and no tunnel: it is outbound only.

1. Make sure the agent is not paused and the clock is outside quiet hours.
2. Add a vacancy link on `/tracker` that you expect to be shortlisted, or use
   `POST /v1/match/run` to score anything waiting.
3. A single message should appear in your channel: role, employer, location, score, salary
   certainty, how many essential requirements need your review, and a line stating that nothing was
   applied for.
4. Score the same advert again. **No second message should appear** — each decision has one delivery
   key. If a duplicate arrives, stop and report it; that breaks the exit gate.
5. Check `GET /v1/agent/status`: `pendingNotifications` should be 0 and
   `undeliverableNotifications` empty.

---

## 8. Confirm a different Discord user is refused

You need a second Discord account, or a friend in the same private server.

1. Complete step 6a (command registration) and 6b (interaction endpoint), then have the other
   account run `/agent status` in the channel.
2. The reply should be, only to them: _"This job agent only takes commands from its owner."_
3. Confirm nothing changed: run `/agent status` yourself, and check `/tracker` — no status moved and
   no message was sent.

If you do not have a second account, you can prove the same control by temporarily setting
`DISCORD_ALLOWED_USER_ID` to a different number in `.env`, restarting, running `/agent status`
yourself, seeing the refusal, then restoring your own ID and restarting. Record which method you
used.

---

## 9. Confirm a replayed command is harmless

Discord's own retries already exercise this, but prove it deliberately:

1. Run `/job reject id:<the first eight characters of a job id from /jobs list>`.
2. Note the reply and check the tracker shows that job as rejected.
3. Ask Discord to resend the same interaction — the simplest way is to trigger the command again
   while the service is briefly stopped, so Discord retries delivery when it returns.
4. The second delivery should answer _"That command was already handled. Nothing was repeated."_
   The tracker should be unchanged, with a single history entry for the rejection.

`/job apply <id>` should always answer that applying is not enabled. Confirm that too.

---

## 10. When something fails

- `GET /v1/agent/status` lists recent runs, per-source failures, the open-circuit time, scheduler
  readiness problems, pending notifications and anything that could not be delivered.
- A source that fails four times in a row opens its circuit for an hour and sends one notification.
- A notification rejected permanently, or out of attempts, is dead-lettered and listed rather than
  retried forever.
- Logs are structured and redacted: tokens and anything under a secret-looking key never reach the
  log sink.

---

## 11. Record Phase 1B sign-off

When steps 2 and 7–9 are done, fill this in and paste it into `CLAUDE.md` under the status table.
Do not include any token, profile value or personal data.

```text
Phase 1B sign-off
Date:                      YYYY-MM-DD
Test command / result:     pnpm check — NNN tests passing
Migration version:         0005_advert_attachment_criteria.sql
Shadow corpus reviewed:    yes / no      disagreements: N of 10
Real adverts reviewed:     N adverts     agreed with decision: N of N
Criteria documents read:   N of N adverts that link one
Unreadable criteria kept visible rather than rejected: yes / no
One live Discord message:  yes / no      duplicate on re-score: yes / no
Other Discord user refused: yes / no     method: second account / temporary ID swap
Replayed command harmless: yes / no
Still no browser automation or submission: confirmed
Outstanding disagreements or follow-ups:
  -
Approved to begin Phase 2: yes / no
```

Phase 2 must not start until that block says yes.
