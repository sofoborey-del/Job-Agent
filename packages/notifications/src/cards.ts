import { redact } from '@job-agent/observability';
import type { OutboxEventRecord } from '@job-agent/tracking';

export type NotificationCard = {
  title: string;
  lines: string[];
  url: string | null;
  severity: 'info' | 'warning' | 'error';
};

/**
 * Fields that may appear in a notification. Anything not on this list is dropped, which is what
 * keeps applicant data out of a third-party chat service.
 */
const allowedPayloadKeys = new Set([
  'jobId',
  'title',
  'employer',
  'location',
  'url',
  'score',
  'salaryGate',
  'salaryText',
  'closesAt',
  'action',
  'blockers',
  'unknownRequirements',
  'source',
  'sourceKey',
  'errorCode',
  'circuitOpened',
  'reason',
  'counts',
  'pending',
  'deadLettered',
]);

export function safePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedPayloadKeys.has(key)) continue;
    output[key] = redact(value);
  }
  return output;
}

function text(value: unknown, fallback = 'not stated'): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function salaryLine(payload: Record<string, unknown>): string {
  const gate = text(payload.salaryGate, 'unknown');
  const stated = text(payload.salaryText, 'no salary stated');
  if (gate === 'pass') return `Salary: ${stated} (meets your minimum)`;
  if (gate === 'reject') return `Salary: ${stated} (below your minimum)`;
  return `Salary: ${stated} (not certain, so nothing automatic can happen)`;
}

function jobMatchedCard(payload: Record<string, unknown>): NotificationCard {
  const score = typeof payload.score === 'number' ? payload.score : null;
  const unknownCount =
    typeof payload.unknownRequirements === 'number' ? payload.unknownRequirements : 0;
  const blockers = Array.isArray(payload.blockers)
    ? payload.blockers.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    title: `Possible match: ${text(payload.title, 'a role')} at ${text(payload.employer, 'an employer')}`,
    lines: [
      `Location: ${text(payload.location)}`,
      `Match score: ${score === null ? 'not scored' : `${String(score)}/100`}`,
      salaryLine(payload),
      unknownCount > 0
        ? `${String(unknownCount)} essential requirement${unknownCount === 1 ? '' : 's'} could not be confirmed from your profile, so this needs your review.`
        : 'Every essential requirement was matched to verified profile evidence.',
      blockers.length > 0 ? `Blocked from anything automatic by: ${blockers.join(', ')}` : '',
      'Nothing has been applied for. This is a shortlist notice only.',
    ].filter((line) => line !== ''),
    url: typeof payload.url === 'string' ? payload.url : null,
    severity: 'info',
  };
}

function discoveryFailedCard(payload: Record<string, unknown>): NotificationCard {
  return {
    title: `Job search problem: ${text(payload.source, 'a source')}`,
    lines: [
      `Reason code: ${text(payload.errorCode, 'unknown')}`,
      payload.circuitOpened === true
        ? 'This source has been paused for an hour after repeated failures.'
        : 'It will be retried on the next scheduled run.',
      'No applications or messages were sent.',
    ],
    url: null,
    severity: payload.circuitOpened === true ? 'error' : 'warning',
  };
}

function agentPausedCard(payload: Record<string, unknown>): NotificationCard {
  return {
    title: 'Job agent paused',
    lines: [
      `Reason: ${text(payload.reason, 'requested by you')}`,
      'Scheduled discovery and notifications are stopped until you resume it.',
    ],
    url: null,
    severity: 'warning',
  };
}

function agentResumedCard(): NotificationCard {
  return {
    title: 'Job agent resumed',
    lines: ['Scheduled discovery is running again.'],
    url: null,
    severity: 'info',
  };
}

function genericCard(eventType: string, payload: Record<string, unknown>): NotificationCard {
  return {
    title: eventType.replace(/_/g, ' ').toLowerCase(),
    lines: Object.entries(payload).map(([key, value]) => `${key}: ${String(value)}`),
    url: null,
    severity: 'info',
  };
}

export function buildCard(
  event: Pick<OutboxEventRecord, 'eventType' | 'payload'>,
): NotificationCard {
  const payload = safePayload(event.payload);
  switch (event.eventType) {
    case 'JOB_MATCHED':
      return jobMatchedCard(payload);
    case 'DISCOVERY_FAILED':
      return discoveryFailedCard(payload);
    case 'AGENT_PAUSED':
      return agentPausedCard(payload);
    case 'AGENT_RESUMED':
      return agentResumedCard();
    default:
      return genericCard(event.eventType, payload);
  }
}

export function renderCardText(card: NotificationCard): string {
  const prefix = card.severity === 'error' ? '❗ ' : card.severity === 'warning' ? '⚠️ ' : '';
  const body = [`**${prefix}${card.title}**`, ...card.lines];
  if (card.url !== null) body.push(card.url);
  return body.join('\n');
}
