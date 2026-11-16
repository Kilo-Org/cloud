import type { ExaUsageQueueMessage, ExaUsageRecord } from '@kilocode/usage-contracts';

export const exaRecord: ExaUsageRecord = {
  id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
  occurredAt: '2026-11-12T09:08:07.654Z',
  userId: 'oauth/github:sensitive-exa-user',
  organizationId: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  path: '/search',
  costMicrodollars: 7_000,
  chargedToBalance: true,
  freeAllowanceMicrodollars: 10_000_000,
  featureId: 'sensitive-exa-feature',
  type: 'sensitive-exa-type',
};

export const exaMessage: ExaUsageQueueMessage = { kind: 'exa_usage', v: 1, record: exaRecord };
