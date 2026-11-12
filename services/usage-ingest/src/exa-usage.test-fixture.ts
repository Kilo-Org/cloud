import type { ExaUsageQueueMessage, ExaUsageRecord } from '@kilocode/usage-contracts';

export const exaRecord: ExaUsageRecord = {
  id: '6a1c2e3f-4b5d-4e6f-8a7b-9c0d1e2f3a4b',
  occurredAt: '2026-11-09T10:11:12.945Z',
  userId: 'oauth/github:sensitive-exa-user',
  organizationId: '9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e',
  path: '/search',
  costMicrodollars: 7000,
  chargedToBalance: true,
  freeAllowanceMicrodollars: 10_000_000,
  featureId: 'kiloclaw',
  type: 'sensitive-exa-type',
};

export const exaMessage: ExaUsageQueueMessage = { kind: 'exa_usage', v: 1, record: exaRecord };
