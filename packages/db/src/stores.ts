import type { TrackingStores } from '@job-agent/tracking';

import type { SqlDatabase } from './sql.js';
import { SqlDiscoveryRunStore, SqlJobIngestionStore, SqlSourceStore } from './stores-discovery.js';
import {
  SqlAuditStore,
  SqlConfigurationStore,
  SqlInboxStore,
  SqlOutboxStore,
  SqlRuntimeStateStore,
  SqlUserStore,
} from './stores-platform.js';
import { SqlMatchRunStore, SqlTrackingStore } from './stores-tracking.js';

/** One set of repositories, shared by the embedded and full PostgreSQL deployments. */
export function createTrackingStores(db: SqlDatabase): TrackingStores {
  return {
    users: new SqlUserStore(db),
    sources: new SqlSourceStore(db),
    discoveryRuns: new SqlDiscoveryRunStore(db),
    jobs: new SqlJobIngestionStore(db),
    tracking: new SqlTrackingStore(db),
    matchRuns: new SqlMatchRunStore(db),
    configuration: new SqlConfigurationStore(db),
    outbox: new SqlOutboxStore(db),
    inbox: new SqlInboxStore(db),
    audit: new SqlAuditStore(db),
    runtime: new SqlRuntimeStateStore(db),
  };
}
