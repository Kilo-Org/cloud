import { describe, expect, it } from 'vitest';
import { billingConfigFromEnv, billingModeFor } from './billing-config';

function env(
  vars: Parameters<typeof billingConfigFromEnv>[0]
): Parameters<typeof billingConfigFromEnv>[0] {
  return vars;
}

describe('container billing configuration', () => {
  it('fails closed when any allowlist is empty or malformed', () => {
    const config = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown',
        CONTAINER_BILLING_USER_IDS: '',
        CONTAINER_BILLING_ORG_IDS: 'org-1',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );
    expect(config.enabled).toBe(false);
    expect(billingModeFor(config, 'gastown', { type: 'org', id: 'org-1' })).toBe('shadow');
  });

  it('requires both service and payer allowlists for paid intervals', () => {
    const config = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown',
        CONTAINER_BILLING_USER_IDS: 'user-1',
        CONTAINER_BILLING_ORG_IDS: 'org-1',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );
    expect(billingModeFor(config, 'gastown', { type: 'user', id: 'user-1' })).toBe('paid');
    expect(billingModeFor(config, 'gastown', { type: 'org', id: 'org-1' })).toBe('paid');
    expect(billingModeFor(config, 'cloud-agent-next', { type: 'user', id: 'user-1' })).toBe(
      'shadow'
    );
  });
});
