import { describe, expect, it } from 'vitest';
import { billingConfigFromEnv, billingModeFor } from './billing-config';

function env(
  vars: Parameters<typeof billingConfigFromEnv>[0]
): Parameters<typeof billingConfigFromEnv>[0] {
  return vars;
}

describe('container billing configuration', () => {
  it('allows a personal canary without enabling organization billing', () => {
    const config = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown',
        CONTAINER_BILLING_USER_IDS: 'user-1',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );
    expect(config.enabled).toBe(true);
    expect(billingModeFor(config, 'gastown', { type: 'user', id: 'user-1' })).toBe('paid');
    expect(billingModeFor(config, 'gastown', { type: 'org', id: 'org-1' })).toBe('shadow');
  });

  it('fails closed without an eligible payer or with a malformed list', () => {
    const noPayerConfig = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown',
        CONTAINER_BILLING_USER_IDS: '',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );
    expect(noPayerConfig.enabled).toBe(false);

    const malformedConfig = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown',
        CONTAINER_BILLING_USER_IDS: 'user-1,',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );
    expect(malformedConfig.enabled).toBe(false);
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

  it('uses Cloud Agent payer lists only for Cloud Agent service names', () => {
    const config = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown,cloud-agent-next-sandbox',
        CONTAINER_BILLING_USER_IDS: 'gastown-user',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'cloud-agent-user',
        CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: 'cloud-agent-org',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );

    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox', { type: 'user', id: 'cloud-agent-user' })
    ).toBe('paid');
    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox', { type: 'user', id: 'gastown-user' })
    ).toBe('shadow');
    expect(billingModeFor(config, 'gastown', { type: 'user', id: 'cloud-agent-user' })).toBe(
      'shadow'
    );
  });

  it('allows the Cloud Agent family token for current and future service classes only', () => {
    const config = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown,cloud-agent-next',
        CONTAINER_BILLING_USER_IDS: 'gastown-user',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'cloud-agent-user',
        CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: '',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );

    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox', { type: 'user', id: 'cloud-agent-user' })
    ).toBe('paid');
    expect(
      billingModeFor(config, 'cloud-agent-next-future-class', {
        type: 'user',
        id: 'cloud-agent-user',
      })
    ).toBe('paid');
    expect(
      billingModeFor(config, 'cloud-agent-next', { type: 'user', id: 'cloud-agent-user' })
    ).toBe('shadow');
    expect(
      billingModeFor(config, 'cloud-agent-other-sandbox', {
        type: 'user',
        id: 'cloud-agent-user',
      })
    ).toBe('shadow');
  });

  it('keeps exact Cloud Agent class tokens available for per-class rollout', () => {
    const config = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'cloud-agent-next-sandbox',
        CONTAINER_BILLING_USER_IDS: '',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'cloud-agent-user',
        CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: '',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );

    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox', { type: 'user', id: 'cloud-agent-user' })
    ).toBe('paid');
    expect(
      billingModeFor(config, 'cloud-agent-next-future-class', {
        type: 'user',
        id: 'cloud-agent-user',
      })
    ).toBe('shadow');
  });

  it('requires Cloud Agent service names as well as Cloud Agent payer lists', () => {
    const config = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown',
        CONTAINER_BILLING_USER_IDS: '',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'cloud-agent-user',
        CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: '',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );
    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox', { type: 'user', id: 'cloud-agent-user' })
    ).toBe('shadow');
  });

  it('fails Cloud Agent billing closed for empty or malformed Cloud Agent lists', () => {
    const empty = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown,cloud-agent-next-sandbox',
        CONTAINER_BILLING_USER_IDS: 'gastown-user',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: '',
        CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: 'cloud-agent-org',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );
    expect(
      billingModeFor(empty, 'cloud-agent-next-sandbox', { type: 'user', id: 'gastown-user' })
    ).toBe('shadow');

    const malformed = billingConfigFromEnv(
      env({
        CONTAINER_BILLING_SERVICES: 'gastown,cloud-agent-next-sandbox',
        CONTAINER_BILLING_USER_IDS: 'gastown-user',
        CONTAINER_BILLING_ORG_IDS: '',
        CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'cloud-agent-user,',
        CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: '',
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      })
    );
    expect(
      billingModeFor(malformed, 'cloud-agent-next-sandbox', {
        type: 'user',
        id: 'cloud-agent-user',
      })
    ).toBe('shadow');
    expect(
      billingModeFor(malformed, 'cloud-agent-next-sandbox', {
        type: 'org',
        id: 'cloud-agent-org',
      })
    ).toBe('shadow');
  });
});
