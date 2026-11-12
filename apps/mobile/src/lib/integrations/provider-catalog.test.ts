import { describe, expect, it } from 'vitest';

import {
  canManageProvider,
  INTEGRATION_PROVIDERS,
  integrationScope,
  providerLabelKey,
  visibleIntegrationProviders,
} from './provider-catalog';

describe('integrationScope', () => {
  it('maps an explicit organization id to the organization scope', () => {
    expect(integrationScope()).toBe('personal');
    expect(integrationScope('org_123')).toBe('organization');
  });
});

describe('visibleIntegrationProviders', () => {
  it('lists the personal providers in web order without the org-only Bitbucket', () => {
    expect(visibleIntegrationProviders('personal', {})).toEqual([
      'github',
      'slack',
      'gitlab',
      'linear',
    ]);
  });

  it('offers Discord only once a server is already installed', () => {
    expect(visibleIntegrationProviders('personal', { discord: false })).not.toContain('discord');
    expect(visibleIntegrationProviders('personal', { discord: true })).toContain('discord');
  });

  it('lists every provider for an organization, Bitbucket last', () => {
    expect(visibleIntegrationProviders('organization', { discord: true })).toEqual([
      ...INTEGRATION_PROVIDERS,
    ]);
    expect(visibleIntegrationProviders('organization', {})).toEqual([
      'github',
      'slack',
      'gitlab',
      'linear',
      'bitbucket',
    ]);
  });
});

describe('canManageProvider', () => {
  it('lets the account owner manage every personal connection', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(canManageProvider(provider, 'personal', undefined)).toBe(true);
    }
  });

  it('reserves Slack and GitHub organization connections for owners and admins', () => {
    expect(canManageProvider('slack', 'organization', 'owner')).toBe(true);
    expect(canManageProvider('slack', 'organization', 'admin')).toBe(true);
    expect(canManageProvider('slack', 'organization', 'billing_manager')).toBe(false);
    expect(canManageProvider('github', 'organization', 'billing_manager')).toBe(false);
    expect(canManageProvider('github', 'organization', 'member')).toBe(false);
  });

  it('accepts a billing role for the platforms whose server check is billing-wide', () => {
    for (const provider of ['gitlab', 'discord', 'linear'] as const) {
      expect(canManageProvider(provider, 'organization', 'billing_manager')).toBe(true);
      expect(canManageProvider(provider, 'organization', 'admin')).toBe(true);
      expect(canManageProvider(provider, 'organization', 'member')).toBe(false);
    }
  });

  it('keeps Bitbucket on the owner and billing-manager rule its web controls use', () => {
    expect(canManageProvider('bitbucket', 'organization', 'owner')).toBe(true);
    expect(canManageProvider('bitbucket', 'organization', 'billing_manager')).toBe(true);
    expect(canManageProvider('bitbucket', 'organization', 'admin')).toBe(false);
  });
});

describe('providerLabelKey', () => {
  it('names every provider with an existing catalog key', () => {
    const keys = INTEGRATION_PROVIDERS.map(provider => providerLabelKey(provider));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-zA-Z.]+$/);
    }
  });
});
