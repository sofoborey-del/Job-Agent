# Applying by email, from Discord

This is the first path in this project where approving something causes a real application to be
made. It is deliberately narrow: it covers only vacancies whose advert **explicitly instructs
candidates to apply by email**, and it sends one message, to the address that advert publishes,
after you have read the message in full and approved it by its review reference.

It cannot drive an employer portal, sign in anywhere, answer a CAPTCHA, tick a declaration, or apply
to any vacancy that asks for an online application. Those remain out of scope and are refused, not
worked around.

## What must be true before anything can be sent

Every one of these is checked when the message is prepared, and **checked again against freshly read
data at the moment you approve**. Any of them failing means nothing is sent.

| Gate                                      | What it means                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The advert instructs email application    | One sentence, naming one address, with no online-application instruction anywhere in the advert. A contact address "for an informal chat" is not an application route. |
| One recipient                             | Two addresses in application instructions means nobody knows which is right, so both are refused.                                                                      |
| A closing date exists, and has not passed | From the tracker record, or stated in the advert.                                                                                                                      |
| The advert is the employer's whole advert | An aggregator excerpt cannot establish an instruction.                                                                                                                 |
| No hard eligibility gate failed           | Internal-only vacancies in particular.                                                                                                                                 |
| Salary passes the £25,000 minimum         | Unless you override it explicitly for that vacancy, which is recorded in the review and in the hash you approve.                                                       |
| The profile can sign the message          | A verified name and contact address. Otherwise it refuses rather than sending an unsigned or anonymous application.                                                    |
| An approved CV exists                     | Its SHA-256 is re-verified against the bytes at the moment of sending.                                                                                                 |
| Nothing has been applied for already      | One email application per vacancy, and any existing submission record blocks it.                                                                                       |
| The day's cap has room                    | 30 per Europe/London day, shared with every other recorded application. An unconfirmed send counts.                                                                    |
| The provider is configured                | No provider, no offer of approval.                                                                                                                                     |

## What the message contains

Only things that are already true:

- a first line naming the post, the employer, the advert address and the vacancy reference if the
  advert states one;
- the name of the attached CV;
- your recorded supporting statement, word for word, **if the profile holds one** — and nothing in
  its place if it does not;
- a sign-off with your recorded name, email address and phone number.

There is no sentence anywhere that argues your case, and no sentence that agrees to anything. If the
profile holds no supporting statement the review says so plainly: only your CV speaks for you. The
agent will not write one.

The advert's own title and employer name are checked before being copied into a message you sign: an
advert carrying wording like "I confirm I hold a full driving licence" in its title is refused rather
than quoted back at the employer.

## What you must configure

Run this and follow it. It opens each page you need, names the button you are looking for, checks
what you paste back, and writes it to your local `.env` (keeping a `.env.backup`). It is resumable, so
anything already done is detected and skipped.

```bash
pnpm email:setup
```

It ends by sending one test message to an address you choose, so you see it arrive before any vacancy
is involved. Nothing reaches an employer during setup.

Then:

```bash
pnpm discord:register
```

and restart the agent so it reads the new `.env`.

### What it walks you through, if you would rather know first

1. **A Google Cloud project** — a free, private container for the credential. Nothing runs in it.
2. **Switching on the Gmail API** for that project.
3. **The consent screen** — an app name, your own address, audience "External". No verification, no
   website, no domain.
4. **Adding yourself as a test user.** This is the step people miss; skipping it makes authorisation
   fail with `access_denied`, and the script says so in those words if it happens.
5. **Creating an OAuth client of type "Desktop app".** A "Web application" client cannot do this flow.
6. **Approving the permission**, which is `https://www.googleapis.com/auth/gmail.send` and nothing
   else. It permits sending as you and grants no ability to read, list, label or delete anything in
   your mailbox. Withdraw it whenever you like at <https://myaccount.google.com/permissions>.

