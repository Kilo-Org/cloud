import { describe, expect, it } from 'vitest';

import {
  canManageProvider,
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  integrationScope,
  providerLabelKey,
  providerRowBlocked,
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
  it('lets the account owner take every action on a personal connection', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const action of ['connect', 'disconnect'] as const) {
        expect(canManageProvider({ provider, scope: 'personal', role: undefined, action })).toBe(
          true
        );
      }
    }
  });

  // Mirrors the server procedure each action actually calls:
  // - `githubApps.uninstallApp` and `slack.uninstallApp` pass
  //   ORGANIZATION_MANAGE_ROLES explicitly;
  // - `slack`, `linear` and `discord` connects, plus `linear`, `discord` and
  //   `gitlab` disconnects, go through `resolveAuthorizedOwner`, whose default
  //   is ORGANIZATION_BILLING_ROLES;
  // - `resolveGitLabOAuthOwner` only demands billing roles when it replaces an
  //   existing integration, so a member's first GitLab connect is allowed.
  const MATRIX: {
    provider: IntegrationProvider;
    action: 'connect' | 'disconnect';
    installed?: boolean;
    allowed: string[];
  }[] = [
    { provider: 'github', action: 'connect', allowed: ['owner', 'admin'] },
    { provider: 'github', action: 'disconnect', allowed: ['owner', 'admin'] },
    { provider: 'slack', action: 'connect', allowed: ['owner', 'admin'] },
    { provider: 'slack', action: 'disconnect', allowed: ['owner', 'admin'] },
    {
      provider: 'gitlab',
      action: 'connect',
      installed: false,
      allowed: ['owner', 'admin', 'billing_manager', 'member'],
    },
    {
      provider: 'gitlab',
      action: 'connect',
      installed: true,
      allowed: ['owner', 'admin', 'billing_manager'],
    },
    { provider: 'gitlab', action: 'disconnect', allowed: ['owner', 'admin', 'billing_manager'] },
    { provider: 'discord', action: 'connect', allowed: ['owner', 'admin', 'billing_manager'] },
    { provider: 'discord', action: 'disconnect', allowed: ['owner', 'admin', 'billing_manager'] },
    { provider: 'linear', action: 'connect', allowed: ['owner', 'admin', 'billing_manager'] },
    { provider: 'linear', action: 'disconnect', allowed: ['owner', 'admin', 'billing_manager'] },
    // Bitbucket is connected in the app: the row runs the organization
    // procedures its sheet calls, and each is an `organizationBillingProcedure`
    // (owner, admin, billing manager).
    { provider: 'bitbucket', action: 'connect', allowed: ['owner', 'admin', 'billing_manager'] },
    { provider: 'bitbucket', action: 'disconnect', allowed: ['owner', 'admin', 'billing_manager'] },
  ];

  const ROLES = ['owner', 'admin', 'billing_manager', 'member'] as const;

  it.each(MATRIX)(
    '$provider $action (installed=$installed) admits exactly $allowed',
    ({ provider, action, installed, allowed }) => {
      for (const role of ROLES) {
        expect(
          canManageProvider({
            provider,
            scope: 'organization',
            role,
            action,
            installed: installed ?? false,
          })
        ).toBe(allowed.includes(role));
      }
    }
  );

  it('offers nothing while the viewer role is still unresolved', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(
        canManageProvider({ provider, scope: 'organization', role: undefined, action: 'connect' })
      ).toBe(false);
      expect(
        canManageProvider({
          provider,
          scope: 'organization',
          role: undefined,
          action: 'disconnect',
        })
      ).toBe(false);
    }
  });
});

describe('providerRowBlocked', () => {
  // A member's row offers nothing wherever the action's rule needs an owner:
  // the manage set and the billing set both name one, and Bitbucket's connect
  // and disconnect procedures are billing procedures too. `installed` only
  // picks which action the row would show.
  it('blocks a member on every organization provider whose rule needs an owner', () => {
    for (const provider of ['github', 'slack', 'discord', 'linear', 'bitbucket'] as const) {
      for (const installed of [false, true]) {
        expect(
          providerRowBlocked({ provider, scope: 'organization', role: 'member', installed })
        ).toBe(true);
      }
    }
  });

  it('leaves the first GitLab connect to any member, and blocks the replace', () => {
    // `resolveGitLabOAuthOwner` asks for billing roles only when the connect
    // would replace an existing integration, so a member's first connect is
    // accepted and that row offers its button.
    expect(
      providerRowBlocked({
        provider: 'gitlab',
        scope: 'organization',
        role: 'member',
        installed: false,
      })
    ).toBe(false);
    expect(
      providerRowBlocked({
        provider: 'gitlab',
        scope: 'organization',
        role: 'member',
        installed: true,
      })
    ).toBe(true);
  });

  it('offers every organization row to an admin, who holds every gated role', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const installed of [false, true]) {
        expect(
          providerRowBlocked({ provider, scope: 'organization', role: 'admin', installed })
        ).toBe(false);
      }
    }
  });

  it('blocks nothing for an owner, because every rule that gates a row names one', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const installed of [false, true]) {
        expect(
          providerRowBlocked({ provider, scope: 'organization', role: 'owner', installed })
        ).toBe(false);
      }
    }
  });

  it('blocks every organization row while the viewer role is unresolved', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const installed of [false, true]) {
        expect(
          providerRowBlocked({ provider, scope: 'organization', role: undefined, installed })
        ).toBe(true);
      }
    }
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
