// The scanner now lives in @job-agent/document-safety so that CV handling and untrusted advert
// attachments share exactly one implementation. This module keeps the original import path working.
export {
  ThreatDetectedError,
  WindowsDefenderScanner,
  type MalwareScanner,
} from '@job-agent/document-safety';
