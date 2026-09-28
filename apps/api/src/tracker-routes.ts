import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  sourceDefinitionSchema,
  supportedDiscoveryDomains,
  type SourceDefinition,
} from '@job-agent/discovery';
import { findMissingProfileCategories } from '@job-agent/knowledge-base';
import { newCorrelationId } from '@job-agent/observability';
import type { SitePolicy } from '@job-agent/policy';
import { evaluateSitePolicy } from '@job-agent/policy';
import type { ProfileService } from '@job-agent/profile';
import {
  DiscoveryService,
  JobMatchService,
  lifecycleStatuses,
  reviewStatuses,
  reviewTransitionsFrom,
  SourceAdminService,
  SourceEnableRefusedError,
  type LifecycleStatus,
  type ReviewStatus,
  type SitePolicyLookup,
  type TrackerFilter,
  type TrackingStores,
} from '@job-agent/tracking';
import type { MalwareScanner } from '@job-agent/document-safety';
import type { DiscordCommandService } from '@job-agent/notifications';
import { verifyInteractionSignature } from '@job-agent/notifications';
import type { DiscoveryScheduler, OutboxPublisher } from '@job-agent/orchestrator';

export type TrackingRuntime = {
  stores: TrackingStores;
  sitePolicyFor: SitePolicyLookup;
  listSitePolicies: () => Promise<SitePolicy[]>;
  fetcher?: typeof fetch;
  /** Enables reading the criteria document an advert links. Without it, none is fetched. */
  scanner?: MalwareScanner;
  publisher?: OutboxPublisher;
  discord?: {
    publicKey: string;
    commands: DiscordCommandService;
  };
  notificationsConfigured: boolean;
  manualSourceKey: string;
  scheduler?: Pick<DiscoveryScheduler, 'status'>;
  schedulerEnabled?: boolean;
  adzunaCredentials?: { appId: string; appKey: string };
};

