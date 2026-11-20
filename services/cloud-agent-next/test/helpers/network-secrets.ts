import { generateKeyPairSync } from 'node:crypto';
import { encryptWithPublicKey } from '@kilocode/encryption';
import {
  prepareCredentialGrant,
  hasRuntimeCredentialProxy,
  type CredentialGrantPreparation,
} from '../../src/sandbox-control/session-credentials.js';
import { mintNetworkSecretGrants } from '../../src/network-secrets/grants.js';
import type { ScmAdmissionContext } from '../../src/scm-broker/admission.js';

export async function networkSecretFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const value = 'synthetic-upstream-network-value';
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const snapshot = {
    SERVICE_TOKEN: {
      envelope: encryptWithPublicKey(value, Buffer.from(publicKeyPem)),
      allowedHosts: ['api.example.com'],
      locations: ['header'] as const,
    },
  };
  const sandboxId = 'ses-abcdef';
  const networkSecrets = mintNetworkSecretGrants(sandboxId, snapshot, []);
  const now = Date.now();
  const preparation: CredentialGrantPreparation = {
    env: {
      WORKER_URL: 'https://worker.example.com',
      KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com',
      KILO_OPENROUTER_BASE: 'https://provider.example.com',
      KILO_SESSION_INGEST_URL: 'https://ingest.example.com',
    } as CredentialGrantPreparation['env'],
    source: {
      userId: 'synthetic-user',
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      kiloToken: 'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln',
      networkSecrets: snapshot,
    },
    sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    sandboxId,
    provider: 'cloudflare-containers',
    outboundContainerId: 'synthetic-container',
    containmentEnabled: true,
    scopeId: 'synthetic-workspace',
    directory: '/workspace/test',
    payload: {},
    networkSecrets,
    now,
  };
  const prepared = await prepareCredentialGrant(preparation);
  const context: ScmAdmissionContext = {
    sandboxId,
    ownerId: preparation.source.userId,
    provider: 'cloudflare-containers',
    containmentEnabled: true,
    allocation: {
      kind: 'connected',
      allocationId: 'synthetic-allocation',
      providerRef: 'synthetic-provider',
    },
    outboundContainerId: 'synthetic-container',
    grants: [prepared.grant],
    liveSessionIds: [preparation.sessionId],
    identityBinding: '',
    available: true,
  };
  const deps = {
    grantAdmitted: hasRuntimeCredentialProxy,
    serial: <T>(operation: () => Promise<T>) => operation(),
    readContext: async () => context,
    authenticate: async () => ({ ok: true as const, isCurrent: () => true }),
    now: () => now,
  };
  return {
    ...prepared,
    context,
    deps,
    preparation,
    privateKeyPem,
    snapshot,
    value,
    alias: networkSecrets[0].alias,
  };
}
