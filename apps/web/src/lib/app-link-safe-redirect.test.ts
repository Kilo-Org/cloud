import { UNIVERSAL_LINK_ROUTES } from '@kilocode/app-shared/universal-links';
import {
  APP_LINK_HANDOFF_FALLBACK,
  APP_LINK_HANDOFF_PATH,
  browserLandingPath,
  isAppLinkClaimed,
  resolveHandoffDestination,
} from './app-link-safe-redirect';

describe('browserLandingPath', () => {
  it('routes /profile through the interstitial', () => {
    expect(browserLandingPath('/profile')).toBe('/users/continue?to=%2Fprofile');
  });

  it('routes /profile with query through the interstitial, preserving query', () => {
    expect(browserLandingPath('/profile?auto_topup_setup=success')).toBe(
      '/users/continue?to=%2Fprofile%3Fauto_topup_setup%3Dsuccess'
    );
  });

  it('passes unclaimed paths through unchanged', () => {
    const unclaimed = [
      '/organizations/abc123',
      '/account-verification',
      '/sign-in-to-editor',
      '/users/accept-invite/x',
      '/c/promo',
      '/',
    ];
    for (const path of unclaimed) {
      expect(browserLandingPath(path)).toBe(path);
    }
  });

  it('routes every literal webPath from UNIVERSAL_LINK_ROUTES through the interstitial', () => {
    const literals = UNIVERSAL_LINK_ROUTES.map(r => r.webPath).filter(p => !p.includes('*'));
    for (const path of literals) {
      expect(browserLandingPath(path)).toBe(
        `${APP_LINK_HANDOFF_PATH}?to=${encodeURIComponent(path)}`
      );
    }
  });

  describe('wildcard row instantiations (criterion-4 regression guard)', () => {
    const wildcardInstantiations: Record<string, string> = {
      '/code-reviews/*': '/code-reviews/abc',
      '/organizations/*/security-agent': '/organizations/o1/security-agent',
      '/organizations/*/security-agent/findings': '/organizations/o1/security-agent/findings',
      '/organizations/*/code-reviews': '/organizations/o1/code-reviews',
      '/organizations/*/code-reviews/*': '/organizations/o1/code-reviews/r2',
    };

    for (const [pattern, concrete] of Object.entries(wildcardInstantiations)) {
      it(`routes wildcard ${pattern} instantiation ${concrete} through the interstitial`, () => {
        expect(browserLandingPath(concrete)).toBe(
          `${APP_LINK_HANDOFF_PATH}?to=${encodeURIComponent(concrete)}`
        );
      });
    }
  });

  it('passes excluded row through unchanged', () => {
    expect(browserLandingPath('/code-reviews/review-md')).toBe('/code-reviews/review-md');
  });
});

describe('isAppLinkClaimed', () => {
  it('rejects absolute URLs with foreign hosts', () => {
    expect(isAppLinkClaimed('https://evil.com/profile')).toBe(false);
  });

  it('rejects protocol-relative URLs', () => {
    expect(isAppLinkClaimed('//evil.com/profile')).toBe(false);
  });

  it('rejects paths with backslash', () => {
    expect(isAppLinkClaimed(String.raw`/\evil`)).toBe(false);
  });

  it('rejects javascript: pseudo-URLs', () => {
    expect(isAppLinkClaimed('javascript:alert(1)')).toBe(false);
  });

  it('rejects paths without leading slash', () => {
    expect(isAppLinkClaimed('profile')).toBe(false);
  });

  it('accepts claimed paths', () => {
    expect(isAppLinkClaimed('/profile')).toBe(true);
    expect(isAppLinkClaimed('/claw')).toBe(true);
    expect(isAppLinkClaimed('/cloud/sessions')).toBe(true);
  });

  it('rejects unclaimed paths', () => {
    expect(isAppLinkClaimed('/organizations/abc123')).toBe(false);
    expect(isAppLinkClaimed('/account-verification')).toBe(false);
  });
});

describe('resolveHandoffDestination', () => {
  it('returns claimed destinations as-is', () => {
    expect(resolveHandoffDestination('/profile')).toBe('/profile');
    expect(resolveHandoffDestination('/claw')).toBe('/claw');
  });

  it('falls back to /profile for undefined', () => {
    expect(resolveHandoffDestination(undefined)).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for empty string', () => {
    expect(resolveHandoffDestination('')).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for array form (Next can produce array params)', () => {
    expect(resolveHandoffDestination(['/profile'])).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for absolute URLs', () => {
    expect(resolveHandoffDestination('https://evil.com')).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for protocol-relative URLs', () => {
    expect(resolveHandoffDestination('//evil.com')).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for multiple slashes prefix', () => {
    expect(resolveHandoffDestination('///evil.com')).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for backslash paths', () => {
    expect(resolveHandoffDestination(String.raw`/\\evil`)).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for javascript: pseudo-URLs', () => {
    expect(resolveHandoffDestination('javascript:alert(1)')).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for full http URLs to our domain', () => {
    expect(resolveHandoffDestination('http://app.kilo.ai/profile')).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  it('falls back to /profile for unclaimed valid paths', () => {
    expect(resolveHandoffDestination('/account-verification')).toBe(APP_LINK_HANDOFF_FALLBACK);
  });

  describe('round-trip for every literal claimed webPath', () => {
    const literals = UNIVERSAL_LINK_ROUTES.map(r => r.webPath).filter(p => !p.includes('*'));

    for (const path of literals) {
      it(`round-trips ${path}`, () => {
        const search = new URLSearchParams(browserLandingPath(path).split('?')[1]);
        expect(resolveHandoffDestination(search.get('to') ?? undefined)).toBe(path);
      });
    }
  });
});
