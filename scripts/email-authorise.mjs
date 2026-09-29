/**
 * One-time authorisation of the applicant's own Gmail account for sending.
 *
 *   node --env-file=.env scripts/email-authorise.mjs
 *
 * What it does: opens a loopback listener, prints a Google consent URL for you to open, receives
 * the one-time code Google redirects back, exchanges it for a refresh token, and prints that token
 * in this terminal for you to paste into your local .env. It writes nothing to disk and sends
 * nothing anywhere else.
 *
 * The scope requested is https://www.googleapis.com/auth/gmail.send and nothing else. That scope
 * permits sending a message as you, and grants no ability to read, list, label or delete anything
 * in your mailbox. You can revoke it at any time at https://myaccount.google.com/permissions.
 *
 * Before running this you need a Google Cloud OAuth client of type "Desktop app"; the runbook
 * docs/runbooks/email-applications.md gives the steps. Put its client id and secret in .env as
 * GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const clientId = process.env.GMAIL_CLIENT_ID ?? '';
const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? '';

if (clientId === '' || clientSecret === '') {
  console.error(
    'Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first. See docs/runbooks/email-applications.md.',
  );
  process.exit(1);
}

const base64Url = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const verifier = base64Url(randomBytes(48));
const challenge = base64Url(createHash('sha256').update(verifier).digest());
const state = base64Url(randomBytes(16));

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const redirectUri = `http://127.0.0.1:${String(port)}`;

const authorisationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authorisationUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  // Forces a refresh token even if you have authorised this client before.
  prompt: 'consent',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
}).toString();

console.log('\nOpen this address in your browser and approve the send-only permission:\n');
console.log(authorisationUrl.toString());
console.log('\nWaiting for Google to redirect back to this machine…');

const code = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timed out after five minutes')), 300_000);
  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', redirectUri);
    const returnedState = url.searchParams.get('state');
    const returnedCode = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    if (error !== null) {
      response.end('Authorisation was refused. You can close this tab.');
      clearTimeout(timeout);
      reject(new Error(`Google returned: ${error}`));
      return;
    }
    if (returnedState !== state || returnedCode === null) {
      response.end('That response did not match this request. You can close this tab.');
      return;
    }
    response.end('Authorised. You can close this tab and return to the terminal.');
    clearTimeout(timeout);
    resolve(returnedCode);
  });
});

server.close();

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }).toString(),
});

if (!tokenResponse.ok) {
  // The body can echo the request but never the secret, which is only ever a form field.
  console.error(`\nGoogle refused the exchange: HTTP ${String(tokenResponse.status)}`);
  process.exit(1);
}

const tokens = await tokenResponse.json();
if (typeof tokens.refresh_token !== 'string') {
  console.error(
    '\nGoogle returned no refresh token. Revoke this application at https://myaccount.google.com/permissions and run this again.',
  );
  process.exit(1);
}

console.log(
  '\nAuthorised. Add this line to your local .env, then delete it from your scrollback:\n',
);
console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log(
  `\nScope granted: ${typeof tokens.scope === 'string' ? tokens.scope : SCOPE}\nThen run: pnpm email:check --send`,
);
