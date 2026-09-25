import { describe, expect, it } from 'vitest';

import {
  defaultPortalSessionPolicy,
  maySubmitAutomatically,
  myJobScotlandPortal,
} from './portals.js';

describe('authenticated portal safety policy', () => {
  it('uses public discovery and assisted prefill for myjobscotland until permission is confirmed', () => {
    expect(myJobScotlandPortal.discoveryMode).toBe('public_feed_preferred');
    expect(myJobScotlandPortal.authRequiredForSearch).toBe(false);
    expect(myJobScotlandPortal.authRequiredForApply).toBe(true);
    expect(myJobScotlandPortal.applyMode).toBe('assisted_prefill');
    expect(maySubmitAutomatically(myJobScotlandPortal)).toBe(false);
  });

  it('never persists a portal password and pauses for authentication challenges', () => {
    expect(defaultPortalSessionPolicy.persistPassword).toBe(false);
    expect(defaultPortalSessionPolicy.userMustCompleteInitialLogin).toBe(true);
    expect(defaultPortalSessionPolicy.pauseOnAuthenticationChallenge).toBe(true);
    expect(myJobScotlandPortal.humanRequiredSteps).toContain('recaptcha');
    expect(myJobScotlandPortal.humanRequiredSteps).toContain('final_submit');
  });
});
