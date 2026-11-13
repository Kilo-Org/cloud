/* eslint-disable max-lines -- the mapping, ignore, and stash suites share one owned test file */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as UniversalLinks from '@kilocode/app-shared/universal-links';

import { redirectSystemPath } from './deep-link-handler';
import { openExternalUrl } from './external-link';
import {
  _resetDeepLinkLaunchForTests,
  _setGetLinkingURLForTests,
  _setSecureStoreForTests,
  captureLaunchDeepLink,
  getPendingDeepLink,
  getPendingDeepLinkSnapshot,
  setCurrentDeepLinkUserId,
  subscribeToPendingDeepLink,
} from './deep-link-launch';
import { setGitHubInstallReturnOutcome } from './github-install-return';
import { resolvePendingNavigation } from './pending-navigation';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  shouldThrow: false,
}));

vi.mock('expo-router', () => ({
  router: {
    navigate: mocks.navigate,
  },
}));

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

// `openExternalUrl` reads the build-time `__DEV__` global this node project does
// not define; the browser handoff only needs the call it makes.
vi.mock('./external-link', () => ({ openExternalUrl: vi.fn() }));

vi.mock('@kilocode/app-shared/universal-links', async importOriginal => {
  const actual = await importOriginal<typeof UniversalLinks>();
  return {
    ...actual,
    resolveIncomingResume: (raw: string) => {
      if (mocks.shouldThrow) {
        throw new Error('boom');
      }
      return actual.resolveIncomingResume(raw);
    },
  };
});

const MAPPED_CASES = [
  {
    path: 'https://app.kilo.ai/home',
    href: '/(app)/(tabs)/(0_home)',
  },
  {
    path: 'https://app.kilo.ai/profile',
    href: '/(app)/(tabs)/(3_profile)',
  },
  {
    path: 'https://app.kilo.ai/profile/preferences',
    href: '/(app)/(tabs)/(3_profile)/preferences',
  },
  {
    path: 'https://app.kilo.ai/cloud/sessions/ses_0123456789abcdefghijklmnop',
    href: '/(app)/agent-chat/ses_0123456789abcdefghijklmnop',
  },
  {
    path: 'https://app.kilo.ai/cloud/sessions/ses_0123456789abcdefghijklmnop?at=msg_42',
    href: '/(app)/agent-chat/ses_0123456789abcdefghijklmnop?at=msg_42',
  },
  {
    path: 'https://app.kilo.ai/cloud/sessions/ses_0123456789abcdefghijklmnop?at=msg%2042',
    href: '/(app)/agent-chat/ses_0123456789abcdefghijklmnop?at=msg%2042',
  },
  {
    path: 'https://app.kilo.ai/security-agent/findings',
    href: '/(app)/security-agent/personal/findings',
  },
  {
    path: 'https://app.kilo.ai/code-reviews/rev_9',
    href: '/(app)/code-reviewer/personal/reviews/rev_9',
  },
  {
    path: 'https://app.kilo.ai/organizations/org_1/code-reviews/rev_9',
    href: '/(app)/code-reviewer/org_1/reviews/rev_9',
  },
  {
    path: 'https://app.kilo.ai/s/share-token.abc-def',
    href: '/(app)/shared/share-token.abc-def',
  },
] as const;