Google will warn that the app is not verified. That is expected: the app is yours, it is not
published, and the only permission it asks for is the one above. Choose Advanced and continue.

### The one recurring chore

While the OAuth app's publishing status is **Testing**, Google expires the refresh token after
**7 days**. A send then fails with `not_authorised`, the vacancy is left untouched, and both the
Discord message and the failure notification tell you what to do:

```bash
pnpm email:authorise
```

That takes about twenty seconds and needs no Cloud Console work. Changing your Google password also
revokes the token, for the same reason.

You can try **PUBLISH APP** on the consent screen to remove the 7-day limit. Google's documented
position is that apps requesting a restricted scope — which `gmail.send` is — must complete
verification before launch, so it may refuse or ask you to verify. If it does, weekly re-authorising
is the simpler answer, and nothing else about the agent changes either way.

## Using it

| Command                                                            | What it does                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `/apply check id:<job>`                                            | Reads the advert's instruction, builds the message, and reports. Sends nothing. |
| `/apply prepare id:<job> override_salary:<yes/no>`                 | The same, with the salary floor overridden for that vacancy.                    |
| `/apply approve id:<job> manifest:<reference>`                     | **Sends it.** Requires the reference shown with the message.                    |
| `/apply reject id:<job> reason:<why>`                              | Discards it. Nothing is sent.                                                   |
| `/apply status id:<job>`                                           | Where one email application stands, and its receipt.                            |
| `/apply reconcile id:<job> outcome:<sent/not_sent> reference:<id>` | Closes out a send the provider never confirmed.                                 |
| `/apply list`                                                      | Everything prepared or sent.                                                    |

The review arrives in the channel as one or more numbered messages containing the recipient, the
reply address, the subject, the attachment's name and hash, the advert's own instruction quoted
verbatim, whether the address belongs to the advert's domain, and **the entire message body exactly
as it would be sent**. That is the one place applicant wording reaches Discord, and it exists because
approving a message you cannot read is not approval. Every other notification, every outbox row, and
every audit and log entry about this carries identifiers, a job title and a domain — never the
address, the body, or any profile value.

Quiet hours apply to the review like any other notification, so a review prepared at 23:00 arrives in
the morning. Nothing expires in the meantime; the review waits.

## The three outcomes of approving

- **Sent.** The provider acknowledged the message and gave an identifier. That identifier is recorded
  as the receipt, the vacancy is marked as applied for on your tracker, and no second application for
  it is possible by any route.
- **Refused.** The provider is known not to have sent it. Nothing is recorded as applied for, the
  day's slot is released, and you can prepare it again once the cause is fixed. The approval you gave
  is spent, so sending needs a fresh one.
- **Unconfirmed.** Nobody knows — a timeout, a dropped connection, or an acceptance with no
  identifier. **This is never retried.** The vacancy is frozen until you look in your own sent mail
  and say what you found with `/apply reconcile`. Applying twice is worse than not applying.

## Rehearsing it before the first real one

The full path — gates, approval, single use, ledger, receipt, tracker, notification, and all three
provider outcomes — is exercised by the test suite against the real database schema:

```bash
pnpm vitest run packages/db/src/email-application.test.ts apps/api/src/email-application-routes.test.ts
```

Against a live vacancy, the honest rehearsal is: `/apply prepare`, read the whole message, then
`/apply reject`. That exercises everything except the send itself, and `pnpm email:check --send`
proves the send independently.

## Sign-off block

Fill this in after the first real application, and paste it under the status table in `CLAUDE.md`.

```text
Email-application milestone sign-off

Provider configured and proved (pnpm email:check --send): ____________________  date __________
Advert instruction read correctly, recipient checked by me: __________________  date __________
Whole message read in Discord before approving:            __________________  date __________
Message sent, receipt recorded, tracker updated:            __________________  date __________
A second approval of the same vacancy was refused:          __________________  date __________
Notes:
```
