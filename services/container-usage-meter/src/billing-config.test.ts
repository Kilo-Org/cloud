import { afterEach, describe, expect, it, vi } from 'vitest';
import { billingConfigFromEnv, billingModeFor } from './billing-config';

afterEach(() => vi.restoreAllMocks());

function env(
  vars: Parameters<typeof billingConfigFromEnv>[0]
): Parameters<typeof billingConfigFromEnv>[0] {
  return vars;
}

describe('container billing configuration', () => {
  it.each([
    ['', '', 'shadow', 'shadow'],
    ['user-1', 'org-1', 'paid', 'paid'],
    ['*', '', 'paid', 'shadow'],
    ['', '*', 'shadow', 'paid'],
    ['*', '*', 'paid', 'paid'],
  ] as const)(
    'enrolls users=%s and organizations=%s independently',
    (users, orgs, userMode, orgMode) => {
      const config = billingConfigFromEnv({
        CONTAINER_BILLING_SERVICES: 'cloud-agent-next',
        CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: users,
        CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: orgs,
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      });
      expect(
        billingModeFor(config, 'cloud-agent-next-sandbox-containers-standard3', {
          type: 'user',
          id: 'user-1',
        })
      ).toBe(userMode);
      expect(
        billingModeFor(config, 'cloud-agent-next-sandbox-containers-standard3', {
          type: 'org',
          id: 'org-1',
        })
      ).toBe(orgMode);
      expect(billingModeFor(config, 'gastown', { type: 'user', id: 'user-1' })).toBe('shadow');
    }
  );

  it('keeps wildcard payers behind service enrollment and leaves Gastown wildcard behavior unchanged', () => {
    const config = billingConfigFromEnv({
      CONTAINER_BILLING_SERVICES: 'gastown,cloud-agent-next-sandbox-containers-standard3',
      CONTAINER_BILLING_USER_IDS: '*',
      CONTAINER_BILLING_ORG_IDS: '*',
      CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: '*',
      CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: '*',
      CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
    });
    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox-containers-standard3', {
        type: 'user',
        id: 'any-user',
      })
    ).toBe('paid');
    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox-containers-standard4', {
        type: 'user',
        id: 'any-user',
      })
    ).toBe('shadow');
    expect(billingModeFor(config, 'gastown', { type: 'user', id: 'any-user' })).toBe('shadow');
    expect(billingModeFor(config, 'gastown', { type: 'org', id: 'any-org' })).toBe('shadow');
  });

  it('logs the effective configuration once per isolate without payer IDs', async () => {
    vi.resetModules();
    const { billingConfigFromEnv: parse } = await import('./billing-config');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const configuration = {
      CONTAINER_BILLING_SERVICES: 'cloud-agent-next',
      CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'private-user-id',
      CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: 'private-org-id',
      CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
    };
    parse(configuration);
    parse(configuration);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      event: 'container_billing_configuration',
      enabled: true,
      services: ['cloud-agent-next'],
      cloudAgentUsersEnrolled: true,
      cloudAgentOrganizationsEnrolled: true,
      warnRemainingMicrodollars: 10_000_000,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
    expect(error).not.toHaveBeenCalled();
  });

  it('reports the invalid field when the meter falls back to shadow', async () => {
    vi.resetModules();
    const { billingConfigFromEnv: parse } = await import('./billing-config');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = parse({
      CONTAINER_BILLING_SERVICES: 'cloud-agent-next',
      CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'private-user-id',
      CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: '',
      CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: 'invalid-private-value',
    });
    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox', { type: 'user', id: 'private-user-id' })
    ).toBe('shadow');
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
      event: 'container_billing_configuration_invalid',
      invalidFields: ['CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS'],
      configEnabled: false,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-');
  });

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

  it('reports the global flag without claiming malformed selected payers can be billed', async () => {
    vi.resetModules();
    const { billingConfigFromEnv: parse } = await import('./billing-config');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = parse({
      CONTAINER_BILLING_SERVICES: 'cloud-agent-next',
      CONTAINER_BILLING_USER_IDS: 'private-gastown-user',
      CONTAINER_BILLING_ORG_IDS: '',
      CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'private-user,',
      CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: '',
      CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
    });
    expect(config.enabled).toBe(true);
    expect(
      billingModeFor(config, 'cloud-agent-next-sandbox', { type: 'user', id: 'private-user' })
    ).toBe('shadow');
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
      configEnabled: true,
      invalidFields: ['CONTAINER_BILLING_CLOUD_AGENT_USER_IDS'],
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-');
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
