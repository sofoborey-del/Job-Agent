import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const content = `DB_MODE=embedded
PGLITE_DATA_DIR=./local-data/pglite
ARTIFACT_DATA_DIR=./local-data/artifacts
DATABASE_URL=
APP_TIMEZONE=Europe/London
APP_ENCRYPTION_KEY_ID=local-v1
APP_ENCRYPTION_KEY_BASE64=${randomBytes(32).toString('base64')}
PROFILE_ADMIN_TOKEN=${randomBytes(32).toString('base64url')}
API_HOST=127.0.0.1
API_PORT=3210
DISCORD_APPLICATION_ID=
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_USER_ID=
LLM_PROVIDER=
LLM_API_KEY=
`;

await mkdir('local-data', { recursive: true });

try {
  await writeFile('.env', content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log('Created .env with new local-only secrets.');
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    console.log('Existing .env was preserved.');
  } else {
    throw error;
  }
}
