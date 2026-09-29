/**
 * The slash-command definitions the agent answers, and a registrar for them.
 *
 * Every command here maps to a branch of DiscordCommandService.route(). Nothing in this surface
 * can start a real application or submit anything: the workflow-intent commands only move tracker
 * state, and the application commands only reach the local fake ATS.
 *
 * Commands are registered to one guild, not globally. Guild commands appear immediately and exist
 * only in the private server the bot was invited to; a global command would be visible in every
 * server the application is ever added to.
 */

const idOption = {
  type: 3,
  name: 'id',
  description: 'The first characters of the id shown in the list',
  required: true,
};

const reasonOption = {
  type: 3,
  name: 'reason',
  description: 'Optional note recorded in the tracker history',
  required: false,
};

function sub(name, description, options = []) {
  return { type: 1, name, description, options };
}

export const commandDefinitions = [
  {
    name: 'agent',
    description: 'Agent status and the pause switch',
    options: [
      sub('status', 'Show what the agent is doing and whether anything is waiting'),
      sub('pause', 'Stop scheduled searching and notifications'),
      sub('resume', 'Allow scheduled searching again'),
    ],
  },
  {
    name: 'jobs',
    description: 'The shortlist and the rest of the tracker',
    options: [
      sub('list', 'List tracked jobs', [
        {
          type: 3,
          name: 'status',
          description: 'Which list to show (default shortlisted)',
          required: false,
          choices: [
            { name: 'shortlisted', value: 'shortlisted' },
            { name: 'discovered', value: 'discovered' },
            { name: 'reviewed', value: 'reviewed' },
            { name: 'rejected', value: 'rejected' },
            { name: 'archived', value: 'archived' },
          ],
        },
      ]),
      sub('discover', 'Explains where on-demand searching is started'),
    ],
  },
  {
    name: 'job',
    description: 'One tracked vacancy',
    options: [
      sub('show', 'Show the match decision for one vacancy', [idOption]),
      sub('shortlist', 'Move it to the shortlist', [idOption, reasonOption]),
      sub('reviewed', 'Mark it as reviewed', [idOption, reasonOption]),
      sub('reject', 'Reject it', [idOption, reasonOption]),
      sub('archive', 'Archive it', [idOption, reasonOption]),
      sub('apply', 'Always refuses: real applications are not enabled', [idOption]),
    ],
  },
  {
    // The only command group that can cause anything to leave this machine. `approve` requires the
    // review reference shown with the message, so it cannot be issued without having read it.
    name: 'apply',
    description: 'Apply by email, where the advert asks candidates to do that',
    options: [
      sub('check', 'Read the advert’s application instruction and prepare a message', [idOption]),
      sub('prepare', 'Build the message and post it here for you to read', [
        idOption,
        {
          type: 3,
          name: 'override_salary',
          description: 'Apply even though the salary is below or under your minimum',
          required: false,
          choices: [
            { name: 'yes', value: 'true' },
            { name: 'no', value: 'false' },
          ],
        },
      ]),
      sub('approve', 'Send the message you have read. This really does send it', [
        idOption,
        {
          type: 3,
          name: 'manifest',
          description: 'The review reference shown with the message',
          required: true,
        },
      ]),
      sub('reject', 'Discard the message. Nothing is sent', [idOption, reasonOption]),
      sub('status', 'Where one email application stands', [idOption]),
      sub('reconcile', 'Record what you found after a send the provider did not confirm', [
        idOption,
        {
          type: 3,
          name: 'outcome',
          description: 'What your sent mail shows',
          required: true,
          choices: [
            { name: 'it was sent', value: 'sent' },
            { name: 'it was not sent', value: 'not_sent' },
          ],
        },
        {
          type: 3,
          name: 'reference',
          description: 'The message reference from your sent mail',
          required: false,
        },
      ]),
      sub('list', 'Email applications prepared or sent'),
    ],
  },
  {
    name: 'application',
    description: 'Practice applications on the local fake ATS only',
    options: [
      sub('list', 'List practice applications in progress'),
      sub('show', 'Show one practice application', [idOption]),
      sub('question', 'Show the question waiting for you', [idOption]),
      sub('answer', 'Answer the waiting question', [
        idOption,
        { type: 3, name: 'value', description: 'Your answer', required: true },
        {
          type: 3,
          name: 'save',
          description: 'Also save this to your profile as a verified fact',
          required: false,
          choices: [
            { name: 'yes', value: 'true' },
            { name: 'no', value: 'false' },
          ],
        },
      ]),
      sub('approve', 'Approve the reviewed manifest', [
        idOption,
        {
          type: 3,
          name: 'manifest',
          description: 'The review manifest reference shown on the review screen',
          required: true,
        },
      ]),
      sub('reject', 'Reject the reviewed manifest', [idOption, reasonOption]),
      sub('takeover', 'Take the browser over yourself', [idOption]),
      sub('resume', 'Hand control back to the agent', [idOption]),
    ],
  },
];

const API = 'https://discord.com/api/v10';

async function call(path, botToken, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${botToken}`,
      'content-type': 'application/json',
      'user-agent': 'JobApplicationAgent/0.1 (personal, single user)',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    // The body can echo request content but never the token; the token is only ever a header.
    throw new Error(`Discord ${init.method ?? 'GET'} ${path} failed: ${response.status} ${text}`);
  }
  return text === '' ? null : JSON.parse(text);
}

export { call as discordCall };

/** Resolves the guild from the configured channel, so no extra .env value is needed. */
export async function resolveGuildId(botToken, channelId, override) {
  if (override !== undefined && override !== null && override !== '') return override;
  const channel = await call(`/channels/${channelId}`, botToken);
  if (typeof channel?.guild_id !== 'string') {
    throw new Error(
      'DISCORD_CHANNEL_ID is not a channel in a server. Slash commands need a channel in a private server you own, not a direct message.',
    );
  }
  return channel.guild_id;
}
