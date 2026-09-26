/**
 * Registers the agent's slash commands in the one private guild that owns the configured channel.
 *
 * Run with:  node --env-file=.env scripts/register-discord-commands.mjs
 * Add --list to show what is currently registered without changing anything.
 * Add --clear to remove every registered command from that guild.
 *
 * This writes nothing to Discord except the command list. It never posts a message, reads channel
 * history, or touches guild members. No secret is printed: identifiers are, secrets are not.
 */
import { commandDefinitions, discordCall, resolveGuildId } from './discord-commands.mjs';

function required(name) {
  const value = process.env[name] ?? '';
  if (value === '') {
    console.error(`${name} is empty in .env. Fill it in locally, then run this again.`);
    process.exit(1);
  }
  return value;
}

const applicationId = required('DISCORD_APPLICATION_ID');
const botToken = required('DISCORD_BOT_TOKEN');
const channelId = required('DISCORD_CHANNEL_ID');
const mode = process.argv.includes('--clear')
  ? 'clear'
  : process.argv.includes('--list')
    ? 'list'
    : 'register';

const guildId = await resolveGuildId(botToken, channelId, process.env.DISCORD_GUILD_ID);
const path = `/applications/${applicationId}/guilds/${guildId}/commands`;
console.log(`Guild ${guildId}, resolved from the configured channel.`);

if (mode === 'list') {
  const current = await discordCall(path, botToken);
  if (current.length === 0) console.log('No commands are registered in that guild.');
  for (const command of current) {
    const subs = (command.options ?? [])
      .filter((option) => option.type === 1)
      .map((option) => option.name);
    console.log(`  /${command.name}${subs.length > 0 ? ` — ${subs.join(', ')}` : ''}`);
  }
  process.exit(0);
}

const payload = mode === 'clear' ? [] : commandDefinitions;
const result = await discordCall(path, botToken, {
  method: 'PUT',
  body: JSON.stringify(payload),
});

if (mode === 'clear') {
  console.log('Cleared. No commands are registered in that guild.');
} else {
  console.log(`Registered ${String(result.length)} command(s) in that guild:`);
  for (const command of result) console.log(`  /${command.name}`);
  console.log(
    '\nGuild commands appear immediately. They exist only in this server.\nSlash commands will not reach the agent until the interaction endpoint is set; see the runbook.',
  );
}
