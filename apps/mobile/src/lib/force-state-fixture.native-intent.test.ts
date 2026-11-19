import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { redirectSystemPath } from '@/app/+native-intent';
import { QueryClient } from '@tanstack/react-query';

import {
  applyForceStatePath,
  getForcedMode,
  isForcedProcedure,
  resetForceStateForTests,
  withForceState,
} from '@/lib/force-state-fixture';

const mapWebPath = vi.hoisted(() => vi.fn((_link: { path: string; initial: boolean }) => 'mapped'));

// The intent entry composes every link handler. The ones that load native
// modules are stubbed to "not mine", so a link reaches the web-path mapper the
// way an unhandled link does on a device.
vi.mock('expo-share-intent', () => ({ getShareExtensionKey: () => null }));
vi.mock('@/lib/deep-link-handler', () => ({ redirectSystemPath: mapWebPath }));
vi.mock('@/lib/app-actions/action-url-handler', () => ({ handleAppActionPath: () => false }));
vi.mock('@/lib/chat/remote-mcp-oauth-browser', () => ({ takeRemoteMcpRedirect: () => false }));
vi.mock('@/lib/glanceable/fixture-harness', () => ({ handleGlanceableFixturePath: () => false }));
vi.mock('@/lib/instance-picker-fixture', () => ({ instancePickerFixtureRoute: () => null }));
vi.mock('@/lib/locked-keychain-fixture', () => ({
  handleLockedKeychainFixturePath: () => false,
}));
vi.mock('@/lib/model-picker-fixture', () => ({ modelPickerFixtureRoute: () => null }));
vi.mock('@/lib/organization-invite-member-fixture', () => ({
  handleOrganizationInviteMemberFixturePath: () => false,
}));
vi.mock('@/lib/pr-review/pr-review-copy-fixture-route', () => ({
  handlePrReviewCopyFixturePath: () => false,
}));
vi.mock('@/lib/pr-review/pr-review-instance-fixture', () => ({
  handlePrReviewInstanceFixturePath: () => false,
}));
vi.mock('@/lib/profile-picker-fixture', () => ({ profilePickerFixtureRoute: () => null }));

const LINK = `kiloapp:///dev/force-state/retryable?next=${encodeURIComponent(
  'kiloapp:///(app)/(tabs)/(3_profile)/passkeys'
)}`;

beforeEach(() => {
  resetForceStateForTests();
  mapWebPath.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetForceStateForTests();
});

describe('force-state intent entry', () => {
  it('forces the mode, then resolves the next link as that link alone resolves', () => {
    expect(redirectSystemPath({ path: LINK, initial: false })).toBe('mapped');

    expect(getForcedMode()).toBe('retryable');
    expect(mapWebPath).toHaveBeenCalledExactlyOnceWith({
      path: 'kiloapp:///(app)/(tabs)/(3_profile)/passkeys',
      initial: false,
    });
  });

  it('does nothing in a release build: the link reaches the web-path mapper as it is', () => {
    vi.stubGlobal('__DEV__', false);

    expect(redirectSystemPath({ path: LINK, initial: true })).toBe('mapped');

    expect(getForcedMode()).toBeNull();
    expect(mapWebPath).toHaveBeenCalledExactlyOnceWith({ path: LINK, initial: true });
  });

  it('guards itself in a release build, whatever the caller checks', () => {
    vi.stubGlobal('__DEV__', false);
    const plainFetch: typeof fetch = vi.fn<typeof fetch>();

    expect(applyForceStatePath(LINK, new QueryClient())).toBeUndefined();
    expect(getForcedMode()).toBeNull();
    expect(isForcedProcedure('codeReviews.listForUser')).toBe(false);
    expect(withForceState(plainFetch)).toBe(plainFetch);
  });
});
