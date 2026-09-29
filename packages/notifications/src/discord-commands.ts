import { newCorrelationId } from '@job-agent/observability';
import type { ReviewStatus, ShortlistAssessment, TrackingStores } from '@job-agent/tracking';
import { groupByShortlistBand, reviewStatuses, shortlistBandLabels } from '@job-agent/tracking';

import type { ApplicationCommandPort } from './application-port.js';
import type { EmailApplicationCommandPort } from './email-application-port.js';
import {
  ephemeralReply,
  interactionPayloadHash,
  InteractionType,
  parseInteraction,
  pong,
  type ParsedInteraction,
} from './discord-interactions.js';

export type DiscordCommandOptions = {
  stores: TrackingStores;
  userId: string;
  allowedDiscordUserId: string;
  allowedChannelId?: string | null;
  /** Present only once Phase 2 is wired in. Without it the application commands say so. */
  applications?: ApplicationCommandPort;
  /**
   * Present only when applying by email is configured. Without it `/apply` says so and can do
   * nothing, which is what a deployment with no email provider should look like.
   */
  emailApplications?: EmailApplicationCommandPort;
};

export type InteractionOutcome = {
  httpStatus: number;
  body: Record<string, unknown>;
};

function money(minor: number | null): string {
  return minor === null ? 'not stated' : `£${Math.round(minor / 100).toLocaleString('en-GB')}`;
}

/** How much of the advert the agent could judge, in a few words. */
function checkedPhrase(assessment: ShortlistAssessment): string {
  if (assessment.criteriaSeen === 0) return 'no requirements read';
  return `${String(assessment.criteriaChecked)}/${String(assessment.criteriaSeen)} requirements checked`;
}

function isReviewStatus(value: string): value is ReviewStatus {
  return (reviewStatuses as readonly string[]).includes(value);
}

/**
 * Read and workflow-intent commands only. Nothing here can start an application, fill a form or
 * submit anything: those capabilities exist only behind the approval and submit guard, and only
 * against the local fake ATS.
 */
export class DiscordCommandService {
  constructor(private readonly options: DiscordCommandOptions) {}

  async handle(input: { rawBody: string; now?: Date }): Promise<InteractionOutcome> {
    const now = input.now ?? new Date();
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(input.rawBody);
    } catch {
      return { httpStatus: 400, body: { error: 'invalid_json' } };
    }
    const interaction = parseInteraction(parsedBody);
    if (interaction === null) return { httpStatus: 400, body: { error: 'invalid_interaction' } };
    if (interaction.type === InteractionType.Ping) return { httpStatus: 200, body: pong() };

    if (interaction.userId !== this.options.allowedDiscordUserId) {
      return {
        httpStatus: 200,
        body: ephemeralReply('This job agent only takes commands from its owner.'),
      };
    }
    const allowedChannel = this.options.allowedChannelId;
    if (
      allowedChannel !== undefined &&
      allowedChannel !== null &&
      allowedChannel !== '' &&
      interaction.channelId !== allowedChannel
    ) {
      return {
        httpStatus: 200,
        body: ephemeralReply('This job agent only takes commands in its own channel.'),
      };
    }

    const fresh = await this.options.stores.inbox.claim(
      'discord',
      interaction.id,
      interactionPayloadHash(input.rawBody),
      now,
    );
    if (!fresh) {
      return {
        httpStatus: 200,
        body: ephemeralReply('That command was already handled. Nothing was repeated.'),
      };
    }

