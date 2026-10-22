// Render coverage for the platform-gated status announcement. The pure table in
// `status-announcement.test.ts` covers `nextAnnouncement`; this suite covers the
// hook that owns the channel split (iOS speaks, Android's live region does) and
// the per-change dedupe that spans renders.
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStatusAnnouncement } from './status-announcement';

const accessibilityMock = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
  setAccessibilityFocus: vi.fn(),
}));

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' as 'ios' | 'android' },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
  findNodeHandle: vi.fn(),
  Platform: reactNativeMock.Platform,
}));

function StatusProbe({ message }: Readonly<{ message: string | null }>) {
  useStatusAnnouncement(message);
  return null;
}

function mount(message: string | null): ReactTestRenderer {
  const holder: { current?: ReactTestRenderer } = {};
  act(() => {
    holder.current = TestRenderer.create(<StatusProbe message={message} />);
  });
  if (!holder.current) {
    throw new Error('the status probe did not mount');
  }
  return holder.current;
}

function rerender(renderer: ReactTestRenderer, message: string | null): void {
  act(() => {
    renderer.update(<StatusProbe message={message} />);
  });
}

function announcements(): string[] {
  return accessibilityMock.announceForAccessibility.mock.calls.map(call => call[0] as string);
}

beforeEach(() => {
  accessibilityMock.announceForAccessibility.mockClear();
  accessibilityMock.setAccessibilityFocus.mockClear();
  reactNativeMock.Platform.OS = 'ios';
});

describe('useStatusAnnouncement on iOS', () => {
  it('announces a status that first appears', () => {
    mount('Failed to load');

    expect(announcements()).toEqual(['Failed to load']);
  });

  it('does not announce again when the same status re-renders', () => {
    const renderer = mount('Failed to load');

    rerender(renderer, 'Failed to load');

    expect(announcements()).toEqual(['Failed to load']);
    renderer.unmount();
  });

  it('does not announce a whitespace-only change to the same status', () => {
    const renderer = mount('Failed to load');

    // The effect re-runs for this new prop, so only the hook's `prevRef`
    // dedupe (not React's dependency check) can keep it silent.
    rerender(renderer, '  Failed to load  ');

    expect(announcements()).toEqual(['Failed to load']);
    renderer.unmount();
  });

  it('announces a changed status exactly once', () => {
    const renderer = mount('Failed to load');

    rerender(renderer, 'Reconnected');

    expect(announcements()).toEqual(['Failed to load', 'Reconnected']);
    renderer.unmount();
  });

  it('stays silent while the status is null', () => {
    const renderer = mount(null);

    expect(announcements()).toEqual([]);
    renderer.unmount();
  });

  it('announces nothing when a status clears', () => {
    const renderer = mount('Failed to load');

    rerender(renderer, null);

    expect(announcements()).toEqual(['Failed to load']);
    renderer.unmount();
  });

  it('announces the same text again after the status cleared', () => {
    const renderer = mount('Failed to load');

    rerender(renderer, null);
    rerender(renderer, 'Failed to load');

    expect(announcements()).toEqual(['Failed to load', 'Failed to load']);
    renderer.unmount();
  });
});

describe('useStatusAnnouncement on Android', () => {
  beforeEach(() => {
    reactNativeMock.Platform.OS = 'android';
  });

  it('leaves every announcement to the live region', () => {
    const renderer = mount('Failed to load');

    rerender(renderer, 'Reconnected');
    rerender(renderer, null);
    rerender(renderer, 'Reconnected');

    expect(announcements()).toEqual([]);
    renderer.unmount();
  });
});
