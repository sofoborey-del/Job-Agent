import { adapterContractSchema, type AdapterContract } from '@job-agent/browser-core';

export const FAKE_ATS_ADAPTER_ID = 'fake-ats';
export const FAKE_ATS_ADAPTER_VERSION = '2.0.0';

/**
 * The only adapter that exists in Phase 2. It targets the local fake ATS bundled with this
 * repository, which is test software, not an employer. There is deliberately no adapter for any
 * real ATS or employer site, and the action validator additionally refuses any non-loopback target.
 */
export function fakeAtsAdapter(targetOrigin: string): AdapterContract {
  return adapterContractSchema.parse({
    id: FAKE_ATS_ADAPTER_ID,
    version: FAKE_ATS_ADAPTER_VERSION,
    targetOrigin,
    allowsSubmit: true,
    isFakeTarget: true,
    confirmationPath: '/apply/:sessionId/confirmation',
    confirmationReferencePattern: '^FAKE-ATS-[A-Z0-9]{8}$',
    steps: [
      { id: 'details', path: '/apply/:sessionId/details', nextSelector: '#next', humanOnly: false },
      {
        id: 'history',
        path: '/apply/:sessionId/history',
        nextSelector: '#next',
        humanOnly: false,
        repeatable: true,
      },
      {
        id: 'documents',
        path: '/apply/:sessionId/documents',
        nextSelector: '#next',
        humanOnly: false,
      },
      {
        id: 'questions',
        path: '/apply/:sessionId/questions',
        nextSelector: '#next',
        humanOnly: true,
      },
      { id: 'checks', path: '/apply/:sessionId/checks', nextSelector: '#next', humanOnly: true },
      {
        id: 'declarations',
        path: '/apply/:sessionId/declarations',
        nextSelector: '#next',
        humanOnly: true,
      },
      {
        id: 'review',
        path: '/apply/:sessionId/review',
        submitSelector: '#submit-application',
        humanOnly: false,
      },
    ],
  });
}

export const fakeAtsStepOrder = [
  'details',
  'history',
  'documents',
  'questions',
  'checks',
  'declarations',
  'review',
] as const;

export type FakeAtsStepId = (typeof fakeAtsStepOrder)[number];

export function nextStepAfter(stepId: string): FakeAtsStepId | null {
  const index = fakeAtsStepOrder.indexOf(stepId as FakeAtsStepId);
  if (index < 0 || index === fakeAtsStepOrder.length - 1) return null;
  return fakeAtsStepOrder[index + 1] ?? null;
}
