# Giving Discord a way to reach the agent

Dated 2026-09-29. The agent already sends Discord messages. It cannot receive commands, so there is
no way to approve, reject or answer a question from your phone. This note sets out the options for
fixing that, and what each one costs in exposure.

## Why it does not work today

Discord slash commands use an HTTP interactions model by default: Discord calls **you**, at a public
HTTPS URL. The agent binds to loopback only and has no public endpoint, so the four registered
commands have nowhere to be delivered.

Two further things are also in the way, and neither is fixed by opening a door:

- The hosted build sets `discordConfigured` to false whenever `AGENT_DEPLOYMENT_MODE=discovery_only`,
  so the inbound handler does not exist on the VM at all. `DISCORD_PUBLIC_KEY` and
  `DISCORD_ALLOWED_USER_ID` are deliberately not copied to the server.
- At this phase an approve command may only change tracker state. It must not start an application.
  That is a specification decision, not a missing feature.

## Option A — receive interactions over the Gateway (recommended)

Discord delivers interactions over its Gateway WebSocket as `INTERACTION_CREATE` events **when no
Interactions Endpoint URL is configured on the application**. The bot opens an outbound WebSocket and
receives commands down it.

- **Inbound exposure: none.** No public URL, no reverse proxy, no port, no tunnel. The agent keeps
  its outbound-only shape exactly as it is now, which is the property the whole deployment was built
  around.
- Works unchanged on the VM behind its current firewall.
- No privileged gateway intents are required for interactions, so the application hardening already
  applied stays as it is.

Costs: this is new code. The current implementation verifies Ed25519 signatures on HTTP requests
(`verifyInteractionSignature`); a Gateway client instead authenticates once with the bot token and
trusts the socket, so the allowlist check on the Discord user ID becomes the only authorisation gate
and must be exact. It also adds a long-lived connection to maintain, with reconnect and resume
handling, and either a dependency such as discord.js or a small hand-written client.

**Verify against current Discord developer documentation before building.** This behaviour is
documented but has changed shape before, and the whole option rests on it.

## Option B — Cloudflare Tunnel to the VM

A `cloudflared` daemon on the VM makes an outbound connection to Cloudflare, which then routes
`https://something.example.com` to the agent. No inbound port is opened on the VM and no change is
made to the Oracle security list.

- Keeps the HTTP interactions code exactly as written, including signature verification.
- Needs a domain and a Cloudflare account, and puts a third party in the path of every command.
- The endpoint is genuinely public: anyone can POST to it. Protection is then entirely the Ed25519
  signature check and the user allowlist. Those are good controls, but they become load-bearing in a
  way they are not today.

## Option C — a real reverse proxy and an open 443

Caddy or nginx on the VM with a certificate, port 443 opened in firewalld and in the Oracle security
list.

- Most conventional, no third party.
- Directly contradicts the current design: the deployment's central property is that nothing is
  reachable from the internet. It also means patching and monitoring a public web server on a box
  holding your encrypted profile.
- Not recommended while a no-inbound option exists.

## Option D — run the command handler locally, not on the VM

Keep the VM outbound-only, and run a second instance in `local` mode on the Windows machine to serve
interactions when it happens to be on.

- No change to the hosted deployment.
- Breaks the single-writer rule the deployment depends on: two schedulers against two databases would
  double-search Adzuna and send duplicate messages. It would need the local instance to run with the
  scheduler disabled and to act on the same data, which it cannot do while the data lives in a Docker
  volume on the VM.
- Only workable as approve-from-phone-while-laptop-is-on, which is most of the value gone.

## Recommendation

Option A. It is the only one that adds the capability without adding an internet-facing door, and it
is the reason to prefer writing a small amount of new code over configuring infrastructure.

If Option A turns out not to be supported as documented, Option B is the fallback, and it should come
with its own written threat model covering what the signature check and allowlist do and do not
guarantee.

## What this does not give you

Approving from Discord would move a job's tracker state. It would not fill or submit an employer
form. That is a separate phase with a separate gate, and it is blocked on site permission rather than
on engineering: see `docs/real-application-pilot.md`.
