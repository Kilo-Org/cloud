import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetDeepLinkLaunchForTests,
  _setGetLinkingURLForTests,
  _setSecureStoreForTests,
  captureLaunchDeepLink,
  getPendingDeepLink,
} from '@/lib/deep-link-launch';

import { handleAppActionPath } from './action-url-handler';
import { getPendingAppAction, takePendingAppAction } from './pending-app-action';

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

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
  takePendingAppAction();
});

afterEach(() => {
  _resetDeepLinkLaunchForTests();
  takePendingAppAction();
});

describe('handleAppActionPath', () => {
  it('stashes a session URL on the universal-link rails', () => {
    expect(
      handleAppActionPath({
        path: 'kiloapp:///actions/open-session?sessionId=ses_1',
        initial: false,
      })
    ).toBe(true);
    expect(getPendingDeepLink()).toBe('/(app)/agent-chat/ses_1');
    expect(getPendingAppAction()).toBeNull();
  });

  it('stashes a review URL on the universal-link rails', () => {
    expect(
      handleAppActionPath({
        path: 'kiloapp:///actions/open-pull-request?pullRequest=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F7',
        initial: false,
      })
    ).toBe(true);
    expect(getPendingDeepLink()).toBe('/(app)/pr-review/o/r/7');
  });

  it('accepts the scheme-less path expo-router hands redirectSystemPath', () => {
    expect(
      handleAppActionPath({ path: '/actions/open-session?sessionId=ses_1', initial: true })
    ).toBe(true);
    expect(getPendingDeepLink()).toBe('/(app)/agent-chat/ses_1');
  });

  it('leaves anything that is not an action URL to the caller', () => {
    expect(handleAppActionPath({ path: 'https://app.kilo.ai/home', initial: true })).toBe(false);
    expect(handleAppActionPath({ path: '/actions/open-session', initial: true })).toBe(false);
    expect(getPendingAppAction()).toBeNull();
    expect(getPendingDeepLink()).toBeNull();
  });

  it('parks OpenNeedsInput and opens nothing', () => {
    expect(
      handleAppActionPath({ path: 'kiloapp:///actions/open-needs-input', initial: true })
    ).toBe(true);
    expect(takePendingAppAction()).toEqual({ action: 'OpenNeedsInput' });
    expect(getPendingDeepLink()).toBeNull();
  });

  it('parks StartAgent with the prompt it carries', () => {
    expect(
      handleAppActionPath({
        path: 'kiloapp:///actions/start-agent?prompt=fix%20the%20build&repository=o%2Fr',
        initial: false,
      })
    ).toBe(true);
    expect(takePendingAppAction()).toEqual({
      action: 'StartAgent',
      prompt: 'fix the build',
      repository: 'o/r',
    });
  });

  it('parks a link the review resolvers do not recognize and opens nothing', () => {
    expect(
      handleAppActionPath({
        path: 'kiloapp:///actions/open-pull-request?pullRequest=https%3A%2F%2Fexample.com%2Fx',
        initial: false,
      })
    ).toBe(true);
    expect(getPendingDeepLink()).toBeNull();
    expect(takePendingAppAction()).toEqual({
      action: 'OpenPullRequest',
      pullRequest: 'https://example.com/x',
    });
  });

  it('does not re-stash a cold action when the launch capture already stashed', () => {
    _setGetLinkingURLForTests(() => 'https://app.kilo.ai/cloud/sessions/ses_9');
    captureLaunchDeepLink();
    expect(getPendingDeepLink()).toBe('/(app)/agent-chat/ses_9');
    expect(
      handleAppActionPath({
        path: 'kiloapp:///actions/open-session?sessionId=ses_1',
        initial: true,
      })
    ).toBe(true);
    expect(getPendingDeepLink()).toBeNull();
    // A warm arrival has no launch capture to guard against, so it stashes.
    expect(
      handleAppActionPath({
        path: 'kiloapp:///actions/open-session?sessionId=ses_1',
        initial: false,
      })
    ).toBe(true);
    expect(getPendingDeepLink()).toBe('/(app)/agent-chat/ses_1');
  });
});
