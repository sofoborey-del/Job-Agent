/**
 * The send-only Gmail authorisation, and plain-English translations of the ways it fails.
 *
 * Shared by `email-setup.mjs` (the guided walkthrough) and `email-authorise.mjs` (re-authorising
 * later). The flow is the standard installed-application one: a loopback listener, PKCE, and a
 * one-time code exchanged for a refresh token.
 *
 * The scope requested is `gmail.send` and nothing else. It permits sending as the authorising
 * account and grants no ability to read, list, label or delete anything in the mailbox.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export const consoleUrls = {
  createProject: 'https://console.cloud.google.com/projectcreate',
  enableGmail: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  branding: 'https://console.cloud.google.com/auth/branding',
  audience: 'https://console.cloud.google.com/auth/audience',
  clients: 'https://console.cloud.google.com/auth/clients',
  permissions: 'https://myaccount.google.com/permissions',
};

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Best effort. A browser that does not open is not a failure: the URL is always printed too. */
export function openInBrowser(url) {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns Google's machine codes into the thing the person actually has to go and fix.
 *
 * This is most of the value of the guided setup. Every one of these has a specific cause and a
 * specific screen, and the raw error says none of that.
 */
export function explainOAuthFailure(raw) {
  const text = String(raw);
  if (/access_denied/i.test(text)) {
    return [
      'Google refused the request with "access_denied".',
      'Almost always this means your own address is not on the test-user list for the app.',
      `Open ${consoleUrls.audience}, find "Test users", click "Add users", add the Google address you are signing in with, and save.`,
    ].join('\n');
  }
  if (
    /has not been used in project|Gmail API has not been used|accessNotConfigured|SERVICE_DISABLED/i.test(
      text,
    )
  ) {
    return [
      'The Gmail API is not switched on for this project.',
      `Open ${consoleUrls.enableGmail} and click Enable, then wait a few seconds and try again.`,
    ].join('\n');
  }
  if (/invalid_client|unauthorized_client/i.test(text)) {
    return [
      'Google did not recognise the client id and secret.',
      `Open ${consoleUrls.clients} and check you copied them from an OAuth client whose type is "Desktop app".`,
      'A "Web application" client will not work with this flow.',
    ].join('\n');
  }
  if (/invalid_grant/i.test(text)) {
    return [
      'Google rejected the stored authorisation ("invalid_grant").',
      'This normally means the refresh token has expired or been revoked. Two common causes:',
      '  - the app is still in Testing status, where Google expires refresh tokens after 7 days;',
      '  - the Google account password was changed, which revokes tokens carrying Gmail scopes.',
      'Run: pnpm email:authorise',
    ].join('\n');
  }
  if (/redirect_uri_mismatch/i.test(text)) {
    return [
      'Google rejected the loopback address.',
      'That happens when the OAuth client is not of type "Desktop app". Create a Desktop app client',
      `at ${consoleUrls.clients} and use its id and secret.`,
    ].join('\n');
  }
  if (/admin_policy_enforced/i.test(text)) {
    return [
      'A Google Workspace administrator has blocked this scope for your account.',
      'If this is a work or college account, use a personal Google account instead.',
    ].join('\n');
  }
  return `Google returned: ${text}`;
}

/**
 * Runs the consent flow and returns the refresh token.
 *
 * `log` receives progress lines. Nothing it is given contains a credential.
 */
export async function authoriseGmail({
  clientId,
  clientSecret,
  log = () => {},
  openBrowser = true,
}) {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(16));

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${String(port)}`;

  const authorisationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorisationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SEND_SCOPE,
    access_type: 'offline',
    // Forces a refresh token even if this client has been authorised before.
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const href = authorisationUrl.toString();

  log('');
  log('Approve the send-only permission in your browser:');
  log('');
  log(`  ${href}`);
  log('');
  if (openBrowser) openInBrowser(href);
  log('If Google warns that the app is not verified, choose Advanced and continue: the app is');
  log('yours, and the only permission it asks for is sending mail as you.');
  log('');
  log('Waiting for Google to redirect back to this machine…');

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('timed out after five minutes'));
      }, 300_000);
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        const error = url.searchParams.get('error');
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        if (error !== null) {
          response.end('That did not work. Go back to the terminal for what to do next.');
          clearTimeout(timeout);
          reject(new Error(error));
          return;
        }
        if (url.searchParams.get('state') !== state) {
          response.end('That response did not match this request. You can close this tab.');
          return;
        }
        const returned = url.searchParams.get('code');
        if (returned === null) {
          response.end('No authorisation code arrived. You can close this tab.');
          return;
        }
        response.end('Authorised. You can close this tab and return to the terminal.');
        clearTimeout(timeout);
        resolve(returned);
      });
    });
  } finally {
    server.close();
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
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

  // The body can echo the request, so it is read for its error field and never printed whole.
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      explainOAuthFailure(
        payload.error_description ?? payload.error ?? `HTTP ${String(response.status)}`,
      ),
    );
  }
  if (typeof payload.refresh_token !== 'string' || payload.refresh_token === '') {
    throw new Error(
      [
        'Google authorised the request but returned no refresh token.',
        `Remove this app at ${consoleUrls.permissions} and run the command again, so Google asks for`,
        'consent afresh rather than reusing an earlier grant.',
      ].join('\n'),
    );
  }
  return { refreshToken: payload.refresh_token, scope: payload.scope ?? GMAIL_SEND_SCOPE };
}
