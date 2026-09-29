/**
 * Re-authorises the send-only Gmail permission, and saves the new refresh token.
 *
 *   pnpm email:authorise
 *
 * Use this when a send fails with "not authorised". The usual cause is that the OAuth app is still in
 * Testing status, where Google expires refresh tokens after 7 days; changing your Google password
 * also revokes tokens carrying Gmail scopes. It takes about twenty seconds.
 *
 * For first-time setup use `pnpm email:setup`, which walks through the Google Cloud steps as well.
 *
 * The scope requested is gmail.send and nothing else: it permits sending as you and grants no
 * ability to read, list, label or delete anything in your mailbox. Withdraw it whenever you like at
 * https://myaccount.google.com/permissions.
 */
import { hasValue, updateEnvFile } from './email-env.mjs';
import { authoriseGmail, explainOAuthFailure } from './email-oauth.mjs';

const ENV = '.env';

if (!hasValue(ENV, 'GMAIL_CLIENT_ID') || !hasValue(ENV, 'GMAIL_CLIENT_SECRET')) {
  console.error(
    'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are not set yet. Run "pnpm email:setup" first — it\nwalks through creating them.',
  );
  process.exit(1);
}

try {
  const { refreshToken, scope } = await authoriseGmail({
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    log: (line) => {
      console.log(line);
    },
  });
  updateEnvFile(ENV, { GMAIL_REFRESH_TOKEN: refreshToken });
  console.log(`\nAuthorised, and saved to .env. Scope granted: ${scope}`);
  console.log('Restart the agent so it picks up the new token.');
} catch (error) {
  console.error(`\n${explainOAuthFailure(error instanceof Error ? error.message : error)}\n`);
  process.exit(1);
}
