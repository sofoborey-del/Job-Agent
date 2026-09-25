export type PortalApplyMode =
  'manual_only' | 'assisted_prefill' | 'approval_submit' | 'auto_submit';

export type AuthenticatedPortalDefinition = {
  key: string;
  displayName: string;
  domains: string[];
  discoveryMode: 'public_feed_preferred' | 'public_pages' | 'official_api';
  authRequiredForSearch: boolean;
  authRequiredForApply: boolean;
  applicationPlatform: string;
  applyMode: PortalApplyMode;
  automationPermission: 'confirmed' | 'not_confirmed' | 'prohibited';
  humanRequiredSteps: string[];
  storesReusableCandidateDetails: boolean;
  supportsDraftResume: boolean;
  confirmationSignals: Array<'account_status' | 'confirmation_page' | 'email'>;
  termsEvidenceUrl: string;
  privacyEvidenceUrl: string;
};

export const myJobScotlandPortal: AuthenticatedPortalDefinition = {
  key: 'myjobscotland',
  displayName: 'myjobscotland',
  domains: ['myjobscotland.gov.uk', 'www.myjobscotland.gov.uk'],
  discoveryMode: 'public_feed_preferred',
  authRequiredForSearch: false,
  authRequiredForApply: true,
  applicationPlatform: 'TalentLink',
  applyMode: 'assisted_prefill',
  automationPermission: 'not_confirmed',
  humanRequiredSteps: [
    'initial_login',
    'recaptcha',
    'account_activation',
    'privacy_consent',
    'equal_opportunity_questionnaire',
    'legal_declaration',
    'final_submit',
  ],
  storesReusableCandidateDetails: true,
  supportsDraftResume: true,
  confirmationSignals: ['account_status', 'confirmation_page', 'email'],
  termsEvidenceUrl: 'https://myjobscotland.gov.uk/disclaimer',
  privacyEvidenceUrl: 'https://myjobscotland.gov.uk/privacy-and-cookies',
};

export type PortalSessionPolicy = {
  persistPassword: false;
  persistEncryptedBrowserSession: boolean;
  userMustCompleteInitialLogin: true;
  pauseOnAuthenticationChallenge: true;
  sessionRetentionHours: number;
};

export const defaultPortalSessionPolicy: PortalSessionPolicy = {
  persistPassword: false,
  persistEncryptedBrowserSession: true,
  userMustCompleteInitialLogin: true,
  pauseOnAuthenticationChallenge: true,
  sessionRetentionHours: 24,
};

export function maySubmitAutomatically(portal: AuthenticatedPortalDefinition): boolean {
  return portal.automationPermission === 'confirmed' && portal.applyMode === 'auto_submit';
}
