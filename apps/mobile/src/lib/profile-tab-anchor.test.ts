// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { findingDetailBackTarget, findingDetailHasLocalHistory } from './finding-detail-back';
import { getSecurityAgentPath } from './security-agent';
import { profileTabPressListeners } from './tab-press-listeners';
import { __resetTabSwitchInputForTests } from './tab-switch-input-gate';

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));

// The `showBackButton` wiring itself (that `FindingDetailScreen` passes
// `showBackButton` to `ScreenHeader` in the loaded/notFound/error/loading
// states) is not rendered here: the mobile pure vitest project is logic-only
// (node environment, no React mounting). Instead the source-read pin below
// asserts the forced back control stays wired to every `ScreenHeader`, so
// removing it fails the suite.

describe('findingDetailHasLocalHistory', () => {
  it('reports local history when the nested Stack has a screen beneath the detail', () => {
    // findings-list -> detail pushes the detail on top of the list, index > 0.
    expect(findingDetailHasLocalHistory({ index: 2 })).toBe(true);
  });

  it('reports no local history when the detail is the only route (push/deep-link)', () => {
    expect(findingDetailHasLocalHistory({ index: 0 })).toBe(false);
  });

  it('reports no local history when the state is absent', () => {
    expect(findingDetailHasLocalHistory(undefined)).toBe(false);
  });
});

describe('findingDetailBackTarget', () => {
  it('pops when there is local history (findings-list -> finding)', () => {
    expect(findingDetailBackTarget(true, 'personal')).toEqual({ kind: 'pop' });
  });

  it('replaces with the scope findings list when a push/deep-link has no local history', () => {
    expect(findingDetailBackTarget(false, 'personal')).toEqual({
      kind: 'replace',
      href: getSecurityAgentPath('personal', 'findings'),
    });
  });
});

describe('finding detail back control wiring', () => {
  // Source-read fallback: the pure project cannot mount the screen, so pin the
  // forced back control by reading the source and asserting every `ScreenHeader`
  // usage passes `showBackButton`. This fails if the control is removed from any
  // of the four states (loaded, notFound, error, loading).
  const screenPath = fileURLToPath(
    new URL('../components/security-agent/finding-detail-screen.tsx', import.meta.url)
  );
  const source = readFileSync(screenPath, 'utf8');
  const screenHeaderCount = (source.match(/<ScreenHeader\b/g) ?? []).length;
  const showBackButtonCount = (source.match(/\bshowBackButton\b/g) ?? []).length;

  it('renders a ScreenHeader in all four states', () => {
    expect(screenHeaderCount).toBe(4);
  });

  it('passes showBackButton on every ScreenHeader usage', () => {
    expect(showBackButtonCount).toBe(screenHeaderCount);
  });
});

describe('profile tab anchor', () => {
  // The profile tab stack anchors its initial route to `index` so a cold
  // push-open builds the stack with the profile root underneath, and a tab
  // re-press returns to the profile root. Pin the anchor by reading the layout
  // source; this fails if `initialRouteName: 'index'` is removed.
  const layoutPath = fileURLToPath(
    new URL('../app/(app)/(tabs)/(3_profile)/_layout.tsx', import.meta.url)
  );
  const layoutSource = readFileSync(layoutPath, 'utf8');
  it("declares initialRouteName: 'index'", () => {
    expect(layoutSource).toMatch(/initialRouteName:\s*'index'/);
  });
});

describe('profile tab press', () => {
  // The re-press resets through the shared plan (`planProfileTabPress`), which
  // dispatches a targeted stack pop so the unsaved-changes guard can intercept
  // it; a cross-tab press and a form-sheet leaf are left to the navigator, which
  // keeps the tab's stack.
  const PROFILE_SEGMENTS = ['(app)', '(tabs)', '(3_profile)'];
  const HOME_SEGMENTS = ['(app)', '(tabs)', '(0_home)'];

  function pressProfileTab({
    segments,
    stackKey = 'profile-stack',
    stackIndex = 0,
  }: Readonly<{ segments: string[]; stackKey?: string; stackIndex?: number }>) {
    const preventDefault = vi.fn<() => void>();
    const dispatch = vi.fn<(action: { type: string; target?: string }) => void>();

    profileTabPressListeners(segments)({
      navigation: {
        isFocused: () => true,
        getState: () => ({
          routes: [{ name: '(3_profile)', state: { key: stackKey, index: stackIndex } }],
        }),
        dispatch,
      },
    }).tabPress({ preventDefault });

    return { preventDefault, dispatch };
  }

  afterEach(() => {
    __resetTabSwitchInputForTests();
  });

  it('leaves a cross-tab press to the navigator so the tab keeps its stack', () => {
    const { preventDefault, dispatch } = pressProfileTab({
      segments: HOME_SEGMENTS,
      stackIndex: 2,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves a re-press at the profile root to the navigator', () => {
    const { preventDefault, dispatch } = pressProfileTab({ segments: PROFILE_SEGMENTS });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('pops back to the profile root from a screen above it', () => {
    const { preventDefault, dispatch } = pressProfileTab({
      segments: PROFILE_SEGMENTS,
      stackIndex: 2,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'POP_TO_TOP', target: 'profile-stack' });
  });
});
