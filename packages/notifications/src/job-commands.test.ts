import { describe, expect, it } from 'vitest';

import type { ReviewStatus, TrackingRecord, TrackingStores } from '@job-agent/tracking';
import { assertReviewTransition } from '@job-agent/tracking';

import { DiscordCommandService } from './discord-commands.js';

/**
 * What a tracker command tells you it did.
 *
 * This exists because `/job shortlist` was reported as "not applying". It applies; a job that is
 * already shortlisted simply has nothing to change, and the old reply said "Marked as shortlisted"
 * either way, which reads as a change that did not happen. The reply now states the actual
 * before-and-after, so a no-op is visible as a no-op rather than looking like a defect.
 */

const OWNER = 'discord-owner-1';
const CHANNEL = 'channel-1';
const JOB_ID = '1a2b3c4d-1111-4111-8111-111111111111';

function storesFor(reviewStatus: ReviewStatus): TrackingStores {
  let current = reviewStatus;
  const seen = new Set<string>();
  return {
    inbox: {
      claim: (channel: string, externalId: string) => {
        const key = `${channel}:${externalId}`;
        if (seen.has(key)) return Promise.resolve(false);
        seen.add(key);
        return Promise.resolve(true);
      },
    },
    tracking: {
      list: () =>
        Promise.resolve({
          total: 1,
          jobs: [
            {
              jobId: JOB_ID,
              title: 'Community Support Worker',
              employer: 'Invented Council',
              location: 'Perth',
              reviewStatus: current,
            },
          ],
        }),
      changeReviewStatus: (input: { to: ReviewStatus }) => {
        assertReviewTransition(current, input.to);
        current = input.to;
        return Promise.resolve({ reviewStatus: current } as TrackingRecord);
      },
    },
  } as unknown as TrackingStores;
}

function body(subCommand: string): string {
  return JSON.stringify({
    id: `i-${subCommand}`,
    type: 2,
    channel_id: CHANNEL,
    member: { user: { id: OWNER } },
    data: {
      name: 'job',
      options: [{ type: 1, name: subCommand, options: [{ name: 'id', value: '1a2b3c4d' }] }],
    },
  });
}

function service(reviewStatus: ReviewStatus): DiscordCommandService {
  return new DiscordCommandService({
    stores: storesFor(reviewStatus),
    userId: '00000000-0000-4000-8000-000000000000',
    allowedDiscordUserId: OWNER,
    allowedChannelId: CHANNEL,
  });
}

function replyText(outcome: { body: Record<string, unknown> }): string {
  return (outcome.body.data as { content?: string } | undefined)?.content ?? '';
}

describe('changing a job’s review status from Discord', () => {
  it('reports the move when there is one', async () => {
    const outcome = await service('discovered').handle({ rawBody: body('shortlist') });
    expect(replyText(outcome)).toContain('from discovered to shortlisted');
  });

  it('says plainly that nothing changed when the job was already in that state', async () => {
    const outcome = await service('shortlisted').handle({ rawBody: body('shortlist') });
    expect(replyText(outcome)).toContain('was already shortlisted');
    expect(replyText(outcome)).not.toContain('Moved');
  });

  it('rejects a job that was shortlisted, and says so', async () => {
    const outcome = await service('shortlisted').handle({ rawBody: body('reject') });
    expect(replyText(outcome)).toContain('from shortlisted to rejected');
  });

  it('explains a transition the tracker does not allow', async () => {
    const outcome = await service('archived').handle({ rawBody: body('shortlist') });
    expect(replyText(outcome)).toContain('Cannot move a job from archived to shortlisted');
  });

  it('never suggests anything was sent to an employer', async () => {
    for (const status of ['discovered', 'shortlisted'] as ReviewStatus[]) {
      const outcome = await service(status).handle({ rawBody: body('shortlist') });
      expect(replyText(outcome)).toMatch(/nothing was sent to the employer/i);
    }
  });
});
