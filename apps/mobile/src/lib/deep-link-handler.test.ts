import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as UniversalLinks from '@kilocode/app-shared/universal-links';

import { redirectSystemPath } from './deep-link-handler';
import {
  _resetDeepLinkLaunchForTests,
  _setGetLinkingURLForTests,
  captureLaunchDeepLink,
  getPendingDeepLink,
} from './deep-link-launch';
import { setGitHubInstallReturnOutcome } from './github-install-return';

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
    setGitHubInstallReturnOutcome(null);
    mocks.navigate.mockReset();
    mocks.shouldThrow = false;
  });

  afterEach(() => {
    _resetDeepLinkLaunchForTests();
    setGitHubInstallReturnOutcome(null);
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

  describe('C13 return outcome', () => {
    it('stores success outcome from /cloud/sessions universal link with query params', async () => {
      const mod = await import('./github-install-return');
      // Store already reset by beforeEach.
      expect(mod.getGitHubInstallReturnOutcome()).toBeNull();

      const result = redirectSystemPath({
        path: 'https://app.kilo.ai/cloud/sessions?github_install=success',
        initial: false,
      });
      expect(result).toBeNull();
      expect(mocks.navigate).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)');

      // Outcome must be stored for the agents tab to read.
      const outcome = mod.getGitHubInstallReturnOutcome();
      expect(outcome).toEqual({ kind: 'success' });
    });

    it('does not store outcome for non-/cloud/sessions links', async () => {
      const mod = await import('./github-install-return');
      expect(mod.getGitHubInstallReturnOutcome()).toBeNull();

      const result = redirectSystemPath({
        path: 'https://app.kilo.ai/profile',
        initial: false,
      });
      expect(result).toBeNull();
      expect(mocks.navigate).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)');
      expect(mod.getGitHubInstallReturnOutcome()).toBeNull();
    });

    it('stores pending outcome from /cloud/sessions universal link', async () => {
      const mod = await import('./github-install-return');
      expect(mod.getGitHubInstallReturnOutcome()).toBeNull();

      const result = redirectSystemPath({
        path: 'https://app.kilo.ai/cloud/sessions?github_pending_approval=true',
        initial: false,
      });
      expect(result).toBeNull();
      expect(mocks.navigate).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)');

      const outcome = mod.getGitHubInstallReturnOutcome();
      expect(outcome).toEqual({ kind: 'pending' });
    });

    it('stores error outcome from /cloud/sessions universal link', async () => {
      const mod = await import('./github-install-return');
      expect(mod.getGitHubInstallReturnOutcome()).toBeNull();

      const result = redirectSystemPath({
        path: 'https://app.kilo.ai/cloud/sessions?error=installation_failed',
        initial: false,
      });
      expect(result).toBeNull();
      expect(mocks.navigate).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)');

      const outcome = mod.getGitHubInstallReturnOutcome();
      expect(outcome).toEqual({ kind: 'error', code: 'installation_failed' });
    });

    it('stores mismatch error outcome', async () => {
      const mod = await import('./github-install-return');
      expect(mod.getGitHubInstallReturnOutcome()).toBeNull();

      const result = redirectSystemPath({
        path: 'https://app.kilo.ai/cloud/sessions?error=install_state_user_mismatch',
        initial: false,
      });
      expect(result).toBeNull();
      expect(mocks.navigate).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)');

      const outcome = mod.getGitHubInstallReturnOutcome();
      expect(outcome).toEqual({ kind: 'error', code: 'install_state_user_mismatch' });
    });

    it('warm return stores outcome for already-mounted agents tab', async () => {
      const mod = await import('./github-install-return');
      expect(mod.getGitHubInstallReturnOutcome()).toBeNull();

      // Simulate warm deep-link return: initial=false.
      redirectSystemPath({
        path: 'https://app.kilo.ai/cloud/sessions?github_install=success',
        initial: false,
      });

      // Outcome stored; agents tab useFocusEffect can read it.
      expect(mod.getGitHubInstallReturnOutcome()).toEqual({ kind: 'success' });
      // Read clears the slot — subsequent reads return null.
      expect(mod.getGitHubInstallReturnOutcome()).toBeNull();
    });
  });
});
