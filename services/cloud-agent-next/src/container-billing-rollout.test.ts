import { describe, expect, it } from 'vitest';
import { isCloudAgentContainerBillingEnabled } from './container-billing-rollout.js';

const enabled = {
  CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
  CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: 'user-1',
  CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org-1',
};

describe('Cloud Agent container billing rollout', () => {
  it('selects personal and organization payers independently', () => {
    expect(isCloudAgentContainerBillingEnabled(enabled, { userId: 'user-1' })).toBe(true);
    expect(
      isCloudAgentContainerBillingEnabled(enabled, { userId: 'user-1', orgId: 'other-org' })
    ).toBe(false);
    expect(
      isCloudAgentContainerBillingEnabled(enabled, { userId: 'other-user', orgId: 'org-1' })
    ).toBe(true);
  });

  it('requires the exact global switch and fails malformed lists closed', () => {
    expect(
      isCloudAgentContainerBillingEnabled(
        { ...enabled, CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'TRUE' },
        { userId: 'user-1' }
      )
    ).toBe(false);
    expect(
      isCloudAgentContainerBillingEnabled(
        { ...enabled, CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: 'user-1,' },
        { userId: 'user-1' }
      )
    ).toBe(false);
    expect(
      isCloudAgentContainerBillingEnabled(
        { ...enabled, CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: '*' },
        { userId: 'user-2', orgId: 'org-1' }
      )
    ).toBe(false);
  });
});