describe('redirectSystemPath', () => {
  beforeEach(() => {
    _resetDeepLinkLaunchForTests();
    _setSecureStoreForTests({
      setItemAsync: async () => {
        await Promise.resolve();
      },
      deleteItemAsync: async () => {
        await Promise.resolve();
      },
      getItemAsync: async () => {
        await Promise.resolve();
        return null;
      },
    });
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
    it.each(MAPPED_CASES)('stashes $path and does not navigate', ({ path, href }) => {
      const result = redirectSystemPath({ path, initial: false });
      expect(result).toBeNull();
      expect(!result).toBe(true);
      expect(getPendingDeepLink()).toBe(href);
      expect(resolvePendingNavigation(href)).toEqual({
        href,
        method: 'navigate',
        withAnchor: true,
      });
      expect(mocks.navigate).not.toHaveBeenCalled();
    });
  });

  describe('removed mobile destinations', () => {
    it.each([
      'https://app.kilo.ai/claw',
      'https://app.kilo.ai/claw/?at=message',
      'kiloapp://claw',
      'kiloapp:///claw',
      'kiloapp://app.kilo.ai/claw',
      'kiloapp:///kiloclaw/settings',
      'kiloapp:///chat/sandbox-1/conversation-1',
      'kiloapp:///onboarding',
      'kiloapp:///(app)/(tabs)/(1_kiloclaw)/chat/instance-picker',
      'kiloapp:///%28app%29/%28tabs%29/%281_kiloclaw%29',
      '/(app)/(tabs)/(1_kiloclaw)',
      '/chat/sandbox-1/instance-picker',
    ])('opens the shell cold and leaves the current screen warm for %s', path => {
      expect(redirectSystemPath({ path, initial: true })).toBe('/');
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(mocks.navigate).not.toHaveBeenCalled();
    });
  });

  describe('a link that names no screen', () => {
    // Resolving one of these replaces the visible route and unmounts the screen
    // beneath it, so the unsaved state of that screen (an open form) is lost
    // even though the link opens nothing anyone asked for.
    it.each([
      'https://app.kilo.ai/admin',
      'https://app.kilo.ai/code-reviews/review-md',
      'https://example.com/profile',
      'not a url',
      'kiloapp:///',
      'kiloapp://',
      'kiloapp:///definitely-not-a-route',
      'kiloapp:///dev/unknown-fixture',
      // A session-family capture the store cannot address names no session.
      'kiloapp://agent-chat/ses:1',
      'kiloapp:///(app)/agent-chat/ses:1',
    ])('ignores %s without navigate or stash', path => {
      for (const initial of [true, false]) {
        expect(redirectSystemPath({ path, initial })).toBeNull();
        expect(getPendingDeepLink()).toBeNull();
        expect(mocks.navigate).not.toHaveBeenCalled();
      }
    });
  });

  describe('session destination', () => {
    it.each([
      // A capture the store's id rule refuses addresses no session: the route
      // could never read one, so the link opens nothing and the visible screen
      // keeps its state.
      'https://app.kilo.ai/cloud/sessions/ses:1',
      'kiloapp:///cloud/sessions/ses:1',
    ])('ignores %s, which the session route cannot address', path => {
      for (const initial of [true, false]) {
        expect(redirectSystemPath({ path, initial })).toBeNull();
        expect(getPendingDeepLink()).toBeNull();
        expect(mocks.navigate).not.toHaveBeenCalled();
      }
    });

    it.each([
      // Every id the session store can hold names a session the route can
      // address, including ones minted before the canonical shape and a ses_
      // id whose length drifted from it. The route's denial is the answer for
      // an id that does not resolve.
      ['an id minted before the canonical shape', 'xmw2l780h18'],
      ['a ses_ id longer than the canonical shape', 'ses_01J9FRESH000000000000000001'],
    ])('stashes %s for the session route', (_name, sessionId) => {
      for (const initial of [true, false]) {
        _resetDeepLinkLaunchForTests();
        expect(
          redirectSystemPath({ path: `kiloapp:///cloud/sessions/${sessionId}`, initial })
        ).toBeNull();
        expect(getPendingDeepLink()).toBe(`/(app)/agent-chat/${sessionId}`);
      }
    });

    it('still opens the composer from the `new` capture', () => {
      const path = 'kiloapp:///cloud/sessions/new';
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
      expect(getPendingDeepLink()).toBe('/(app)/agent-chat/new');
    });
  });

  describe('app route links', () => {
    // Dev, E2E and system-search links address the app's own routes. A route
    // inside the signed-in shell is stashed like a universal link, so the
    // layout's consumer navigates it with `withAnchor` and every stack keeps its
    // layout anchor beneath the target; a route the shell gates own is left to
    // the navigator exactly as before.
    it.each([
      'kiloapp:///(app)/(tabs)/(3_profile)/organization/invoices',
      'kiloapp:///(app)/(tabs)/(3_profile)/organization/credit-activity',
      'kiloapp:///(app)/(tabs)/(2_agents)',
      'kiloapp:///(app)/profile-management/34d743e6-7bb8-4dd1-880c-580bd8d907d5/variables',
      'kiloapp:///(app)/(tabs)/(3_profile)/preferences',
      '/(app)/agent-chat/new?mode=code',
      'kiloapp:///(app)/agent-chat/new?mode=code',
    ])('stashes %s for the anchored navigation', path => {
      const href = path.slice(path.indexOf('/('));
      for (const initial of [true, false]) {
        _resetDeepLinkLaunchForTests();
        const result = redirectSystemPath({ path, initial });
        expect(result).toBeNull();
        expect(getPendingDeepLink()).toBe(href);
        expect(resolvePendingNavigation(href)).toEqual({
          href,
          method: 'navigate',
          withAnchor: true,
        });
        expect(mocks.navigate).not.toHaveBeenCalled();
      }
    });

    it.each([
      'kiloapp:///(auth)/session-row-fixture',
      'kiloapp:///force-update',
      'kiloapp:///button-label-fixture',
      '/(auth)/login',
      'kiloapp://agent-chat/ses_0123456789abcdefghijklmnop',
      'kiloapp://security-agent/personal',
    ])('passes %s to the navigator without navigate or stash', path => {
      expect(redirectSystemPath({ path, initial: true })).toBe(path);
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
      expect(getPendingDeepLink()).toBeNull();
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it('keeps the launch capture as the only stash of a cold launch URL', () => {
      const path = 'kiloapp:///(app)/(tabs)/(3_profile)/organization/invoices';
      const notifications: (string | null)[] = [];
      const unsubscribe = subscribeToPendingDeepLink(() => {
        notifications.push(getPendingDeepLinkSnapshot());
      });
      _setGetLinkingURLForTests(() => path);
      captureLaunchDeepLink();
      expect(notifications).toEqual(['/(app)/(tabs)/(3_profile)/organization/invoices']);

      expect(redirectSystemPath({ path, initial: true })).toBeNull();
      // The capture already owns this launch URL: a second stash would rewrite
      // the durable mirror for the same link.
      expect(notifications).toHaveLength(1);

      // A warm arrival of the same link is a fresh tap and stashes again.
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
      expect(notifications).toHaveLength(2);
      unsubscribe();
    });

    it('leaves the route a moved search family names with the search slot', () => {
      // Ids indexed before the security-agent route moved keep the profile
      // tab's group segment; they are search taps, not links handed to the app.
      const path = 'kiloapp:///(app)/(tabs)/(3_profile)/security-agent/finding-1';
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
      expect(getPendingDeepLink()).toBeNull();
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

    it('warm kiloapp://profile stashes group href and returns null', () => {
      const result = redirectSystemPath({ path: 'kiloapp://profile', initial: false });
      expect(result).toBeNull();
      expect(!result).toBe(true);
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it('drops an app-scheme search-family link captured while signed out', () => {
      // The app scheme is how Android delivers a tap on an indexed result, so
      // the identifier is bound to the account that indexed it: a signed-out
      // capture must not reach the next account's shell.
      setCurrentDeepLinkUserId(null);
      const result = redirectSystemPath({
        path: 'kiloapp://pr-review/Kilo-Org/cloud/6234',
        initial: false,
      });

      expect(result).toBeNull();
      expect(getPendingDeepLinkSnapshot()).toBeNull();

      setCurrentDeepLinkUserId('user-b');
      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });

    it('keeps an https link to the same family for the next account', () => {
      setCurrentDeepLinkUserId(null);
      redirectSystemPath({
        path: 'https://app.kilo.ai/pr-review/Kilo-Org/cloud/6234',
        initial: false,
      });

      setCurrentDeepLinkUserId('user-b');
      expect(getPendingDeepLinkSnapshot()).toBe('/(app)/pr-review/Kilo-Org/cloud/6234');
    });
  });

  describe('resume anchor', () => {
    it('reads and re-encodes the decoded anchor exactly once', () => {
      redirectSystemPath({
        path: 'kiloapp:///cloud/sessions/ses_0123456789abcdefghijklmnop?at=msg%2042',
        initial: false,
      });
      expect(getPendingDeepLink()).toBe(
        '/(app)/agent-chat/ses_0123456789abcdefghijklmnop?at=msg%2042'
      );
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it('keeps hrefs without an anchor byte-identical', () => {
      redirectSystemPath({
        path: 'https://app.kilo.ai/cloud/sessions/ses_0123456789abcdefghijklmnop',
        initial: false,
      });
      expect(getPendingDeepLink()).toBe('/(app)/agent-chat/ses_0123456789abcdefghijklmnop');

      redirectSystemPath({
        path: 'https://app.kilo.ai/cloud/sessions?github_install=success',
        initial: false,
      });
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(2_agents)');
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

    it('cold launch capture keeps the resume anchor the cold path would drop', () => {
      // The synchronous launch capture runs first and owns the slot. If it
      // stashed the anchor-less href, expo-router's cold path would skip its
      // restash (see the dedup test above) and the anchor would be lost.
      _setGetLinkingURLForTests(
        () => 'https://app.kilo.ai/cloud/sessions/ses_0123456789abcdefghijklmnop?at=msg_42'
      );
      captureLaunchDeepLink();
      expect(getPendingDeepLinkSnapshot()).toBe(
        '/(app)/agent-chat/ses_0123456789abcdefghijklmnop?at=msg_42'
      );

      const result = redirectSystemPath({
        path: 'https://app.kilo.ai/cloud/sessions/ses_0123456789abcdefghijklmnop?at=msg_42',
        initial: true,
      });

      expect(result).toBeNull();
      expect(getPendingDeepLink()).toBe(
        '/(app)/agent-chat/ses_0123456789abcdefghijklmnop?at=msg_42'
      );
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
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(2_agents)');

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
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
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
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(2_agents)');

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
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(2_agents)');

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
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(2_agents)');

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

// Android's intent filter for the organization root also matches the two web
// create pages (a `pathPattern` cannot exclude segments), so the app has to
// hand them back to the browser instead of navigating nowhere.
describe('organization pages the app has no screen for', () => {
  it.each(['new', 'create'])(
    'hands /organizations/%s to the browser instead of navigating',
    async page => {
      _resetDeepLinkLaunchForTests();
      vi.mocked(openExternalUrl).mockClear();

      const result = redirectSystemPath({
        path: `https://app.kilo.ai/organizations/${page}`,
        initial: false,
      });

      // Falsy, like every handled link: a truthy return re-dispatches the
      // linking resolver and races our navigation.
      expect(result).toBeNull();
      await vi.waitFor(() => {
        expect(openExternalUrl).toHaveBeenCalledWith(`https://app.kilo.ai/organizations/${page}`);
      });
      expect(getPendingDeepLink()).toBeNull();
    }
  );

  it('still stashes the organization root itself', () => {
    redirectSystemPath({ path: 'https://app.kilo.ai/organizations/org_1', initial: false });
    expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)/organization/org_1');
  });

  // One tap is one browser tab: the layout's synchronous launch capture opens
  // the page, and expo-router's cold redirect of the same launch URL must not
  // open it a second time. The capture's opener is awaited first because both
  // handoffs share one lazily imported module: two concurrent dynamic imports
  // of it race in the test environment.
  it.each(['new', 'create'])('opens /organizations/%s once on a cold launch', async page => {
    _resetDeepLinkLaunchForTests();
    vi.mocked(openExternalUrl).mockClear();
    const url = `https://app.kilo.ai/organizations/${page}`;
    _setGetLinkingURLForTests(() => url);

    captureLaunchDeepLink();
    await vi.waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledTimes(1);
    });

    expect(redirectSystemPath({ path: url, initial: true })).toBe('/');

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith(url);
    expect(getPendingDeepLink()).toBeNull();
  });

  // The capture reads the raw launch URL while expo-router passes its own
  // `path`; the same page can be spelled differently, so the skip compares the
  // normalized browser URL rather than the raw strings.
  it('does not open an app-scheme spelling of the captured page again', async () => {
    _resetDeepLinkLaunchForTests();
    vi.mocked(openExternalUrl).mockClear();
    const normalized = 'https://app.kilo.ai/organizations/new';
    _setGetLinkingURLForTests(() => 'kiloapp:///organizations/new');

    captureLaunchDeepLink();
    await vi.waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledWith(normalized);
    });
    vi.mocked(openExternalUrl).mockClear();

    expect(redirectSystemPath({ path: normalized, initial: true })).toBe('/');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('still opens a different create page on an initial redirect', async () => {
    _resetDeepLinkLaunchForTests();
    vi.mocked(openExternalUrl).mockClear();
    _setGetLinkingURLForTests(() => 'https://app.kilo.ai/organizations/new');

    captureLaunchDeepLink();
    await vi.waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledTimes(1);
    });
    vi.mocked(openExternalUrl).mockClear();

    expect(
      redirectSystemPath({ path: 'https://app.kilo.ai/organizations/create', initial: true })
    ).toBe('/');
    await vi.waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledWith('https://app.kilo.ai/organizations/create');
    });
  });

  // A warm arrival is a live tap of its own, never the cold launch again.
  it('still opens a warm arrival after a captured launch handoff', async () => {
    _resetDeepLinkLaunchForTests();
    vi.mocked(openExternalUrl).mockClear();
    const url = 'https://app.kilo.ai/organizations/new';
    _setGetLinkingURLForTests(() => url);

    captureLaunchDeepLink();
    await vi.waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledTimes(1);
    });

    expect(redirectSystemPath({ path: url, initial: true })).toBe('/');
    expect(openExternalUrl).toHaveBeenCalledTimes(1);

    expect(redirectSystemPath({ path: url, initial: false })).toBeNull();
    await vi.waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledTimes(2);
    });
  });
});
