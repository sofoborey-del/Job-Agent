import { defaultAgentConfig, type AgentConfig } from '@job-agent/config';
import type { KnowledgeFact } from '@job-agent/domain';
import { MATCHER_VERSION, shadowMatch, type ShadowJob } from '@job-agent/matching';
import { newCorrelationId, silentLogger, type StructuredLogger } from '@job-agent/observability';

import { matchIdempotencyKey, profileSnapshotHash } from './profile-snapshot.js';
import type { TrackingStores } from './ports.js';
import { automaticReviewStatusFor, mayApplyAutomaticReview, type ReviewStatus } from './state.js';
import type {
  ConfigurationVersionRecord,
  JobAwaitingMatch,
  MatchExplanation,
  MatchRunRecord,
} from './types.js';

export type MatchServiceOptions = {
  stores: TrackingStores;
  userId: string;
  config?: AgentConfig;
  logger?: StructuredLogger;
};

export type MatchSummary = {
  evaluated: number;
  reused: number;
  shortlisted: number;
  rejected: number;
  notified: number;
};

export type SingleMatchResult = {
  matchRun: MatchRunRecord;
  reviewStatus: ReviewStatus;
  reused: boolean;
  notified: boolean;
  unknownRequirements: number;
};

function shadowJobFrom(awaiting: JobAwaitingMatch): ShadowJob {
  const { job } = awaiting;
  return {
    id: awaiting.jobId,
    title: job.title,
    employer: job.employer,
    location: job.location,
    description: job.description,
    descriptionCompleteness: job.descriptionCompleteness ?? 'full',
    salary: job.salary,
    contractType: job.contractType,
    employmentTypes: job.employmentTypes,
    workPattern: job.workPattern,
    closesAt: job.closesAt,
    personSpecification: {
      status: job.personSpecification.status,
      ...(job.personSpecification.text === null ? {} : { text: job.personSpecification.text }),
      ...(job.personSpecification.reason === null
        ? {}
        : { reason: job.personSpecification.reason }),
    },
  };
}

/**
 * Runs the existing deterministic salary, prerequisite, evidence and match policies against
 * verified profile facts, then persists the decision so it can be reproduced later from the
 * recorded job version, profile snapshot, matcher version and configuration version.
 */
export class JobMatchService {
  private readonly config: AgentConfig;
  private readonly logger: StructuredLogger;

  constructor(private readonly options: MatchServiceOptions) {
    this.config = options.config ?? defaultAgentConfig;
    this.logger = options.logger ?? silentLogger;
  }

  /** Scores everything flagged for matching. Safe to call repeatedly. */
  async matchAwaiting(input: {
    facts: readonly KnowledgeFact<unknown>[];
    correlationId?: string;
    now?: Date;
    limit?: number;
  }): Promise<MatchSummary> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    const summary: MatchSummary = {
      evaluated: 0,
      reused: 0,
      shortlisted: 0,
      rejected: 0,
      notified: 0,
    };

    const awaiting = await this.options.stores.tracking.listAwaitingMatch(
      this.options.userId,
      input.limit ?? 50,
    );
    if (awaiting.length === 0) return summary;

    const configVersion = await this.options.stores.configuration.ensureVersion(
      this.config,
      'system',
    );
    const snapshotHash = profileSnapshotHash(input.facts);

    for (const entry of awaiting) {
      const result = await this.evaluate({
        entry,
        facts: input.facts,
        snapshotHash,
        configVersion,
        correlationId,
        now,
      });
      if (result.reused) {
        summary.reused += 1;
        continue;
      }
      summary.evaluated += 1;
      if (result.reviewStatus === 'shortlisted') summary.shortlisted += 1;
      if (result.reviewStatus === 'rejected') summary.rejected += 1;
      if (result.notified) summary.notified += 1;
    }