    const content = await this.route(interaction, now);
    return { httpStatus: 200, body: ephemeralReply(content) };
  }

  private async route(interaction: ParsedInteraction, now: Date): Promise<string> {
    const { commandName, subCommand, options } = interaction;
    if (commandName === 'agent') return this.agentCommand(subCommand, now);
    if (commandName === 'jobs') return this.jobsCommand(subCommand, options);
    if (commandName === 'job') return this.jobCommand(subCommand, options, now);
    if (commandName === 'application') {
      return this.applicationCommand(subCommand, options, interaction.id);
    }
    if (commandName === 'apply') return this.applyCommand(subCommand, options, interaction.id);
    return 'Unknown command. Try /jobs list, /job show, /apply check, /agent status.';
  }

  /**
   * Applying to an employer by email, for vacancies whose advert asks for that.
   *
   * `approve` is the only command anywhere in this surface that causes something to leave the
   * machine. It requires the review reference the person was shown, so approving without having
   * read the message is not possible, and the interaction id makes a replayed approval harmless.
   */
  private async applyCommand(
    subCommand: string | null,
    options: Record<string, string>,
    interactionId: string,
  ): Promise<string> {
    const port = this.options.emailApplications;
    if (port === undefined) {
      return 'Applying by email is not configured in this build, so there is nothing to send.';
    }

    if (subCommand === 'list') {
      const applications = await port.list(10);
      if (applications.length === 0) return 'No email applications have been prepared.';
      return [
        'Email applications:',
        ...applications.map(
          (application) =>
            `• ${application.jobTitle} — ${application.employer} — ${application.state.replace(/_/g, ' ')}${
              application.providerReference === null
                ? ''
                : ` — reference ${application.providerReference}`
            } — id ${application.jobId.slice(0, 8)}`,
        ),
      ].join('\n');
    }

    const jobIdPrefix = options.id ?? '';
    if (jobIdPrefix.length < 6) {
      return 'Give me the job id shown in /jobs list, for example /apply check id:1a2b3c4d.';
    }

    if (subCommand === 'check') return (await port.check(jobIdPrefix)).message;
    if (subCommand === 'status') return (await port.status(jobIdPrefix)).message;

    if (subCommand === 'prepare') {
      const result = await port.prepare({
        jobIdPrefix,
        overrideSalaryFloor: (options.override_salary ?? 'false').toLowerCase() === 'true',
        requestId: interactionId,
      });
      return result.message;
    }

    if (subCommand === 'approve') {
      const manifest = options.manifest ?? '';
      if (manifest.length < 8) {
        return 'Include the review reference shown with the message, for example manifest:9f2c1ab4d0e1. Approving without it is refused.';
      }
      const result = await port.approve({
        jobIdPrefix,
        manifestHashPrefix: manifest,
        requestId: interactionId,
      });
      return result.message;
    }

    if (subCommand === 'reject') {
      const result = await port.reject({
        jobIdPrefix,
        reason: options.reason ?? null,
        requestId: interactionId,
      });
      return result.message;
    }

    if (subCommand === 'reconcile') {
      const outcome = (options.outcome ?? '').toLowerCase();
      if (outcome !== 'sent' && outcome !== 'not_sent') {
        return 'Say what you found: outcome:sent or outcome:not_sent.';
      }
      const result = await port.reconcile({
        jobIdPrefix,
        outcome,
        providerReference: options.reference ?? null,
        requestId: interactionId,
      });
      return result.message;
    }

    return 'Try /apply check, prepare, approve, reject, status, reconcile or list.';
  }

  private async applicationCommand(
    subCommand: string | null,
    options: Record<string, string>,
    interactionId: string,
  ): Promise<string> {
    const port = this.options.applications;
    if (port === undefined) {
      return 'Application commands are not available in this build.';
    }

    if (subCommand === 'list') {
      const applications = await port.list(10);
      if (applications.length === 0) return 'No practice applications are in progress.';
      return [
        'Practice applications on the local fake ATS (nothing is sent to an employer):',
        ...applications.map(
          (application) =>
            `• ${application.jobTitle} — ${application.employer} — ${application.stage}${
              application.openQuestions > 0
                ? ` — ${String(application.openQuestions)} question(s) for you`
                : ''
            } — id ${application.applicationId.slice(0, 8)}`,
        ),
      ].join('\n');
    }

    const idPrefix = options.id ?? '';
    if (idPrefix.length < 6) {
      return 'Give me the application id shown in /application list, for example /application show id:1a2b3c4d.';
    }

    if (subCommand === 'show') {
      const summary = await port.show(idPrefix);
      if (summary === null) return 'I could not find an application with that id.';
      return [
        `${summary.jobTitle} — ${summary.employer}`,
        `Stage: ${summary.stage}${summary.pauseReason === null ? '' : ` (paused: ${summary.pauseReason})`}`,
        `Questions waiting for you: ${String(summary.openQuestions)}`,
        summary.manifestHashPrefix === null
          ? 'No review manifest yet.'
          : `Review manifest: ${summary.manifestHashPrefix} (approval: ${summary.approvalState})`,
        summary.takeoverRequested ? 'You have taken over this application.' : '',
        summary.confirmationReference === null
          ? 'Not submitted.'
          : `Fake confirmation reference: ${summary.confirmationReference}`,
        'This is the local fake ATS. No real employer is involved.',
      ]
        .filter((line) => line !== '')
        .join('\n');
    }

    if (subCommand === 'question') {
      const question = await port.currentQuestion(idPrefix);
      if (question === null) return 'Nothing is waiting for you on that application.';
      return [
        `Question (${question.reason.replace(/_/g, ' ')}):`,
        question.prompt,
        question.allowedValues.length > 0
          ? `Allowed answers: ${question.allowedValues.join(', ')}`
          : `Answer type: ${question.responseKind}`,
        question.responseKind === 'human_action'
          ? 'This one has to be done by you in the browser; the agent will not answer it.'
          : `Reply with /application answer id:${idPrefix} value:<your answer>`,
      ].join('\n');
    }

    if (subCommand === 'answer') {
      const value = options.value ?? '';
      if (value.trim() === '') return 'Include the answer, for example value:Permanent.';
      const result = await port.answer({
        idPrefix,
        value,
        saveToProfile: (options.save ?? 'false').toLowerCase() === 'true',
        interactionId,
      });
      return result.message;
    }

    if (subCommand === 'approve' || subCommand === 'reject') {
      const hashPrefix = options.manifest ?? '';
      if (subCommand === 'approve' && hashPrefix.length < 8) {
        return 'Include the review manifest reference shown on the review screen, for example manifest:9f2c1ab4d0e1.';
      }
      const result = await port.decide({
        idPrefix,
        decision: subCommand === 'approve' ? 'approved' : 'rejected',
        manifestHashPrefix: hashPrefix,
        reason: options.reason ?? null,
        interactionId,
      });
      return result.message;
    }

    if (subCommand === 'takeover') return (await port.requestTakeover(idPrefix)).message;
    if (subCommand === 'resume') return (await port.resume(idPrefix)).message;

    return 'Try /application list, show, question, answer, approve, reject, takeover or resume.';
  }

  private async agentCommand(subCommand: string | null, now: Date): Promise<string> {
    const { stores } = this.options;
    if (subCommand === 'pause') {
      const state = await stores.runtime.setPaused(true, 'paused_from_discord', now);
      await stores.outbox.enqueue(
        {
          eventType: 'AGENT_PAUSED',
          channel: 'discord',
          dedupeKey: `agent_paused:${state.updatedAt}`,
          correlationId: newCorrelationId(),
          payload: { reason: 'paused from Discord' },
        },
        now,
      );
      return 'Paused. Scheduled job searching and notifications are stopped until you resume.';
    }
    if (subCommand === 'resume') {
      await stores.runtime.setPaused(false, null, now);
      return 'Resumed. Scheduled job searching will run again at the next due time.';
    }
    const state = await stores.runtime.get();
    const counts = await stores.tracking.counts(this.options.userId);
    const pending = await stores.outbox.pendingCount(now);
    const deadLetters = await stores.outbox.deadLetters(5);
    const runs = await stores.discoveryRuns.recent(3);
    return [
      state.paused ? 'Status: paused' : 'Status: running',
      `Shortlisted ${String(counts.shortlisted)}, reviewed ${String(counts.reviewed)}, new ${String(counts.discovered)}, rejected ${String(counts.rejected)}, archived ${String(counts.archived)}`,
      `Messages waiting to send: ${String(pending)}; undeliverable: ${String(deadLetters.length)}`,
      runs.length === 0
        ? 'No job searches have run yet.'
        : `Last search: ${runs[0]?.sourceKey ?? 'unknown'} — ${runs[0]?.status ?? 'unknown'}`,
      'Real applications and automatic submission are disabled. Practice runs use the local fake ATS only.',
    ].join('\n');
  }

  private async jobsCommand(
    subCommand: string | null,
    options: Record<string, string>,
  ): Promise<string> {
    if (subCommand === 'discover') {
      return 'On-demand searching is started from the tracker page. Use /agent status to check the schedule.';
    }
    const statusOption = options.status ?? 'shortlisted';
    const statuses: ReviewStatus[] = isReviewStatus(statusOption)
      ? [statusOption]
      : ['shortlisted'];
    const page = await this.options.stores.tracking.list({
      userId: this.options.userId,
      reviewStatuses: statuses,
      limit: 10,
      sort: 'score_desc',
    });
    if (page.jobs.length === 0) return `No ${statuses[0] ?? 'shortlisted'} jobs right now.`;
    // Grouped by what the agent could establish, not ranked by score. The 2026-09-29 review found
    // every real advert scoring inside a 17-point band, so a list in score order implied an
    // ordering that was not there.
    const groups = groupByShortlistBand(page.jobs, (job) => job.assessment.band);
    const lines = groups.flatMap((group) => [
      `**${group.label}** (${String(group.entries.length)})`,
      ...group.entries.map(
        (job) =>
          `• ${job.title} — ${job.employer} (${job.location}) — ${checkedPhrase(job.assessment)} — id ${job.jobId.slice(0, 8)}`,
      ),
    ]);
    return [`${String(page.total)} ${statuses[0] ?? 'shortlisted'} job(s):`, ...lines].join('\n');
  }

  private async jobCommand(
    subCommand: string | null,
    options: Record<string, string>,
    now: Date,
  ): Promise<string> {
    const idPrefix = options.id ?? '';
    if (idPrefix.length < 6)
      return 'Give me the job id shown in the list, for example /job show id:1a2b3c4d.';
    const page = await this.options.stores.tracking.list({
      userId: this.options.userId,
      limit: 200,
    });
    const job = page.jobs.find((candidate) => candidate.jobId.startsWith(idPrefix));
    if (job === undefined) return 'I could not find a job with that id.';

    if (subCommand === 'show') {
      const detail = await this.options.stores.tracking.detail(this.options.userId, job.jobId);
      const unknowns =
        detail?.matchRun?.explanation.requirements.filter(
          (requirement) => requirement.outcome === 'unknown',
        ).length ?? 0;
      return [
        `${job.title} — ${job.employer}`,
        `Location: ${job.location}`,
        `Salary: ${money(job.salaryMinMinor)} to ${money(job.salaryMaxMinor)} (${job.salaryGate ?? 'unknown'})`,
        `${shortlistBandLabels[job.assessment.band]}: ${job.assessment.summary}`,
        `Status: ${job.reviewStatus} (${job.lifecycleStatus})`,
        unknowns > 0
          ? `${String(unknowns)} requirement(s) the agent could not judge are listed on the tracker page.`
          : '',
        // Kept, and kept last: it does not separate adverts well enough to lead with.
        `Score: ${job.score === null ? 'not scored' : String(job.score)}/100`,
        job.canonicalUrl,
      ]
        .filter((line) => line !== '')
        .join('\n');
    }

    if (subCommand === 'apply') {
      return 'Applying to a real employer is not enabled. Practice runs happen on the local fake ATS only, and you start those from the applications page.';
    }

    const target: ReviewStatus | null =
      subCommand === 'shortlist'
        ? 'shortlisted'
        : subCommand === 'reject'
          ? 'rejected'
          : subCommand === 'reviewed'
            ? 'reviewed'
            : subCommand === 'archive'
              ? 'archived'
              : null;
    if (target === null)
      return 'Try /job show, /job shortlist, /job reject, /job reviewed or /job archive.';

    const before = job.reviewStatus;
    let after: ReviewStatus;
    try {
      const record = await this.options.stores.tracking.changeReviewStatus({
        userId: this.options.userId,
        jobId: job.jobId,
        to: target,
        actor: 'user',
        decidedBy: 'user',
        reason: options.reason ?? 'set from Discord',
        correlationId: newCorrelationId(),
        now,
      });
      after = record.reviewStatus;
    } catch (error) {
      return error instanceof Error ? error.message : 'That change was not allowed.';
    }
    // Reports what actually changed. Saying "marked as shortlisted" for a job that was already
    // shortlisted reads as a change that did not happen, which is how a no-op looks like a bug.
    if (after === before) {
      return `"${job.title}" was already ${before}, so its status has not changed. Nothing was sent to the employer.`;
    }
    return `Moved "${job.title}" from ${before} to ${after}. This only updates your tracker; nothing was sent to the employer.`;
  }
}
