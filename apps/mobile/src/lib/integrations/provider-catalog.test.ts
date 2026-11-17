import { describe, expect, it } from 'vitest';

import {
  blockedConnectionRoles,
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
  // - `slack`, `linear`, `discord` and `gitlab` connects, plus `linear`,
  //   `discord` and `gitlab` disconnects, go through `resolveAuthorizedOwner`,
  //   whose default is ORGANIZATION_BILLING_ROLES;
  // - every organization GitLab connect starts at `resolveGitLabOAuthOwner`,
  //   which asks for ORGANIZATION_BILLING_ROLES on the OAuth start and on the
  //   callback, so a member is turned away for a first connect too.
  const MATRIX: {
    provider: IntegrationProvider;
    action: 'connect' | 'disconnect';
    allowed: string[];
  }[] = [
    { provider: 'github', action: 'connect', allowed: ['owner', 'admin'] },
    { provider: 'github', action: 'disconnect', allowed: ['owner', 'admin'] },
    { provider: 'slack', action: 'connect', allowed: ['owner', 'admin'] },
    { provider: 'slack', action: 'disconnect', allowed: ['owner', 'admin'] },
    { provider: 'gitlab', action: 'connect', allowed: ['owner', 'admin', 'billing_manager'] },
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

  it.each(MATRIX)('$provider $action admits exactly $allowed', ({ provider, action, allowed }) => {
    for (const role of ROLES) {
      expect(
        canManageProvider({
          provider,
          scope: 'organization',
          role,
          action,
        })
      ).toBe(allowed.includes(role));
    }
  });

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
    for (const provider of [
      'github',
      'slack',
      'gitlab',
      'discord',
      'linear',
      'bitbucket',
    ] as const) {
      for (const installed of [false, true]) {
        expect(
          providerRowBlocked({ provider, scope: 'organization', role: 'member', installed })
        ).toBe(true);
      }
    }
  });

  it('blocks a member on gitlab for a first connect and for a replacement', () => {
    // `resolveGitLabOAuthOwner` asks for billing roles on the OAuth start and on
    // the callback, so a member's first connect is refused as well.
    for (const installed of [false, true]) {
      expect(
        providerRowBlocked({ provider: 'gitlab', scope: 'organization', role: 'member', installed })
      ).toBe(true);
    }
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

describe('blockedConnectionRoles', () => {
  /** The hub's rows for an organization, every provider uninstalled unless told otherwise. */
  function rows(installed: readonly IntegrationProvider[] = []) {
    return INTEGRATION_PROVIDERS.map(provider => ({
      provider,
      installed: installed.includes(provider),
      actionPending: false,
    }));
  }

  it('names every role that can change a blocked row for a member', () => {
    // A member is shut out of every rule, and the union is the three role sets
    // the providers follow: the manage set, the billing set, and Bitbucket's
    // owner-or-billing-manager page gate.
    expect(blockedConnectionRoles({ rows: rows(), scope: 'organization', role: 'member' })).toEqual(
      ['owner', 'admin', 'billing_manager']
    );
  });

  it('names the manage roles for a billing manager, who reaches every other row', () => {
    // GitHub and Slack ask for ORGANIZATION_MANAGE_ROLES, so a billing manager
    // is blocked there and nowhere else — connected or not, since both actions
    // follow the same set.
    const result = blockedConnectionRoles({
      rows: rows(['github', 'slack']),
      scope: 'organization',
      role: 'billing_manager',
    });
    expect(result).toEqual(['owner', 'admin']);
  });

  it('names the billing manager for an admin, who is blocked on Bitbucket alone', () => {
    const result = blockedConnectionRoles({
      rows: rows(['bitbucket']),
      scope: 'organization',
      role: 'admin',
    });
    expect(result).toEqual(['owner', 'billing_manager']);
  });

  it('names nothing for an owner, who is offered every row', () => {
    expect(blockedConnectionRoles({ rows: rows(), scope: 'organization', role: 'owner' })).toEqual(
      []
    );
  });

  it('names nothing in the personal scope, where every row belongs to the viewer', () => {
    expect(blockedConnectionRoles({ rows: rows(), scope: 'personal', role: 'member' })).toEqual([]);
  });

  it('counts no role for a row whose connections read has not settled', () => {
    expect(
      blockedConnectionRoles({
        rows: [{ provider: 'github', installed: true, actionPending: true }],
        scope: 'organization',
        role: 'member',
      })
    ).toEqual([]);
  });

  it('counts only the settled rows when a pending row sits beside a blocked one', () => {
    // Slack's rule is the manage set alone, while the pending GitLab row would
    // add the billing manager were it counted, so the sentence must stop at the
    // two manage roles.
    const result = blockedConnectionRoles({
      rows: [
        { provider: 'gitlab', installed: true, actionPending: true },
        { provider: 'slack', installed: false, actionPending: false },
      ],
      scope: 'organization',
      role: 'member',
    });
    expect(result).toEqual(['owner', 'admin']);
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