    return summary;
  }

  /**
   * Scores one tracked job immediately, so adding a vacancy link and seeing its decision is a
   * single step for the user. Returns null when the job is not tracked for this profile.
   */
  async matchJob(input: {
    jobId: string;
    facts: readonly KnowledgeFact<unknown>[];
    correlationId?: string;
    now?: Date;
  }): Promise<SingleMatchResult | null> {
    const now = input.now ?? new Date();
    const entry = await this.options.stores.tracking.getForMatching(
      this.options.userId,
      input.jobId,
    );
    if (entry === null) return null;
    const configVersion = await this.options.stores.configuration.ensureVersion(
      this.config,
      'system',
    );
    return this.evaluate({
      entry,
      facts: input.facts,
      snapshotHash: profileSnapshotHash(input.facts),
      configVersion,
      correlationId: input.correlationId ?? newCorrelationId(),
      now,
    });
  }

  private async evaluate(input: {
    entry: JobAwaitingMatch;
    facts: readonly KnowledgeFact<unknown>[];
    snapshotHash: string;
    configVersion: ConfigurationVersionRecord;
    correlationId: string;
    now: Date;
  }): Promise<SingleMatchResult> {
    const { entry, now, correlationId } = input;
    const { stores } = this.options;
    const idempotencyKey = matchIdempotencyKey({
      userId: this.options.userId,
      jobId: entry.jobId,
      jobVersion: entry.jobVersion,
      profileSnapshotHash: input.snapshotHash,
      matcherVersion: MATCHER_VERSION,
      configHash: input.configVersion.configHash,
    });

    const existing = await stores.matchRuns.findByIdempotencyKey(idempotencyKey);
    if (existing !== null) {
      await stores.tracking.attachMatchRun({
        userId: this.options.userId,
        jobId: entry.jobId,
        matchRunId: existing.id,
        score: existing.score,
        salaryGate: existing.salaryGate,
        now,
      });
      const current = await stores.tracking.get(this.options.userId, entry.jobId);
      return {
        matchRun: existing,
        reviewStatus: current?.reviewStatus ?? entry.reviewStatus,
        reused: true,
        notified: false,
        unknownRequirements: existing.explanation.requirements.filter(
          (requirement) => requirement.outcome === 'unknown',
        ).length,
      };
    }

    const result = shadowMatch(shadowJobFrom(entry), input.facts, this.config, now);
    const requirementIdByText = new Map(
      entry.requirements.map((requirement) => [requirement.text, requirement.id]),
    );
    const explanation: MatchExplanation = {
      hardRejectReasons: result.decision.hardRejectReasons,
      autoBlockers: result.decision.autoBlockers,
      explanation: result.decision.explanation,
      signals: { ...result.signals },
      requirements: result.requirements.map((requirement) => ({
        key: requirement.id,
        text: requirement.text,
        outcome: requirement.outcome,
        confidence: requirement.confidence,
        explanation: requirement.explanation,
        evidenceFactIds: requirement.evidenceFactIds,
      })),
    };
    const requirementMatches = result.requirements
      .map((requirement) => {
        const requirementId = requirementIdByText.get(requirement.text);
        return requirementId === undefined
          ? null
          : {
              requirementId,
              outcome: requirement.outcome,
              evidenceFactIds: requirement.evidenceFactIds,
              confidence: requirement.confidence,
              explanation: requirement.explanation,
            };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    const matchRun = await stores.matchRuns.insert({
      userId: this.options.userId,
      jobId: entry.jobId,
      jobVersion: entry.jobVersion,
      idempotencyKey,
      matcherVersion: MATCHER_VERSION,
      policyVersion: input.configVersion.configHash.slice(0, 12),
      profileSnapshotHash: input.snapshotHash,
      configVersionId: input.configVersion.id,
      discoveryRunId: null,
      correlationId,
      action: result.decision.action,
      score: result.decision.score,
      evidenceCoverage: result.decision.evidenceCoverage,
      decisionConfidence: result.decision.decisionConfidence,
      salaryGate: result.salaryGate,
      hardGateResult: result.decision.hardRejectReasons.length > 0 ? 'failed' : 'passed',
      explanation,
      requirementMatches,
      now,
    });

    await stores.tracking.attachMatchRun({
      userId: this.options.userId,
      jobId: entry.jobId,
      matchRunId: matchRun.id,
      score: matchRun.score,
      salaryGate: matchRun.salaryGate,
      now,
    });

    const automatic = automaticReviewStatusFor(result.decision.action);
    let reviewStatus = entry.reviewStatus;
    if (
      entry.job.descriptionCompleteness !== 'snippet' &&
      mayApplyAutomaticReview(entry.reviewStatus, entry.decidedBy)
    ) {
      const updated = await stores.tracking.changeReviewStatus({
        userId: this.options.userId,
        jobId: entry.jobId,
        to: automatic,
        actor: 'system',
        decidedBy: 'system',
        reason:
          result.decision.hardRejectReasons.length > 0
            ? `hard_gate:${result.decision.hardRejectReasons.join(',')}`
            : `score_${String(matchRun.score)}`,
        correlationId,
        now,
      });
      reviewStatus = updated.reviewStatus;
    }

    const unknownRequirements = explanation.requirements.filter(
      (requirement) => requirement.outcome === 'unknown',
    ).length;

    let notified = false;
    if (automatic === 'shortlisted' && entry.job.descriptionCompleteness !== 'snippet') {
      notified = await stores.outbox.enqueue(
        {
          eventType: 'JOB_MATCHED',
          channel: 'discord',
          dedupeKey: `job_matched:${matchRun.id}`,
          correlationId,
          payload: {
            jobId: entry.jobId,
            title: entry.job.title,
            employer: entry.job.employer,
            location: entry.job.location,
            url: entry.job.canonicalUrl,
            score: matchRun.score,
            salaryGate: matchRun.salaryGate,
            salaryText: entry.job.salary?.sourceText ?? null,
            closesAt: entry.job.closesAt,
            action: matchRun.action,
            blockers: matchRun.explanation.autoBlockers.slice(0, 6),
            unknownRequirements,
          },
        },
        now,
      );
    }

    this.logger.log('info', 'Match decision recorded', {
      jobId: entry.jobId,
      jobVersion: entry.jobVersion,
      action: matchRun.action,
      score: matchRun.score,
      correlationId,
    });

    return { matchRun, reviewStatus, reused: false, notified, unknownRequirements };
  }
}
