import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

import {
  createApplicationStores,
  createTrackingStores,
  PGliteDatabase,
  PGliteProfileRepository,
  PostgresDatabase,
  PostgresProfileRepository,
  SqlSitePolicyStore,
} from '@job-agent/db';
import { fakeAtsAdapter } from '@job-agent/adapters';
import { ApplicationWorkflowService } from '@job-agent/application';
import { defaultSourceDefinitions } from '@job-agent/discovery';
import { DiscordClient, DiscordCommandService } from '@job-agent/notifications';
import { RedactingLogger } from '@job-agent/observability';
import { ApplicationRunner, DiscoveryScheduler, OutboxPublisher } from '@job-agent/orchestrator';
import {
  DiscoveryService,
  JobMatchService,
  SchedulerReadinessService,
  type TrackingStores,
} from '@job-agent/tracking';
import type { SqlDatabase } from '@job-agent/db';
import type { DocumentRepository, ProfileRepository } from '@job-agent/profile';
import {
  CvProcessingService,
  DocumentService,
  LocalEncryptedArtifactStore,
  ProfileService,
  WindowsDefenderScanner,
} from '@job-agent/profile';
import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';

import { createApplicationCommandPort, type ApplicationRuntime } from './application-routes.js';
import { buildServer } from './server.js';
import { SpawnWorkerTransport } from './worker-transport.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`Required environment setting is missing: ${name}`);
  return value;
}

const host = process.env.API_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('The onboarding API is local-only in this phase');
}
const port = Number(process.env.API_PORT ?? '3210');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('API_PORT is invalid');

const databaseMode = process.env.DB_MODE ?? 'embedded';
let repository: ProfileRepository & DocumentRepository;
let sqlDatabase: SqlDatabase;
let closeDatabase: () => Promise<void>;
if (databaseMode === 'embedded') {
  const database = await PGlite.create(process.env.PGLITE_DATA_DIR ?? './local-data/pglite');
  repository = new PGliteProfileRepository(database);
  sqlDatabase = new PGliteDatabase(database);
  closeDatabase = async () => {
    await database.close();
  };
} else if (databaseMode === 'postgres') {
  const pool = new Pool({ connectionString: requiredEnvironment('DATABASE_URL') });
  repository = new PostgresProfileRepository(pool);
  sqlDatabase = new PostgresDatabase(pool);
  closeDatabase = async () => {
    await pool.end();
  };
} else {
  throw new Error('DB_MODE must be embedded or postgres');
}
const keys = StaticEncryptionKeyProvider.fromBase64(
  requiredEnvironment('APP_ENCRYPTION_KEY_ID'),
  requiredEnvironment('APP_ENCRYPTION_KEY_BASE64'),
);
const cipher = new FieldCipher(keys);
const profileService = new ProfileService(repository, cipher);
const artifactStore = new LocalEncryptedArtifactStore(
  process.env.ARTIFACT_DATA_DIR ?? './local-data/artifacts',
);
const documentService = new DocumentService(repository, artifactStore, cipher);
// One scanner, used both for the applicant's own CV and for untrusted documents an advert links.
const malwareScanner = new WindowsDefenderScanner();
const cvProcessingService = new CvProcessingService(
  repository,
  artifactStore,
  cipher,
  malwareScanner,
);
const logger = new RedactingLogger(
  (entry) => {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  },
  [process.env.DISCORD_BOT_TOKEN ?? '', process.env.PROFILE_ADMIN_TOKEN ?? ''].filter(
    (secret) => secret !== '',
  ),
);

const stores: TrackingStores = createTrackingStores(sqlDatabase);
const sitePolicyStore = new SqlSitePolicyStore(sqlDatabase);

// Shipped sources are written once, disabled, so nothing polls the network until reviewed.
for (const definition of defaultSourceDefinitions) {
  const existing = await stores.sources.getByKey(definition.key);
  if (existing === null) await stores.sources.upsertDefinition(definition, new Date());
}

const discordBotToken = process.env.DISCORD_BOT_TOKEN ?? '';
const discordChannelId = process.env.DISCORD_CHANNEL_ID ?? '';
const discordPublicKey = process.env.DISCORD_PUBLIC_KEY ?? '';
const discordAllowedUserId = process.env.DISCORD_ALLOWED_USER_ID ?? '';
const notificationsConfigured = discordBotToken !== '' && discordChannelId !== '';

const quietHoursStart = Number(process.env.QUIET_HOURS_START ?? '22');
const quietHoursEnd = Number(process.env.QUIET_HOURS_END ?? '7');
const publisher = new OutboxPublisher({
  stores,
  channel: notificationsConfigured
    ? new DiscordClient({ botToken: discordBotToken, channelId: discordChannelId, logger })
    : null,
  logger,
  quietHours:
    Number.isInteger(quietHoursStart) && Number.isInteger(quietHoursEnd)
      ? {
          startHour: quietHoursStart,
          endHour: quietHoursEnd,
          timeZone: process.env.APP_TIMEZONE ?? 'Europe/London',
        }
      : null,
});

