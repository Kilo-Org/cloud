import { describe, expect, it } from 'vitest';

import { parseProviderPrRoute, providerPrRoutePath } from './provider-pr-ref';
import { parseProviderPrUrl } from './provider-pr-url';
import { selectPrReviewConnectAction, selectPrReviewGateView } from './pr-review-connect-gate-view';

/** A GitHub arm with everything settled and connected. */
const githubBase = {
  platform: 'github' as const,
  isError: false,
  isLoading: false,
  connected: true,
  reconnectRequired: false,
  instanceMismatch: false,
  organizationId: null,
  organizationSelectionLoaded: true,
};

describe('selectPrReviewGateView — GitHub', () => {
  it('renders children when connected', () => {
    expect(selectPrReviewGateView(githubBase)).toBe('children');
  });

  it('error outranks loading and connection', () => {
    expect(selectPrReviewGateView({ ...githubBase, isError: true, isLoading: true })).toBe('error');
  });

  it('loading outranks a not-yet-known connection', () => {
    expect(selectPrReviewGateView({ ...githubBase, isLoading: true, connected: false })).toBe(
      'loading'
    );
  });

  it('not connected asks to connect', () => {
    expect(selectPrReviewGateView({ ...githubBase, connected: false })).toBe('connect');
  });

  it('a connection that must be re-authorized asks to reconnect', () => {
    expect(
      selectPrReviewGateView({ ...githubBase, connected: false, reconnectRequired: true })
    ).toBe('reconnect');
  });

  it('a reconnect marker never outranks a connected answer', () => {
    expect(selectPrReviewGateView({ ...githubBase, reconnectRequired: true })).toBe('children');
  });
});

describe('selectPrReviewGateView — GitLab (personal and org)', () => {
  for (const organizationId of [null, 'org_1']) {
    const base = {
      platform: 'gitlab' as const,
      isError: false,
      isLoading: false,
      connected: true,
      reconnectRequired: false,
      instanceMismatch: false,
      organizationId,
      organizationSelectionLoaded: true,
    };

    it(`scope ${organizationId ?? 'personal'}: connected renders children`, () => {
      expect(selectPrReviewGateView(base)).toBe('children');
    });

    it(`scope ${organizationId ?? 'personal'}: not connected asks to connect`, () => {
      expect(selectPrReviewGateView({ ...base, connected: false })).toBe('connect');
    });

    it(`scope ${organizationId ?? 'personal'}: an existing connection that cannot be used asks to reconnect`, () => {
      expect(selectPrReviewGateView({ ...base, connected: false, reconnectRequired: true })).toBe(
        'reconnect'
      );
    });

    it(`scope ${organizationId ?? 'personal'}: a failed check is retryable, not Connect`, () => {
      expect(selectPrReviewGateView({ ...base, isError: true, connected: false })).toBe('error');
    });

    it(`scope ${organizationId ?? 'personal'}: a failed check outranks a reconnect marker`, () => {
      expect(
        selectPrReviewGateView({
          ...base,
          isError: true,
          connected: false,
          reconnectRequired: true,
        })
      ).toBe('error');
    });

    it(`scope ${organizationId ?? 'personal'}: a pending check is loading, not Connect`, () => {
      expect(selectPrReviewGateView({ ...base, isLoading: true, connected: false })).toBe(
        'loading'
      );
    });

    it(`scope ${organizationId ?? 'personal'}: a live connection to another instance explains the mismatch`, () => {
      expect(selectPrReviewGateView({ ...base, instanceMismatch: true })).toBe('instance-mismatch');
    });

    it(`scope ${organizationId ?? 'personal'}: the mismatch never outranks a failed or pending check`, () => {
      expect(selectPrReviewGateView({ ...base, instanceMismatch: true, isError: true })).toBe(
        'error'
      );
      expect(selectPrReviewGateView({ ...base, instanceMismatch: true, isLoading: true })).toBe(
        'loading'
      );
    });

    it(`scope ${organizationId ?? 'personal'}: a missing connection asks to connect, not about an instance`, () => {
      expect(selectPrReviewGateView({ ...base, instanceMismatch: true, connected: false })).toBe(
        'connect'
      );
    });
  }
});

