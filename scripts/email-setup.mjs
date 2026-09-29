/**
 * Guided setup for sending email applications from your own Gmail account.
 *
 *   pnpm email:setup
 *
 * One step at a time: it opens the exact page you need, names the button you are looking for, takes
 * what you copy back, checks it, and writes it to your local .env. It is resumable — anything already
 * configured is detected and skipped — so it is safe to stop partway and run it again.
 *
 * It writes only to .env (keeping a .env.backup), talks only to Google, and never prints a
 * credential. The permission it ends up with is send-only: it cannot read your mail.
 */
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import { hasValue, readEnvFile, updateEnvFile } from './email-env.mjs';
import { authoriseGmail, consoleUrls, explainOAuthFailure, openInBrowser } from './email-oauth.mjs';
import { GmailEmailTransport } from '../packages/email-application/dist/index.js';

const ENV = '.env';
const rl = createInterface({ input: process.stdin, output: process.stdout });

function heading(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

async function pause(prompt = 'Press Enter when that is done. ') {
  await rl.question(`\n${prompt}`);
}

async function ask(prompt) {
  return (await rl.question(`${prompt} `)).trim();
}

async function askYesNo(prompt) {
  for (;;) {
    const answer = (await rl.question(`${prompt} [y/n] `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
  }
}

function show(url) {
  console.log(`\n  ${url}`);
  if (openInBrowser(url)) console.log('  (opening that in your browser)');
}

function stop(message) {
  console.error(`\n${message}\n`);
  rl.close();
  process.exit(1);
}

if (!readEnvFile(ENV).text) {
  stop('There is no .env file here. Run "pnpm setup:local" first, then come back.');
}

console.log(`
Setting up email applications.

This lets the agent send an application from your own Gmail account, for vacancies whose advert
explicitly asks candidates to apply by email. You will still read and approve every message before
anything is sent.

The permission you are about to create can send mail as you and nothing else. It cannot read,
search or delete anything in your mailbox.

Nothing is sent to any employer during this setup.`);

// ── Step 1: a project to hold the credential ────────────────────────────────────────────────────
const alreadyHaveClient = hasValue(ENV, 'GMAIL_CLIENT_ID') && hasValue(ENV, 'GMAIL_CLIENT_SECRET');

if (alreadyHaveClient) {
  heading('Steps 1 to 4 — already done');
  console.log(
    'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are already in your .env, so skipping ahead.',
  );
  console.log('If you want to start those steps again, clear both values in .env and re-run this.');
} else {
  heading('Step 1 of 6 — create a Google Cloud project');
  console.log(`
A project is just a container for the credential. It is free, it is private to you, and nothing runs
in it.

On the page that opens:
  - put anything you like in "Project name" (for example: job-agent)
  - leave the other fields alone
  - click CREATE, and wait for the notification saying it is ready`);
  show(consoleUrls.createProject);
  await pause();

  // ── Step 2: the API itself ────────────────────────────────────────────────────────────────────
  heading('Step 2 of 6 — switch on the Gmail API');
  console.log(`
Make sure your new project is the one selected in the bar at the top of the page, then click the
blue ENABLE button.

If the button says MANAGE instead, it is already on and there is nothing to do.`);
  show(consoleUrls.enableGmail);
  await pause();

  // ── Step 3: consent screen ────────────────────────────────────────────────────────────────────
  heading('Step 3 of 6 — describe the app to Google');
  console.log(`
Google calls this the consent screen. It is what you would see when approving the permission, and it
only ever shows to you.

Fill in:
  - App name: anything, for example "My job agent"
  - User support email: your own address
  - Audience: choose External
  - Contact information: your own address again
  - tick the box to accept the policy, then click CREATE

You do NOT need to submit anything for verification, and you do not need a website or a domain.`);
  show(consoleUrls.branding);
  await pause();

  // ── Step 4: test user, the step everyone misses ───────────────────────────────────────────────
  heading('Step 4 of 6 — add yourself as a test user');
  console.log(`
This is the step people miss, and skipping it makes the next part fail with "access_denied".

On the Audience page, find the "Test users" section, click + ADD USERS, type the Google address you
will be sending from, and click SAVE.`);
  show(consoleUrls.audience);
  await pause();

  // ── Step 5: the credential ────────────────────────────────────────────────────────────────────
  heading('Step 5 of 6 — create the credential');
  console.log(`
On the page that opens:
  - click + CREATE CLIENT
  - Application type: choose Desktop app   <- this matters; "Web application" will not work
  - Name: anything, for example "job agent desktop"
  - click CREATE

Google then shows a panel with a Client ID and a Client secret. Copy them one at a time below.
They are written straight into your .env and are never printed back.`);
  show(consoleUrls.clients);

  let clientId = '';
  while (clientId === '') {
    const entered = await ask('\nClient ID:');
    if (entered === '') continue;
    if (!/\.apps\.googleusercontent\.com$/.test(entered)) {
      console.log(
        '  That does not look like a Google client id — they end in ".apps.googleusercontent.com".',
      );
      if (!(await askYesNo('  Use it anyway?'))) continue;
    }
    clientId = entered;
  }

  let clientSecret = '';
  while (clientSecret === '') {
    const entered = await ask('Client secret:');
    if (entered === '') continue;
    if (entered.length < 12) {
      console.log(
        '  That looks too short to be the secret. It is the value next to "Client secret".',
      );
      continue;
    }
    clientSecret = entered;
  }

  updateEnvFile(ENV, { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret });
  console.log('\nSaved both to .env.');
}

// ── Step 6: authorise ───────────────────────────────────────────────────────────────────────────
const env = readEnvFile(ENV).values;
const clientId = env.get('GMAIL_CLIENT_ID') ?? '';
const clientSecret = env.get('GMAIL_CLIENT_SECRET') ?? '';

let refreshToken = env.get('GMAIL_REFRESH_TOKEN') ?? '';
if (refreshToken !== '') {
  heading('Step 6 of 6 — authorisation');
  console.log('A GMAIL_REFRESH_TOKEN is already saved.');
  if (await askYesNo('Replace it with a fresh one?')) refreshToken = '';
}

if (refreshToken === '') {
  heading('Step 6 of 6 — approve the permission');
  try {
    const result = await authoriseGmail({
      clientId,
      clientSecret,
      log: (line) => {
        console.log(line);
      },
    });
    refreshToken = result.refreshToken;
    updateEnvFile(ENV, { GMAIL_REFRESH_TOKEN: refreshToken });
    console.log(`\nAuthorised, and saved to .env. Scope granted: ${result.scope}`);
  } catch (error) {
    stop(explainOAuthFailure(error instanceof Error ? error.message : error));
  }
}

// ── Prove it, then switch it on ─────────────────────────────────────────────────────────────────
heading('Proving it works');
console.log(`
This sends one message to an address you choose, so you can see it arrive. It carries no attachment
from your profile, touches no vacancy, and records nothing.`);

let address = '';
while (address === '') {
  const entered = await ask('\nYour own email address:');
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entered)) address = entered;
  else console.log('  That is not an email address.');
}

const body =
  'This is a connectivity test from the job application agent. Nothing was applied for.\n';
const attachment = Buffer.from('test attachment');
const result = await new GmailEmailTransport({ clientId, clientSecret, refreshToken }).send({
  to: address,
  replyTo: address,
  subject: 'Job agent send test',
  body,
  attachment: {
    filename: 'test.txt',
    contentType: 'text/plain',
    contentBase64: attachment.toString('base64'),
    sha256: createHash('sha256').update(attachment).digest('hex'),
  },
  idempotencyKey: `email-setup:${new Date().toISOString()}`,
});

if (result.status !== 'sent') {
  const detail = result.status === 'refused' ? result.errorCode : result.reason;
  stop(
    [
      `The test message did not send (${detail}).`,
      '',
      explainOAuthFailure(detail),
      '',
      'Your .env is saved, so fix the cause and run "pnpm email:setup" again — it will skip the',
      'steps you have already done.',
    ].join('\n'),
  );
}

console.log(`\nSent to ${address}. Provider reference ${result.providerMessageId}.`);

const turnOn = await askYesNo(
  '\nSwitch the feature on, so /apply appears in Discord? Nothing can send without your approval.',
);
if (turnOn) {
  updateEnvFile(ENV, { EMAIL_APPLICATIONS_ENABLED: 'true', EMAIL_PROVIDER: 'gmail' });
  console.log('Switched on in .env.');
} else {
  console.log('Left switched off. Set EMAIL_APPLICATIONS_ENABLED=true in .env when you are ready.');
}

heading('Done');
console.log(`
What is left:

  1. pnpm discord:register      registers the /apply commands
  2. restart the agent          so it picks up the new .env
  3. /apply check id:<job>      reads an advert's instruction. Sends nothing.

One thing to know. While the app's publishing status is "Testing", Google expires the refresh token
after 7 days, and a send will then fail with "not authorised". That is not a fault: run

  pnpm email:authorise

and it takes about twenty seconds. If you would rather not do that weekly, you can try PUBLISH APP on
the consent screen, which removes the 7-day limit — Google may ask you to verify the app first, and if
it does, weekly re-authorising is the simpler answer.

You can withdraw this permission at any time: ${consoleUrls.permissions}
`);

rl.close();
