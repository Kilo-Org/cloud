import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetDeepLinkLaunchForTests,
  _setGetLinkingURLForTests,
  captureLaunchDeepLink,
  getPendingDeepLink,
  setPendingDeepLink,
} from './deep-link-launch';

describe('deep-link-launch', () => {
  beforeEach(() => {
    _resetDeepLinkLaunchForTests();
    vi.stubGlobal('__DEV__', true);
  });

  afterEach(() => {
    _resetDeepLinkLaunchForTests();
    vi.unstubAllGlobals();
  });

  describe('pending slot', () => {
    it('is single-shot get-and-clear', () => {
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'universal-link');
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
      expect(getPendingDeepLink()).toBeNull();
    });
  });

  describe('source precedence (order-independent)', () => {
    it('notification then universal-link leaves the link href', () => {
      setPendingDeepLink('/from-notification', 'notification');
      setPendingDeepLink('/from-link', 'universal-link');
      expect(getPendingDeepLink()).toBe('/from-link');
    });

    it('universal-link then notification leaves the link href', () => {
      setPendingDeepLink('/from-link', 'universal-link');
      setPendingDeepLink('/from-notification', 'notification');
      expect(getPendingDeepLink()).toBe('/from-link');
    });

    it('notification then notification leaves the latest notification href', () => {
      setPendingDeepLink('/notif-1', 'notification');
      setPendingDeepLink('/notif-2', 'notification');
      expect(getPendingDeepLink()).toBe('/notif-2');
    });
  });

  describe('captureLaunchDeepLink', () => {
    it('stashes a mapped launch URL synchronously', () => {
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/security-agent/findings');
      captureLaunchDeepLink();
      // Assert immediately — no await. The point of the test is synchronicity.
      expect(getPendingDeepLink()).toBe(
        '/(app)/(tabs)/(3_profile)/security-agent/personal/findings'
      );
    });

    it('is a no-op when the latch is already set (slot not overwritten)', () => {
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/profile');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');

      // Second call must not write again even if getLinkingURL returns a new URL.
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/claw');
      setPendingDeepLink('/pre-existing', 'notification');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBe('/pre-existing');
    });

    it('is a no-op when getLinkingURL returns null', () => {
      _setGetLinkingURLForTests(() => null);
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBeNull();
    });

    it('is a no-op for an unmapped/garbage URL', () => {
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/admin');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBeNull();

      // Latch only sets on a successful mapped capture; garbage still no-ops.
      _setGetLinkingURLForTests(() => 'not a url');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBeNull();
    });
  });
});
