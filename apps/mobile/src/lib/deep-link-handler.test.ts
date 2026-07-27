import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as UniversalLinks from '@kilocode/app-shared/universal-links';

import { redirectSystemPath } from './deep-link-handler';
import {
  _resetDeepLinkLaunchForTests,
  _setGetLinkingURLForTests,
  captureLaunchDeepLink,
  getPendingDeepLink,
} from './deep-link-launch';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  shouldThrow: false,
}));

vi.mock('expo-router', () => ({
  router: {
    navigate: mocks.navigate,
  },
}));

vi.mock('@kilocode/app-shared/universal-links', async importOriginal => {
  const actual = await importOriginal<typeof UniversalLinks>();
  return {
    ...actual,
    resolveIncomingUrl: (raw: string) => {
      if (mocks.shouldThrow) {
        throw new Error('boom');
      }
      return actual.resolveIncomingUrl(raw);
    },
  };
});

const MAPPED_CASES = [
  {
    path: 'https://app.kilo.ai/profile',
    href: '/(app)/(tabs)/(3_profile)',
  },
  {
    path: 'https://app.kilo.ai/security-agent/findings',
    href: '/(app)/(tabs)/(3_profile)/security-agent/personal/findings',
  },
  {
    path: 'https://app.kilo.ai/code-reviews/rev_9',
    href: '/(app)/(tabs)/(3_profile)/code-reviewer/personal/reviews/rev_9',
  },
] as const;

describe('redirectSystemPath', () => {
  beforeEach(() => {
    _resetDeepLinkLaunchForTests();
    mocks.navigate.mockReset();
    mocks.shouldThrow = false;
  });

  afterEach(() => {
    _resetDeepLinkLaunchForTests();
    mocks.shouldThrow = false;
  });

  describe('cold invariant', () => {
    it.each(MAPPED_CASES)('stashes $path and does not navigate', ({ path, href }) => {
      const result = redirectSystemPath({ path, initial: true });
      expect(result).toBeNull();
      expect(!result).toBe(true);
      expect(getPendingDeepLink()).toBe(href);
      expect(mocks.navigate).not.toHaveBeenCalled();
    });
  });

  describe('warm invariant', () => {
    it.each(MAPPED_CASES)('navigates $path and leaves pending empty', ({ path, href }) => {
      const result = redirectSystemPath({ path, initial: false });
      expect(result).toBeNull();
      expect(!result).toBe(true);
      expect(mocks.navigate).toHaveBeenCalledOnce();
      expect(mocks.navigate).toHaveBeenCalledWith(href);
      expect(getPendingDeepLink()).toBeNull();
    });
  });

  describe('passthrough', () => {
    it.each([
      'https://app.kilo.ai/admin',
      'https://app.kilo.ai/code-reviews/review-md',
      'https://example.com/profile',
      'not a url',
    ])('returns %s unchanged without navigate or stash', path => {
      const result = redirectSystemPath({ path, initial: true });
      expect(result).toBe(path);
      expect(getPendingDeepLink()).toBeNull();
      expect(mocks.navigate).not.toHaveBeenCalled();

      const warm = redirectSystemPath({ path, initial: false });
      expect(warm).toBe(path);
      expect(getPendingDeepLink()).toBeNull();
      expect(mocks.navigate).not.toHaveBeenCalled();
    });
  });

  describe('kiloapp:// forms', () => {
    it('cold kiloapp:///profile stashes group href and returns null', () => {
      const result = redirectSystemPath({ path: 'kiloapp:///profile', initial: true });
      expect(result).toBeNull();
      expect(!result).toBe(true);
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it('warm kiloapp://profile navigates group href and returns null', () => {
      const result = redirectSystemPath({ path: 'kiloapp://profile', initial: false });
      expect(result).toBeNull();
      expect(!result).toBe(true);
      expect(mocks.navigate).toHaveBeenCalledOnce();
      expect(mocks.navigate).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)');
      expect(getPendingDeepLink()).toBeNull();
    });
  });

  describe('launch-capture dedup', () => {
    it('cold initial does not restash when the launch capture already stashed the link', () => {
      _setGetLinkingURLForTests(() => 'kiloapp:///profile');
      captureLaunchDeepLink();
      // The gate effect can consume the slot before expo-router's cold path resolves.
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
      const result = redirectSystemPath({ path: 'kiloapp:///profile', initial: true });
      expect(result).toBeNull();
      // No restash — a later, unrelated effect re-run must find the slot empty.
      expect(getPendingDeepLink()).toBeNull();
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it('cold initial still stashes when the launch capture found no link', () => {
      _setGetLinkingURLForTests(() => null);
      captureLaunchDeepLink();
      const result = redirectSystemPath({ path: 'kiloapp:///profile', initial: true });
      expect(result).toBeNull();
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
      expect(mocks.navigate).not.toHaveBeenCalled();
    });
  });

  describe('synchronicity', () => {
    it('return value is not a Promise', () => {
      const result = redirectSystemPath({
        path: 'https://app.kilo.ai/profile',
        initial: true,
      });
      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toBeNull();
    });
  });

  describe('try/catch', () => {
    it('returns path unchanged when resolveIncomingUrl throws', () => {
      mocks.shouldThrow = true;
      const path = 'https://app.kilo.ai/profile';
      const result = redirectSystemPath({ path, initial: true });
      expect(result).toBe(path);
      expect(getPendingDeepLink()).toBeNull();
      expect(mocks.navigate).not.toHaveBeenCalled();
    });
  });
});