const listQuerySchema = z.object({
  reviewStatus: z.string().optional(),
  lifecycleStatus: z.string().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  employer: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
  salaryGate: z.string().optional(),
  minSalary: z.coerce.number().int().min(0).max(1_000_000).optional(),
  maxSalary: z.coerce.number().int().min(0).max(1_000_000).optional(),
  discoveredFrom: z.string().max(40).optional(),
  discoveredTo: z.string().max(40).optional(),
  closingBefore: z.string().max(40).optional(),
  source: z.string().max(120).optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(['score_desc', 'score_asc', 'discovered_desc', 'closing_soon']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

const statusChangeSchema = z.object({
  status: z.enum(reviewStatuses),
  reason: z.string().max(400).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

const manualUrlSchema = z.object({ userId: z.uuid(), url: z.url().startsWith('https://') });
const runSchema = z.object({ userId: z.uuid(), sourceKey: z.string().min(3).max(48) });
const matchSchema = z.object({ userId: z.uuid() });
const pauseSchema = z.object({ reason: z.string().max(200).optional() });
const enabledSchema = z.object({ enabled: z.boolean(), reason: z.string().max(200).optional() });
const manualUrlListSchema = z.object({
  urls: z.array(z.url().startsWith('https://')).max(200),
});

function splitList(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
}

function toFilter(userId: string, query: z.infer<typeof listQuerySchema>): TrackerFilter {
  const review = splitList(query.reviewStatus).filter((value): value is ReviewStatus =>
    (reviewStatuses as readonly string[]).includes(value),
  );
  const lifecycle = splitList(query.lifecycleStatus).filter((value): value is LifecycleStatus =>
    (lifecycleStatuses as readonly string[]).includes(value),
  );
  const gates = splitList(query.salaryGate).filter(
    (value): value is 'pass' | 'reject' | 'unknown' =>
      value === 'pass' || value === 'reject' || value === 'unknown',
  );
  const sources = splitList(query.source);
  return {
    userId,
    ...(review.length > 0 ? { reviewStatuses: review } : {}),
    ...(lifecycle.length > 0 ? { lifecycleStatuses: lifecycle } : {}),
    ...(query.minScore === undefined ? {} : { minScore: query.minScore }),
    ...(query.maxScore === undefined ? {} : { maxScore: query.maxScore }),
    ...(query.employer === undefined ? {} : { employer: query.employer }),
    ...(query.location === undefined ? {} : { location: query.location }),
    ...(gates.length > 0 ? { salaryGates: gates } : {}),
    ...(query.minSalary === undefined ? {} : { minSalaryMinor: query.minSalary * 100 }),
    ...(query.maxSalary === undefined ? {} : { maxSalaryMinor: query.maxSalary * 100 }),
    ...(query.discoveredFrom === undefined ? {} : { discoveredFrom: query.discoveredFrom }),
    ...(query.discoveredTo === undefined ? {} : { discoveredTo: query.discoveredTo }),
    ...(query.closingBefore === undefined ? {} : { closingBefore: query.closingBefore }),
    ...(sources.length > 0 ? { sourceKeys: sources } : {}),
    ...(query.q === undefined ? {} : { query: query.q }),
    ...(query.sort === undefined ? {} : { sort: query.sort }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.offset === undefined ? {} : { offset: query.offset }),
  };
}

function sourceAdminFor(runtime: TrackingRuntime): SourceAdminService {
  return new SourceAdminService({
    stores: runtime.stores,
    sitePolicyFor: runtime.sitePolicyFor,
  });
}

function discoveryServiceFor(runtime: TrackingRuntime, userId: string): DiscoveryService {
  return new DiscoveryService({
    stores: runtime.stores,
    userId,
    ...(runtime.adzunaCredentials === undefined
      ? {}
      : { adzunaCredentials: runtime.adzunaCredentials }),
    sitePolicyFor: runtime.sitePolicyFor,
    ...(runtime.fetcher === undefined ? {} : { fetcher: runtime.fetcher }),
    ...(runtime.scanner === undefined ? {} : { scanner: runtime.scanner }),
  });
}

function rawBodyOf(request: FastifyRequest): string {
  const carrier = request as FastifyRequest & { rawBody?: string };
  return carrier.rawBody ?? '';
}

export function registerTrackerRoutes(
  app: FastifyInstance,
  runtime: TrackingRuntime,
  profileService: ProfileService,
): void {
  app.get<{ Params: { userId: string }; Querystring: Record<string, string> }>(
    '/v1/tracker/:userId/jobs',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const query = listQuerySchema.safeParse(request.query);
      if (!userId.success || !query.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const page = await runtime.stores.tracking.list(toFilter(userId.data, query.data));
      const counts = await runtime.stores.tracking.counts(userId.data);
      return reply.header('cache-control', 'no-store').send({
        applicationActionsEnabled: false,
        counts,
        total: page.total,
        jobs: page.jobs,
      });
    },
  );

  app.get<{ Params: { userId: string; jobId: string } }>(
    '/v1/tracker/:userId/jobs/:jobId',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const jobId = z.uuid().safeParse(request.params.jobId);
      if (!userId.success || !jobId.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const detail = await runtime.stores.tracking.detail(userId.data, jobId.data);
      if (detail === null) return reply.code(404).send({ error: 'not_found' });
      return reply.header('cache-control', 'no-store').send({
        ...detail,
        allowedNextStatuses: reviewTransitionsFrom(detail.reviewStatus),
      });
    },
  );

  app.post<{ Params: { userId: string; jobId: string } }>(
    '/v1/tracker/:userId/jobs/:jobId/status',
    async (request, reply) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const jobId = z.uuid().safeParse(request.params.jobId);
      const body = statusChangeSchema.safeParse(request.body);
      if (!userId.success || !jobId.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const correlationId = newCorrelationId();
      try {
        const record = await runtime.stores.tracking.changeReviewStatus({
          userId: userId.data,
          jobId: jobId.data,
          to: body.data.status,
          actor: 'user',
          decidedBy: 'user',
          reason: body.data.reason ?? 'changed on the tracker page',
          correlationId,
          ...(body.data.expectedVersion === undefined
            ? {}
            : { expectedVersion: body.data.expectedVersion }),
          now: new Date(),
        });
        await runtime.stores.audit.append(
          {
            userId: userId.data,
            actorType: 'user',
            actorId: null,
            action: 'tracker.status_changed',
            resourceType: 'job',
            resourceId: jobId.data,
            result: 'succeeded',
            policyVersion: null,
            correlationId,
            metadata: { status: body.data.status },
          },
          new Date(),
        );
        return await reply.send({
          reviewStatus: record.reviewStatus,
          lifecycleStatus: record.lifecycleStatus,
          version: record.version,
          allowedNextStatuses: reviewTransitionsFrom(record.reviewStatus),
        });
      } catch (error) {
        return await reply.code(409).send({
          error: 'status_change_rejected',
          message: error instanceof Error ? error.message : 'That change was not allowed.',
        });
      }
    },
  );

  app.get('/v1/sources', async (_request, reply) => {
    const sources = await runtime.stores.sources.list();
    const policies = await runtime.listSitePolicies();
    const now = new Date();
    return reply.header('cache-control', 'no-store').send({
      supportedDomains: supportedDiscoveryDomains(),
      sources,
      sitePolicies: policies.map((policy) => ({
        domain: policy.domain,
        discoveryMode: policy.discoveryMode,
        applyMode: policy.applyMode,
        termsStatus: policy.termsStatus,
        reviewExpiresAt: policy.reviewExpiresAt,
        decision: evaluateSitePolicy(policy, now).decision,
      })),
    });
  });

  app.post('/v1/sources', async (request, reply) => {
    const parsed = sourceDefinitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_source', issues: parsed.error.issues });
    }
    const definition: SourceDefinition = parsed.data;
    try {
      const saved = await sourceAdminFor(runtime).upsertDefinition(definition, new Date());
      return await reply.code(201).send({ ...saved.source, warnings: saved.warnings });
    } catch (error) {
      if (error instanceof SourceEnableRefusedError) {
        return await reply
          .code(409)
          .send({ error: 'source_not_permitted', reason: error.reason, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { sourceKey: string } }>(
    '/v1/sources/:sourceKey/enabled',
    async (request, reply) => {
      const body = enabledSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const correlationId = newCorrelationId();
      const now = new Date();
      try {
        const result = await sourceAdminFor(runtime).setEnabled({
          sourceKey: request.params.sourceKey,
          enabled: body.data.enabled,
          reason: body.data.reason ?? null,
          now,
        });
        await runtime.stores.audit.append(
          {
            userId: null,
            actorType: 'user',
            actorId: null,
            action: body.data.enabled ? 'source.enabled' : 'source.disabled',
            resourceType: 'source',
            resourceId: request.params.sourceKey,
            result: 'allowed',
            policyVersion: null,
            correlationId,
            metadata: { warnings: result.warnings },
          },
          now,
        );
        return await reply.send({ ...result.source, warnings: result.warnings });
      } catch (error) {
        if (error instanceof SourceEnableRefusedError) {
          await runtime.stores.audit.append(
            {
              userId: null,
              actorType: 'user',
              actorId: null,
              action: 'source.enable_refused',
              resourceType: 'source',
              resourceId: request.params.sourceKey,
              result: 'denied',
              policyVersion: null,
              correlationId,
              metadata: { reason: error.reason },
            },
            now,
          );
          return await reply
            .code(error.reason === 'source_not_found' ? 404 : 409)
            .send({ error: 'source_not_permitted', reason: error.reason, message: error.message });
        }
        throw error;
      }
    },
  );

  app.put<{ Params: { sourceKey: string } }>(
    '/v1/sources/:sourceKey/urls',
    async (request, reply) => {
      const body = manualUrlListSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        const record = await runtime.stores.sources.setManualUrls(
          request.params.sourceKey,
          body.data.urls,
        );
        return await reply.send(record);
      } catch {
        return await reply.code(404).send({ error: 'source_not_found' });
      }
    },
  );

  app.post('/v1/discovery/runs', async (request, reply) => {
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const summary = await discoveryServiceFor(runtime, parsed.data.userId).runSource({
      sourceKey: parsed.data.sourceKey,
      trigger: 'manual',
    });
    return reply.send(summary);
  });

  app.post('/v1/discovery/manual-url', async (request, reply) => {
    const parsed = manualUrlSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const correlationId = newCorrelationId();
    try {
      const source = await runtime.stores.sources.getByKey(runtime.manualSourceKey);
      if (source !== null && !source.manualUrls.includes(parsed.data.url)) {
        await runtime.stores.sources.setManualUrls(runtime.manualSourceKey, [
          ...source.manualUrls,
          parsed.data.url,
        ]);
      }
      const ingested = await discoveryServiceFor(runtime, parsed.data.userId).ingestManualUrl({
        sourceKey: runtime.manualSourceKey,
        url: parsed.data.url,
        correlationId,
      });
      if (ingested.status !== 'ingested' || ingested.jobId === null) {
        return await reply.send({
          ...ingested,
          applicationActionsEnabled: false,
          match: { state: 'not_scored' },
        });
      }

      // The same request scores the advert, so adding a link is one step for the user.
      const facts = await profileService.listFacts(parsed.data.userId);
      const missingCategories = findMissingProfileCategories(facts);
      if (missingCategories.length > 0) {
        return await reply.send({
          ...ingested,
          applicationActionsEnabled: false,
          match: { state: 'profile_incomplete', missingCategories },
        });
      }

      const decision = await new JobMatchService({
        stores: runtime.stores,
        userId: parsed.data.userId,
      }).matchJob({ jobId: ingested.jobId, facts, correlationId });
      const detail = await runtime.stores.tracking.detail(parsed.data.userId, ingested.jobId);
      if (decision === null || detail === null) {
        return await reply.send({
          ...ingested,
          applicationActionsEnabled: false,
          match: { state: 'not_scored' },
        });
      }
      const published =
        runtime.publisher === undefined ? null : await runtime.publisher.publishBatch();
      return await reply.header('cache-control', 'no-store').send({
        ...ingested,
        applicationActionsEnabled: false,
        job: {
          jobId: detail.jobId,
          title: detail.title,
          employer: detail.employer,
          location: detail.location,
          url: detail.canonicalUrl,
          salaryMinMinor: detail.salaryMinMinor,
          salaryMaxMinor: detail.salaryMaxMinor,
          closesAt: detail.closesAt,
        },
        match: {
          state: 'decided',
          reused: decision.reused,
          action: decision.matchRun.action,
          score: decision.matchRun.score,
          salaryGate: decision.matchRun.salaryGate,
          reviewStatus: decision.reviewStatus,
          lifecycleStatus: detail.lifecycleStatus,
          unknownRequirements: decision.unknownRequirements,
          reasons: decision.matchRun.explanation.explanation,
          hardRejectReasons: decision.matchRun.explanation.hardRejectReasons,
          autoBlockers: decision.matchRun.explanation.autoBlockers,
          requirements: decision.matchRun.explanation.requirements.map((requirement) => ({
            text: requirement.text,
            outcome: requirement.outcome,
          })),
        },
        notifications: published,
      });
    } catch (error) {
      return await reply.code(400).send({
        error: 'job_ingest_failed',
        message: error instanceof Error ? error.message : 'The vacancy could not be read.',
      });
    }
  });

  app.post('/v1/match/run', async (request, reply) => {
    const parsed = matchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const facts = await profileService.listFacts(parsed.data.userId);
    const summary = await new JobMatchService({
      stores: runtime.stores,
      userId: parsed.data.userId,
    }).matchAwaiting({ facts });
    const published =
      runtime.publisher === undefined ? null : await runtime.publisher.publishBatch();
    return reply.send({ ...summary, notifications: published });
  });

  app.get('/v1/agent/status', async (_request, reply) => {
    const now = new Date();
    const runtimeState = await runtime.stores.runtime.get();
    const sources = await runtime.stores.sources.list();
    const runs = await runtime.stores.discoveryRuns.recent(5);
    const deadLetters = await runtime.stores.outbox.deadLetters(10);
    const schedulerStatus = runtime.scheduler?.status() ?? null;
    return reply.header('cache-control', 'no-store').send({
      paused: runtimeState.paused,
      pausedReason: runtimeState.pausedReason,
      notificationsConfigured: runtime.notificationsConfigured,
      applicationActionsEnabled: false,
      autoSubmitEnabled: false,
      scheduler: {
        configured: runtime.schedulerEnabled ?? false,
        started: schedulerStatus?.started ?? false,
        ready: schedulerStatus?.ready ?? false,
        enabledSources: schedulerStatus?.enabledSources ?? 0,
        lastCheckedAt: schedulerStatus?.lastCheckedAt ?? null,
        lastRanAt: schedulerStatus?.lastRanAt ?? null,
        problems: schedulerStatus?.problems ?? [],
      },
      sources: sources.map((source) => ({
        sourceKey: source.sourceKey,
        displayName: source.displayName,
        enabled: source.enabled,
        nextRunAt: source.nextRunAt,
        lastSuccessAt: source.lastSuccessAt,
        lastErrorCode: source.lastErrorCode,
        consecutiveFailures: source.consecutiveFailures,
        circuitOpenUntil: source.circuitOpenUntil,
      })),
      recentRuns: runs,
      pendingNotifications: await runtime.stores.outbox.pendingCount(now),
      undeliverableNotifications: deadLetters.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        lastErrorCode: event.lastErrorCode,
        deadLetteredAt: event.deadLetteredAt,
      })),
    });
  });

  app.post('/v1/agent/pause', async (request, reply) => {
    const body = pauseSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const state = await runtime.stores.runtime.setPaused(
      true,
      body.data.reason ?? 'paused by the user',
      new Date(),
    );
    return reply.send(state);
  });

  app.post('/v1/agent/resume', async (_request, reply) => {
    const state = await runtime.stores.runtime.setPaused(false, null, new Date());
    return reply.send(state);
  });

  app.post('/v1/discord/interactions', async (request, reply) => {
    const discord = runtime.discord;
    if (discord === undefined) {
      return reply.code(503).send({ error: 'discord_not_configured' });
    }
    const verification = verifyInteractionSignature({
      publicKeyHex: discord.publicKey,
      signatureHex: request.headers['x-signature-ed25519'] as string | undefined,
      timestamp: request.headers['x-signature-timestamp'] as string | undefined,
      rawBody: rawBodyOf(request),
    });
    if (!verification.valid) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    const outcome = await discord.commands.handle({ rawBody: rawBodyOf(request) });
    return reply.code(outcome.httpStatus).send(outcome.body);
  });
}
