import { encodeOnPremProviderRef } from '../../src/shared/onprem-protocol.js';
import { configMapSchema, ledgerName, onPremConfigSchema, ownedLabels } from './kubernetes.js';
import { acceptOperation, type AllocationLedger, type LaunchOperation } from './ledger.js';
import { type LedgerRecord } from './ledger-retention.js';

export const now = Date.parse('2026-09-02T12:00:00Z');
export const config = onPremConfigSchema.parse({
  cloudUrl: 'http://host.docker.internal:8790',
  organizationId: '33333333-3333-4333-8333-333333333333',
  installationId: '22222222-2222-4222-8222-222222222222',
  cloudIPv4: '192.168.5.2',
  dnsIPv4: '10.43.0.10',
  brokerClusterIp: '10.43.0.20',
  profile: {
    id: 'local',
    revision: 'v1',
    runtimeClass: 'gvisor',
    image: 'kilo-runtime:qualified',
    brokerUrl: 'https://kilo-onprem-broker.kilo-onprem-system.svc',
    maxLifetimeMs: 600_000,
  },
  upstreams: {
    backendBaseUrl: 'http://host.docker.internal:3000',
    providerBaseUrl: 'http://host.docker.internal:3000',
    sessionIngestBaseUrl: 'http://host.docker.internal:8792',
  },
});
const allocationId = '11111111-1111-4111-8111-111111111111';
const providerRef = encodeOnPremProviderRef({
  installationId: config.installationId,
  allocationId,
});
export const launch: LaunchOperation = {
  id: '44444444-4444-4444-8444-444444444444',
  allocationId,
  providerRef,
  sandboxId: 'sandbox-test',
  revision: 1,
  type: 'launch',
  profileId: 'local',
  profileRevision: 'v1',
  hardStopAt: now + 600_000,
  notAfter: now + 120_000,
  bootstrap: {
    SANDBOX_CONTROL_URL: 'ws://host.docker.internal:8790/sandbox-control/sandbox-test',
    SANDBOX_CONTROL_CREDENTIAL: 'allocation-scoped-test-capability',
    PROVIDER_INSTANCE_ID: providerRef,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
  },
};

export function ledgerRecord(
  ledger: AllocationLedger = acceptOperation(null, launch, config, now)
): LedgerRecord {
  const resource = configMapSchema.parse({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: ledgerName(ledger.allocationId),
      namespace: config.systemNamespace,
      uid: '55555555-5555-4555-8555-555555555555',
      resourceVersion: '7',
      labels: ownedLabels(config.installationId, 'ledger', ledger.allocationId),
    },
    data: { 'ledger.json': JSON.stringify(ledger) },
  });
  return { resource, ledger };
}
