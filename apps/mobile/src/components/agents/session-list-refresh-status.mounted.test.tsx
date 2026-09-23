import { createElement, type ElementType, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { RefreshControl } from '@/components/ui/refresh-control';
import { RefreshProgress } from '@/components/ui/refresh-progress';
import { i18n } from '@/i18n';
import { MotionContext } from '@/lib/a11y/motion-context';

import { SessionListRefreshStatus } from './session-list-refresh-status';

// Mutable so a case can put the tree on Android (the reserved band carries the
// pull's in-flight state there) and under reduced motion (the platform control
// is inert, so a centered body draws the static progress instead).
const device = vi.hoisted(() => ({
  platform: { OS: 'android' as string },
  reducedMotion: false,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'NativeActivityIndicator',
  Platform: device.platform,
  Pressable: 'Pressable',
  RefreshControl: 'NativeRefreshControl',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ Loader2: 'Loader2' }));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({
    reducedMotion: device.reducedMotion,
    scrollAnimated: !device.reducedMotion,
  }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

const noop = (): void => undefined;

function policy(): { reducedMotion: boolean; scrollAnimated: boolean } {
  return { reducedMotion: device.reducedMotion, scrollAnimated: !device.reducedMotion };
}

/** The flat rows surfaces: the reserved band alone owns the pull indicator. */
function bandSurface(progressInBody?: boolean): ReactElement {
  return createElement(
    MotionContext.Provider,
    { value: policy() },
    createElement(SessionListRefreshStatus, {
      busy: true,
      failed: false,
      onRetry: noop,
      progressInBody,
    })
  );
}

/**
 * The no-match state of the Agents tab: the reserved band above a centered
 * refreshable body (`EmptyState` → `CenteredState` → `RefreshProgress`), both
 * fed by the same pull, so one pull must still draw one indicator.
 */
function pullSurface(progressInBody?: boolean): ReactElement {
  const refreshControl = createElement(RefreshControl, { refreshing: true, onRefresh: noop });
  return createElement(
    MotionContext.Provider,
    { value: policy() },
    createElement(SessionListRefreshStatus, {
      busy: true,
      failed: false,
      onRetry: noop,
      progressInBody,
    }),
    createElement(RefreshProgress, { refreshControl })
  );
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function mount(element: ReactElement): TestRenderer.ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  device.reducedMotion = false;
  device.platform.OS = 'android';
});

describe('SessionListRefreshStatus pull progress', () => {
  it('draws one indicator when the centered body owns the pull progress', () => {
    device.reducedMotion = true;
    // The no-match body's `RefreshProgress` is the pull's reduced-motion
    // indicator; the band must carry the "Updating" copy without a second one.
    const mounted = mount(pullSurface(true));
    expect(mounted.root.findAllByType('Loader2' as ElementType)).toHaveLength(1);
    const updating = mounted.root.findByProps({ message: i18n.t('agents.sessionList.updating') });
    expect(String(updating.props.className)).not.toContain('absolute');
  });

  it('keeps its own indicator when the centered body draws no pull progress', () => {
    device.reducedMotion = true;
    // A retry, or a surface whose body is not drawing the pull: the body has
    // no indicator, so the band keeps its own.
    expect(mount(bandSurface()).root.findAllByType('Loader2' as ElementType)).toHaveLength(1);
  });

  it('leaves the platform indicator in place without reduced motion', () => {
    // The body draws nothing while the platform control is live, so the band
    // keeps the spinner even where a centered body owns the pull.
    const mounted = mount(bandSurface(true));
    expect(mounted.root.findAllByType('NativeActivityIndicator' as ElementType)).toHaveLength(1);
    expect(mounted.root.findAllByType('Loader2' as ElementType)).toHaveLength(0);
  });

  it('draws the pull spinner on iOS once reduced motion parks the platform control', () => {
    device.platform.OS = 'ios';
    device.reducedMotion = true;
    // The app's `RefreshControl` parks the inset platform control while the
    // policy removes its rotation, so the reserved band — not the inert
    // platform indicator — is the pull's visual there.
    expect(mount(bandSurface()).root.findAllByType('Loader2' as ElementType)).toHaveLength(1);
  });

  it('leaves the pull visual to the iOS platform control without reduced motion', () => {
    device.platform.OS = 'ios';
    const mounted = mount(bandSurface());
    expect(mounted.root.findAllByType('Loader2' as ElementType)).toHaveLength(0);
    expect(mounted.root.findAllByType('NativeActivityIndicator' as ElementType)).toHaveLength(0);
  });
});
