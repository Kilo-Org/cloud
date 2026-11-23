import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { noteLauncherSurfacesCleared } from '@/lib/launcher-surfaces-publish';

import { LauncherSurfacesMount } from './launcher-surfaces-mount';

// The native surface and every ambient hook the mount reads are stubbed: the
// assertions are about the publish/clear wiring and the memo's lifetime, not
// about the session query or the attention store (covered elsewhere).
const nativeMock = vi.hoisted(() => ({
  publishLauncherSurfaces: vi.fn<(payload: unknown) => void>(),
  clearLauncherSurfaces: vi.fn<() => void>(),
  consumePendingLaunchUrl: vi.fn<() => string | null>(() => null),
}));

const sessionsMock = vi.hoisted(() => ({
  activeSessions: [{ id: 'ses_wait', status: 'question', title: 'Waiting', connectionId: 'c1' }],
  isLoading: false,
  isError: false,
  hasAcceptedSuccess: true,
}));

const translate = vi.hoisted(() => (key: string) => key);

// The ack store's phase, as the mocked module hands it to the mount. A case
// drives it to `loading` and then settles it, which re-renders the mount.
const attentionHydration = vi.hoisted(() => ({
  current: 'ready' as 'loading' | 'ready' | 'failed',
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
// Stubbed like the other ambient helpers: the real module pulls in the i18n
// instance (and its catalog backend), which this DOM-free harness does not need.
vi.mock('@/lib/utils', () => ({ parseTimestamp: (value: string) => new Date(value) }));
vi.mock('@kilocode/app-shared/universal-links', () => ({ resolveIncomingUrl: () => null }));
vi.mock('@/lib/deep-link-launch', () => ({ setPendingDeepLink: vi.fn() }));
vi.mock('@/lib/native-launcher-surfaces', () => nativeMock);
vi.mock('@/lib/last-opened-session', () => ({
  getLastOpenedSession: () => null,
  subscribeLastOpenedSession: () => () => undefined,
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useLiveAgentSessions: () => sessionsMock,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({ useCurrentUserId: () => ({ userId: 'u1' }) }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'o1', isLoaded: true }),
}));
vi.mock('@/lib/session-attention', () => ({
  isAttentionAcked: () => false,
  reconcileSessionAttention: vi.fn(),
  // The phase is a variable so a case can drive the hold: the mount reads it
  // through the hook, and settling re-renders it.
  shouldShowNeedsInput: (input: { hydration: 'loading' | 'ready' | 'failed' }) =>
    input.hydration !== 'loading',
  useSessionAttentionHydration: () => attentionHydration.current,
  useSessionAttentionRevision: () => 0,
}));

const expectedPayload = {
  newAgentUrl: 'kiloapp:///cloud/sessions/new',
  newAgentLabel: 'glanceable.newAgent',
  needsInputUrl: 'kiloapp:///cloud/sessions/ses_wait',
  needsInputLabel: 'glanceable.needsInput',
  openLastSessionUrl: null,
  openLastSessionLabel: 'launcher.openLastSession',
};

function mount(): ReactTestRenderer {
  const ref: { current?: ReactTestRenderer } = {};
  act(() => {
    ref.current = TestRenderer.create(<LauncherSurfacesMount />);
  });
  if (!ref.current) {
    throw new Error('the launcher mount did not render');
  }
  return ref.current;
}

beforeEach(() => {
  nativeMock.publishLauncherSurfaces.mockClear();
  nativeMock.clearLauncherSurfaces.mockClear();
  attentionHydration.current = 'ready';
});

describe('LauncherSurfacesMount', () => {
  it('renders nothing and publishes the derived list', () => {
    const renderer = mount();

    expect(renderer.toJSON()).toBeNull();
    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledOnce();
    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledWith(expectedPayload);

    act(() => {
      renderer.unmount();
    });
  });

  it('does not rewrite the surface when a rerender derives the same list', () => {
    const renderer = mount();

    act(() => {
      renderer.update(<LauncherSurfacesMount />);
    });

    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledOnce();

    act(() => {
      renderer.unmount();
    });
  });

  it('writes the list back on the same mount after an account boundary clear', () => {
    const renderer = mount();
    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledOnce();

    // The boundary clears the surface while this mount stays up; its publisher
    // writes the same derivation again.
    nativeMock.clearLauncherSurfaces();
    noteLauncherSurfacesCleared();

    act(() => {
      renderer.update(<LauncherSurfacesMount />);
    });

    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledTimes(2);
    expect(nativeMock.publishLauncherSurfaces.mock.calls[1]?.[0]).toEqual(expectedPayload);

    act(() => {
      renderer.unmount();
    });
  });

  it('writes the list back on the mount after the sign-out path cleared the surface', () => {
    const first = mount();
    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledOnce();

    act(() => {
      first.unmount();
    });
    // The documented sign-out path drops the dynamic surfaces; the next mount
    // must rewrite them even though the derivation is identical.
    nativeMock.clearLauncherSurfaces();

    const second = mount();
    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledTimes(2);
    expect(nativeMock.publishLauncherSurfaces.mock.calls[1]?.[0]).toEqual(expectedPayload);

    act(() => {
      second.unmount();
    });
  });

  it('publishes nothing while the ack store loads, then publishes once it settles', () => {
    // While the store loads it answers "not acked" for every raise, so the
    // derived list would drop a shortcut the person already answered. The last
    // published set has to survive, exactly as it does before the first
    // successful read.
    attentionHydration.current = 'loading';
    const renderer = mount();

    expect(renderer.toJSON()).toBeNull();
    expect(nativeMock.publishLauncherSurfaces).not.toHaveBeenCalled();

    attentionHydration.current = 'ready';
    act(() => {
      renderer.update(<LauncherSurfacesMount />);
    });

    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledOnce();
    expect(nativeMock.publishLauncherSurfaces).toHaveBeenCalledWith(expectedPayload);

    act(() => {
      renderer.unmount();
    });
  });
});
