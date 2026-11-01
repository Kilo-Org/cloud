import { describe, expect, it } from 'vitest';

import { parseProviderPrRoute, providerPrRoutePath } from './provider-pr-ref';
import { parseProviderPrUrl } from './provider-pr-url';
import { gitlabInstanceMismatch, selectPrReviewGateView } from './pr-review-connect-gate-view';

/** A GitHub arm with everything settled and connected. */
const githubBase = {
  platform: 'github' as const,
  isError: false,
  isLoading: false,
  connected: true,
  reconnectRequired: false,
  instanceMismatch: false,
  organizationId: null,
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
      })
    ).toBe('org-only');
  });
});

describe('gitlabInstanceMismatch', () => {
  const connected = 'https://gitlab.com';

  it('names both hosts when the merge request lives on another instance', () => {
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'https://gitlab.example.com',
        connectedInstanceUrl: connected,
      })
    ).toEqual({ connectedHost: 'gitlab.com', requestedHost: 'gitlab.example.com' });
  });

  it('compares origins the way the server does — scheme, path and case are not the instance', () => {
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'http://GitLab.Example.COM/group/sub/',
        connectedInstanceUrl: 'https://gitlab.example.com/',
      })
    ).toBeNull();
  });

  it('treats a different port as another instance', () => {
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'https://gitlab.example.com:8443',
        connectedInstanceUrl: 'https://gitlab.example.com',
      })
    ).toEqual({ connectedHost: 'gitlab.example.com', requestedHost: 'gitlab.example.com:8443' });
  });

  it('has no mismatch to report when either side names no host', () => {
    // The route carries a hint only when the link named one; without it the
    // account's connected instance is the one the read would use.
    expect(
      gitlabInstanceMismatch({ instanceHint: undefined, connectedInstanceUrl: connected })
    ).toBeNull();
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'https://gitlab.example.com',
        connectedInstanceUrl: undefined,
      })
    ).toBeNull();
  });

  it('reads the instance out of a stored self-managed URL', () => {
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'https://gitlab.com/group/repo',
        connectedInstanceUrl: 'https://gitlab.acme.dev/gitlab',
      })
    ).toEqual({ connectedHost: 'gitlab.acme.dev', requestedHost: 'gitlab.com' });
  });
});
