import { describe, expect, it, vi } from 'vitest';
import {
  ContainerCapacityUnavailableError,
  ContainerConcurrencyLimitError,
  FUNDED_CONTAINER_MINIMUM_MICRODOLLARS,
  getContainerCapacityFailureReason,
  getContainerCapacityLimit,
  getContainerCapacityScopes,
  isContainerConcurrencyExempt,
  LOW_BALANCE_CONTAINER_LIMIT,
  ORGANIZATION_CONTAINER_LIMIT,
  USER_CONTAINER_LIMIT,
  type ContainerCapacityRequest,
} from './index';

vi.mock('@kilocode/db/schema', () => {
  throw new Error('The client entrypoint must not load database code');
});

const request: ContainerCapacityRequest = {
  subject: { type: 'user', id: 'oauth/github:actor-1' },
  actor: { type: 'user', id: 'oauth/github:actor-1' },
  instanceId: 'sbx-1',
  checkpoint: 'control-plane-create',
};

describe('container concurrency policy', () => {
  it('keeps the established limits and funding cutoff', () => {
    expect(LOW_BALANCE_CONTAINER_LIMIT).toBe(3);
    expect(USER_CONTAINER_LIMIT).toBe(20);
    expect(ORGANIZATION_CONTAINER_LIMIT).toBe(50);
    expect(FUNDED_CONTAINER_MINIMUM_MICRODOLLARS).toBe(3_000_000);
  });

  it.each([
    [-1, LOW_BALANCE_CONTAINER_LIMIT],
    [0, LOW_BALANCE_CONTAINER_LIMIT],
    [2_999_999, LOW_BALANCE_CONTAINER_LIMIT],
    [3_000_000, USER_CONTAINER_LIMIT],
    [3_000_001, USER_CONTAINER_LIMIT],
  ])('uses a %i microdollar balance to select limit %i', (balance, limit) => {
    expect(getContainerCapacityLimit({ type: 'actor', subject: request.subject }, balance)).toBe(
      limit
    );
  });

  it('checks the same actor across personal and organization usage', () => {
    const actorScope = { type: 'actor', subject: request.subject };
    expect(getContainerCapacityScopes(request)).toEqual([actorScope]);
    expect(
      getContainerCapacityScopes({ ...request, subject: { type: 'org', id: 'org-1' } })
    ).toEqual([actorScope, { type: 'subject', subject: { type: 'org', id: 'org-1' } }]);
  });

  it.each([
    [{ type: 'user', id: 'oauth/github:payer' }, USER_CONTAINER_LIMIT],
    [{ type: 'org', id: 'org-1' }, ORGANIZATION_CONTAINER_LIMIT],
  ] as const)('keeps bot billing-subject limits independent of balance: %j', (subject, limit) => {
    const scopes = getContainerCapacityScopes({
      ...request,
      subject,
      actor: { type: 'bot', id: 'bot-1' },
    });
    expect(scopes).toEqual([{ type: 'subject', subject }]);
    expect(getContainerCapacityLimit({ type: 'subject', subject }, 0)).toBe(limit);
  });

  it.each([{ instanceId: 'crv-1' }, { instanceId: 'sbx-1', billingOrigin: 'code-review' }])(
    'exempts Code Reviewer starts: %j',
    overrides => {
      expect(isContainerConcurrencyExempt({ ...request, ...overrides })).toBe(true);
    }
  );

  it('does not exempt ordinary neutral sandbox ids', () => {
    expect(isContainerConcurrencyExempt({ ...request, billingOrigin: 'cloud-agent-web' })).toBe(
      false
    );
  });
});

describe('container capacity failures', () => {
  it.each([
    [new ContainerConcurrencyLimitError('personal', 3), 'container_limit_reached'],
    [new ContainerConcurrencyLimitError('organization', 50), 'container_limit_reached'],
    [new ContainerCapacityUnavailableError(), 'billing_unavailable'],
  ] as const)('recognizes %s after RPC flattening', (error, reason) => {
    expect(getContainerCapacityFailureReason(error)).toBe(reason);
    expect(getContainerCapacityFailureReason({ code: error.code })).toBe(reason);
    expect(getContainerCapacityFailureReason(new Error(`remote: ${error.message}`))).toBe(reason);
    expect(getContainerCapacityFailureReason(error.message)).toBe(reason);
  });

  it('does not classify unrelated failures', () => {
    expect(getContainerCapacityFailureReason(undefined)).toBeUndefined();
    expect(getContainerCapacityFailureReason(new Error('database unavailable'))).toBeUndefined();
  });
});
