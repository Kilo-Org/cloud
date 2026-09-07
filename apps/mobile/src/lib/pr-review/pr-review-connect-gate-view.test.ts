import { describe, expect, it } from 'vitest';

import { selectPrReviewGateView } from './pr-review-connect-gate-view';

/** A GitHub arm with everything settled and connected. */
const githubBase = {
  platform: 'github' as const,
  isError: false,
  isLoading: false,
  connected: true,
  revoked: false,
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

  it('a revoked connection asks to reconnect', () => {
    expect(selectPrReviewGateView({ ...githubBase, connected: false, revoked: true })).toBe(
      'reconnect'
    );
  });

  it('revoked never outranks a connected answer', () => {
    expect(selectPrReviewGateView({ ...githubBase, revoked: true })).toBe('children');
  });
});

describe('selectPrReviewGateView — GitLab (personal and org)', () => {
  for (const organizationId of [null, 'org_1']) {
    const base = {
      platform: 'gitlab' as const,
      isError: false,
      isLoading: false,
      connected: true,
      revoked: false,
      organizationId,
    };

    it(`scope ${organizationId ?? 'personal'}: connected renders children`, () => {
      expect(selectPrReviewGateView(base)).toBe('children');
    });

    it(`scope ${organizationId ?? 'personal'}: not connected asks to connect`, () => {
      expect(selectPrReviewGateView({ ...base, connected: false })).toBe('connect');
    });

    it(`scope ${organizationId ?? 'personal'}: a failed check is retryable, not Connect`, () => {
      expect(selectPrReviewGateView({ ...base, isError: true, connected: false })).toBe('error');
    });

    it(`scope ${organizationId ?? 'personal'}: a pending check is loading, not Connect`, () => {
      expect(selectPrReviewGateView({ ...base, isLoading: true, connected: false })).toBe('loading');
    });
  }
});

describe('selectPrReviewGateView — Bitbucket', () => {
  const orgBase = {
    platform: 'bitbucket' as const,
    isError: false,
    isLoading: false,
    connected: true,
    revoked: false,
    organizationId: 'org_1',
  };

  it('an org scope behaves like the other arms', () => {
    expect(selectPrReviewGateView(orgBase)).toBe('children');
    expect(selectPrReviewGateView({ ...orgBase, connected: false })).toBe('connect');
    expect(selectPrReviewGateView({ ...orgBase, isError: true })).toBe('error');
    expect(selectPrReviewGateView({ ...orgBase, isLoading: true, connected: false })).toBe('loading');
  });

  it('a personal scope is the terminal org-only state', () => {
    expect(
      selectPrReviewGateView({ ...orgBase, organizationId: null, connected: false })
    ).toBe('org-only');
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
});
