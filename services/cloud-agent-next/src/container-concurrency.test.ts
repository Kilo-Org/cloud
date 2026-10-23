import { describe, expect, it } from 'vitest';
import {
  ContainerCapacityUnavailableError,
  containerCapacityEnforced,
  getContainerCapacityFailureReason,
} from './container-concurrency.js';
import { containerLimitError } from './container-limit-test-helpers.js';

describe('getContainerCapacityFailureReason', () => {
  it.each([
    [containerLimitError('organization', 50), 'container_limit_reached'],
    [new ContainerCapacityUnavailableError(), 'billing_unavailable'],
  ] as const)('preserves the reason for %s directly and after RPC flattening', (error, reason) => {
    expect(getContainerCapacityFailureReason(error)).toBe(reason);
    expect(getContainerCapacityFailureReason(new Error(`remote: ${error.message}`))).toBe(reason);
    expect(getContainerCapacityFailureReason({ code: error.code })).toBe(reason);
    expect(getContainerCapacityFailureReason(error.message)).toBe(reason);
  });

  it('does not match unrelated failures', () => {
    expect(getContainerCapacityFailureReason(new Error('meter unavailable'))).toBeUndefined();
    expect(getContainerCapacityFailureReason(undefined)).toBeUndefined();
  });
});

describe('containerCapacityEnforced', () => {
  it('enforces the cap unless the test environment turns it off', () => {
    expect(containerCapacityEnforced({})).toBe(true);
    expect(containerCapacityEnforced({ CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED: 'false' })).toBe(
      true
    );
    expect(containerCapacityEnforced({ CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED: 'true' })).toBe(
      false
    );
  });
});
