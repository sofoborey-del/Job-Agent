/**
 * Outbound-only Discord checks. Nothing here opens a port or exposes the local service.
 *
 *   node --env-file=.env scripts/discord-check.mjs          identity and channel checks only
 *   node --env-file=.env scripts/discord-check.mjs --send   also posts one harmless test message
 *
 * The test message is plain text with mentions disabled and carries no applicant value. Secrets are
 * never printed; the bot token appears only as an authorization header.
 */
import { discordCall } from './discord-commands.mjs';

const problems = [];
const expected = [
  'DISCORD_APPLICATION_ID',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_BOT_TOKEN',
  'DISCORD_ALLOWED_USER_ID',
  'DISCORD_CHANNEL_ID',
];
for (const name of expected) {
  const present = (process.env[name] ?? '') !== '';
  console.log(`${present ? 'set  ' : 'EMPTY'}  ${name}`);
  if (!present) problems.push(`${name} is empty`);
}
if ((process.env.AGENT_USER_ID ?? '') === '') {
  console.log('EMPTY  AGENT_USER_ID  (slash commands stay disabled until this is set)');
  problems.push('AGENT_USER_ID is empty');
}
const publicKey = process.env.DISCORD_PUBLIC_KEY ?? '';
if (publicKey !== '' && !/^[0-9a-f]{64}$/i.test(publicKey)) {
  problems.push('DISCORD_PUBLIC_KEY is not 64 hex characters; it looks like the wrong value');
}
if (problems.length > 0) {
  console.error(`\nNot ready: ${problems.join('; ')}.`);
  process.exit(1);
}

const botToken = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;

const me = await discordCall('/users/@me', botToken);
console.log(`\nBot identity: ${me.username} (id ${me.id})`);
if (me.id !== process.env.DISCORD_APPLICATION_ID) {
  console.log(
    `  Note: the bot user id differs from DISCORD_APPLICATION_ID. That is normal for older applications, but check you copied the right Application ID.`,
  );
}

const channel = await discordCall(`/channels/${channelId}`, botToken);
console.log(`Channel: #${channel.name} (type ${String(channel.type)}, guild ${channel.guild_id})`);

const quietStart = Number(process.env.QUIET_HOURS_START ?? '22');
const quietEnd = Number(process.env.QUIET_HOURS_END ?? '7');
const hour = Number(
  new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    hour12: false,
    timeZone: process.env.APP_TIMEZONE ?? 'Europe/London',
  }).format(new Date()),
);
const inQuietHours =
  quietStart > quietEnd
    ? hour >= quietStart || hour < quietEnd
    : hour >= quietStart && hour < quietEnd;
console.log(
  `Local hour ${String(hour)}: ${inQuietHours ? 'INSIDE quiet hours — the agent itself would hold a real notification' : 'outside quiet hours'}.`,
);

if (!process.argv.includes('--send')) {
  console.log('\nChecks passed. Re-run with --send to post one test message to that channel.');
  process.exit(0);
}

await discordCall(`/channels/${channelId}/messages`, botToken, {
  method: 'POST',
  body: JSON.stringify({
    content:
      'Job agent connectivity test. This is not a vacancy notification, and nothing was applied for.',
    allowed_mentions: { parse: [] },
  }),
});
console.log('\nSent. Check the channel; the message should be visible only to you.');