describe('selectPrReviewGateView — Bitbucket', () => {
  const orgBase = {
    platform: 'bitbucket' as const,
    isError: false,
    isLoading: false,
    connected: true,
    reconnectRequired: false,
    instanceMismatch: false,
    organizationId: 'org_1',
    organizationSelectionLoaded: true,
  };

  it('an org scope behaves like the other arms', () => {
    expect(selectPrReviewGateView(orgBase)).toBe('children');
    expect(selectPrReviewGateView({ ...orgBase, connected: false })).toBe('connect');
    expect(selectPrReviewGateView({ ...orgBase, isError: true })).toBe('error');
    expect(selectPrReviewGateView({ ...orgBase, isLoading: true, connected: false })).toBe(
      'loading'
    );
  });

  it('a personal scope is the terminal org-only state', () => {
    expect(selectPrReviewGateView({ ...orgBase, organizationId: null, connected: false })).toBe(
      'org-only'
    );
  });

  it('org-only outranks a failed check — the disabled query has nothing to retry', () => {
    expect(
      selectPrReviewGateView({
        ...orgBase,
        organizationId: null,
        isError: true,
        connected: false,
      })
    ).toBe('org-only');
  });

  it('org-only outranks a pending check — a disabled query reports pending forever', () => {
    expect(
      selectPrReviewGateView({
        ...orgBase,
        organizationId: null,
        isLoading: true,
        connected: false,
      })
    ).toBe('org-only');
  });

  /**
   * The spot-check defect behind s7's org-only arm: a Bitbucket PR link
   * opened in the personal scope must reach the org-only explanation, never
   * the invalid-route state. This binds the full in-app chain — the URL
   * every entry point parses (badge, paste, recents), the route it pushes,
   * the layout's own re-parse of that route, and the gate's decision.
   */
  it('a Bitbucket PR link lands on the org-only gate in the personal scope', () => {
    const url = 'https://bitbucket.org/workspace/repo/pull-requests/12';
    const ref = parseProviderPrUrl(url);
    if (ref === null) {
      throw new Error('the Bitbucket URL did not parse');
    }
    const route = providerPrRoutePath(ref);
    expect(route).toBe('/(app)/pr-review/bitbucket/workspace/repo/12');

    const reparsed = parseProviderPrRoute({
      platform: 'bitbucket',
      identity: ['workspace', 'repo', '12'],
    });
    if (reparsed === null) {
      throw new Error('the pushed route did not re-parse');
    }
    expect(reparsed.platform).toBe('bitbucket');

    // The personal scope (organizationId null) is the terminal org-only
    // state — the gate never falls through to a retryable error or Connect.
    expect(
      selectPrReviewGateView({
        platform: 'bitbucket',
        isError: false,
        isLoading: true,
        connected: false,
        reconnectRequired: false,
        instanceMismatch: false,
        organizationId: null,
        organizationSelectionLoaded: true,
      })
    ).toBe('org-only');
  });

  it('waits for the restored account selection before answering for a scope', () => {
    // Before the stored selection lands, `organizationId` is null for a
    // personal reader and for one whose organization is about to be restored,
    // so every arm would paint the wrong scope first and move the screen.
    for (const platform of ['gitlab', 'bitbucket'] as const) {
      for (const connected of [false, true]) {
        expect(
          selectPrReviewGateView({
            platform,
            isError: false,
            isLoading: false,
            connected,
            reconnectRequired: !connected,
            instanceMismatch: false,
            organizationId: null,
            organizationSelectionLoaded: false,
          })
        ).toBe('loading');
      }
    }
  });
});

describe('selectPrReviewConnectAction', () => {
  const base = {
    platform: 'gitlab' as const,
    view: 'connect' as const,
    organizationId: 'org_1',
    canManageOrganizationBilling: false,
  };

  it('a personal scope keeps the CTA for every role', () => {
    for (const platform of ['gitlab', 'bitbucket'] as const) {
      for (const view of ['connect', 'reconnect'] as const) {
        expect(
          selectPrReviewConnectAction({
            ...base,
            platform,
            view,
            organizationId: null,
          })
        ).toBe('connect');
      }
    }
  });

  it('a first-time GitLab connect keeps the CTA for a member', () => {
    // The organization GitLab OAuth connect only requires a billing role when
    // a connection already exists, so a first-time connect stays member-level.
    expect(selectPrReviewConnectAction(base)).toBe('connect');
  });

  it('an organization GitLab re-authorization explains the role for a member', () => {
    expect(selectPrReviewConnectAction({ ...base, view: 'reconnect' })).toBe(
      'organization-admin-only'
    );
  });

  it('an organization Bitbucket connect explains the role for a member', () => {
    expect(selectPrReviewConnectAction({ ...base, platform: 'bitbucket' })).toBe(
      'organization-admin-only'
    );
  });

  it('a billing role keeps the CTA wherever the server accepts it', () => {
    for (const platform of ['gitlab', 'bitbucket'] as const) {
      for (const view of ['connect', 'reconnect'] as const) {
        expect(
          selectPrReviewConnectAction({
            ...base,
            platform,
            view,
            canManageOrganizationBilling: true,
          })
        ).toBe('connect');
      }
    }
  });

  it('an unsettled role read keeps the CTA where a member would lose it', () => {
    // The provider procedures stay server-authorized, so neither a loading nor
    // a failed memberships read may strand the reader without an action.
    for (const platform of ['gitlab', 'bitbucket'] as const) {
      for (const view of ['connect', 'reconnect'] as const) {
        expect(
          selectPrReviewConnectAction({
            ...base,
            platform,
            view,
            canManageOrganizationBilling: null,
          })
        ).toBe('connect');
      }
    }
  });
});
