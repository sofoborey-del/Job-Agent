/**
 * Checks that the email provider is configured, without touching a vacancy or the tracker.
 *
 *   node --env-file=.env scripts/email-check.mjs          credentials only
 *   node --env-file=.env scripts/email-check.mjs --send   also sends one message to yourself
 *
 * The rehearsal message goes to the authenticated account itself. It carries no applicant value, no
 * attachment and no employer address, and nothing about it reaches the tracker: it proves the
 * credentials and the message encoding, and nothing else. Secrets are never printed.
 */
import { GmailEmailTransport } from '../packages/email-application/dist/index.js';

const names = ['EMAIL_PROVIDER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
const problems = [];
for (const name of names) {
  const present = (process.env[name] ?? '') !== '';
  console.log(`${present ? 'set  ' : 'EMPTY'}  ${name}`);
  if (!present) problems.push(name);
}
if ((process.env.EMAIL_APPLICATIONS_ENABLED ?? 'false') !== 'true') {
  console.log(
    'note   EMAIL_APPLICATIONS_ENABLED is not true, so the running agent will not offer /apply.',
  );
}
if ((process.env.EMAIL_PROVIDER ?? '') !== '' && process.env.EMAIL_PROVIDER !== 'gmail') {
  problems.push('EMAIL_PROVIDER must be gmail; no other provider is implemented');
}
if (problems.length > 0) {
  console.error(`\nNot ready: ${problems.join(', ')}. See docs/runbooks/email-applications.md.`);
  process.exit(1);
}

const transport = new GmailEmailTransport({
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
  refreshToken: process.env.GMAIL_REFRESH_TOKEN,
});

if (!process.argv.includes('--send')) {
  console.log('\nEvery credential is present. Re-run with --send to prove they work.');
  process.exit(0);
}

const address = process.argv[process.argv.indexOf('--send') + 1] ?? '';
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
  console.error(
    '\nGive your own address, so the rehearsal goes to you:\n  pnpm email:check --send you@example.com',
  );
  process.exit(1);
}

const result = await transport.send({
  to: address,
  replyTo: address,
  subject: 'Job agent send test',
  body: 'This is a connectivity test from the job application agent. Nothing was applied for.\n',
  attachment: {
    filename: 'test.txt',
    contentType: 'text/plain',
    contentBase64: Buffer.from('test attachment').toString('base64'),
    sha256: (await import('node:crypto'))
      .createHash('sha256')
      .update(Buffer.from('test attachment'))
      .digest('hex'),
  },
  idempotencyKey: `email-check:${new Date().toISOString()}`,
});

if (result.status === 'sent') {
  console.log(`\nSent to ${address}. Provider reference ${result.providerMessageId}.`);
  process.exit(0);
}
console.error(
  `\nNot sent: ${result.status === 'refused' ? result.errorCode : result.reason}. ` +
    'Check the OAuth client, the scope, and that the refresh token is the one this client issued.',
);
process.exit(1);
