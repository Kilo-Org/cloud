import type { EnkryptUsageQueueMessage, EnkryptUsageWrite } from '@kilocode/usage-contracts';

export const enkryptRecord: EnkryptUsageWrite = {
  id: '8c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  occurredAt: '2026-11-09T10:11:12.945Z',
  organizationId: '9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e',
  kiloUserId: 'oauth/github:sensitive-enkrypt-user',
  sessionId: 'ses_sensitive-enkrypt-session',
  apiKind: 'messages',
  decision: 'blocked',
  creditsCost: 7,
  addedLatencyMs: 212,
  guardrail: 'input',
};

export const enkryptMessage: EnkryptUsageQueueMessage = {
  kind: 'enkrypt_usage',
  v: 1,
  record: enkryptRecord,
};