const agentUserId = process.env.AGENT_USER_ID ?? '';
const discordConfigured =
  discordPublicKey !== '' && discordAllowedUserId !== '' && agentUserId !== '';
const schedulerEnabled = (process.env.DISCOVERY_SCHEDULER_ENABLED ?? 'false') === 'true';

// The scheduler is created whenever it is switched on, even with a missing or malformed
// AGENT_USER_ID, so that its status can explain the problem. It performs no discovery, matching or
// delivery until every readiness check passes.
const scheduler = schedulerEnabled
  ? new DiscoveryScheduler({
      discovery: new DiscoveryService({
        stores,
        userId: agentUserId,
        sitePolicyFor: (domain) => sitePolicyStore.findByDomain(domain),
        scanner: malwareScanner,
        logger,
      }),
      matching: new JobMatchService({ stores, userId: agentUserId, logger }),
      publisher,
      readiness: new SchedulerReadinessService({
        stores,
        userId: agentUserId,
        sitePolicyFor: (domain) => sitePolicyStore.findByDomain(domain),
        loadFacts: async () =>
          agentUserId === '' ? [] : await profileService.listFacts(agentUserId),
      }),
      loadFacts: async () =>
        agentUserId === '' ? [] : await profileService.listFacts(agentUserId),
      logger,
      tickIntervalMs:
        Math.max(Number(process.env.DISCOVERY_TICK_INTERVAL_SECONDS ?? '900'), 60) * 1000,
    })
  : null;

// Phase 2 browser automation. The adapter target is the bundled local fake ATS and nothing else:
// the origin is rejected below unless it is loopback, and the validator refuses any other target.
const fakeAtsOrigin = process.env.FAKE_ATS_ORIGIN ?? 'http://127.0.0.1:3311';
const fakeAtsHostname = (() => {
  try {
    return new URL(fakeAtsOrigin).hostname.toLowerCase();
  } catch {
    return '';
  }
})();
if (!['127.0.0.1', 'localhost', '::1'].includes(fakeAtsHostname)) {
  throw new Error(
    'FAKE_ATS_ORIGIN must be a loopback address; real employer sites are not allowed',
  );
}
const applicationStores = createApplicationStores(sqlDatabase);
const applicationAdapter = fakeAtsAdapter(fakeAtsOrigin);
const applicationWorkflow = new ApplicationWorkflowService({
  stores: applicationStores,
  cipher,
  adapter: applicationAdapter,
  logger,
  timezone: process.env.APP_TIMEZONE ?? 'Europe/London',
});
const applications: ApplicationRuntime = {
  stores: applicationStores,
  tracking: stores,
  workflow: applicationWorkflow,
  adapter: applicationAdapter,
  cipher,
  fakeAtsOrigin,
  // Drives the bundled fake ATS and nothing else: the origin was already rejected above unless it
  // is loopback, and the worker runs in its own process with the secrets withheld.
  drive: {
    runner: new ApplicationRunner({
      workflow: applicationWorkflow,
      transport: new SpawnWorkerTransport({ logger }),
      adapter: applicationAdapter,
      logger,
    }),
    loadFacts: async (userId) => await profileService.listFacts(userId),
    loadApprovedDocument: async (userId) => await cvProcessingService.approvedUpload(userId),
    policyVersion: 'fake-ats-local-v1',
  },
};

const app = buildServer({
  profileService,
  documentService,
  cvProcessingService,
  adminToken: requiredEnvironment('PROFILE_ADMIN_TOKEN'),
  logger: true,
  applications,
  tracking: {
    stores,
    sitePolicyFor: (domain) => sitePolicyStore.findByDomain(domain),
    listSitePolicies: () => sitePolicyStore.list(),
    scanner: malwareScanner,
    publisher,
    notificationsConfigured,
    manualSourceKey: 'myjobscotland_manual',
    schedulerEnabled,
    ...(scheduler === null ? {} : { scheduler }),
    ...(discordConfigured
      ? {
          discord: {
            publicKey: discordPublicKey,
            commands: new DiscordCommandService({
              stores,
              userId: agentUserId,
              allowedDiscordUserId: discordAllowedUserId,
              allowedChannelId: discordChannelId === '' ? null : discordChannelId,
              applications: createApplicationCommandPort(applications, agentUserId),
            }),
          },
        }
      : {}),
  },
});

if (scheduler !== null) {
  // One readiness check before the loop starts, so the reason is visible immediately. The loop
  // re-checks on every tick and stays idle while a problem remains, which means fixing the profile
  // or a source does not need a restart and nothing is retried in the meantime.
  const readiness = await scheduler.prime();
  if (!readiness.ready) {
    logger.log('warn', 'Scheduled discovery is switched on but not ready', {
      problems: readiness.problems.map((problem) => problem.code),
    });
  }
  scheduler.start();
}

const shutdown = async (): Promise<void> => {
  scheduler?.stop();
  await app.close();
  await closeDatabase();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ host, port });
