// The session changes header draws the capture time on its eyebrow line. This
// suite pins where that line comes from: reserved with a placeholder bar while
// a read can still answer with a time, the label once it does, and no line at
// all when the session settles without a capture and without a session diff —
// a reserved line there would leave the title above a gap no label ever fills.

import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenHeader } from '@/components/screen-header';
import { SessionChangesScreen } from '@/components/session-changes/session-changes-screen';

const state = vi.hoisted(() => ({
  data: {} satisfies Record<string, unknown>,
  file: {} satisfies Record<string, unknown>,
  review: {} satisfies Record<string, unknown>,
}));

vi.mock('@/components/session-changes/use-session-changes-data', () => ({
  useSessionChangesData: () => state.data,
}));
vi.mock('@/components/session-changes/use-session-changes-file', () => ({
  useSessionChangesFile: () => state.file,
}));
vi.mock('@/components/session-changes/use-session-changes-review', () => ({
  useSessionChangesReview: () => state.review,
}));
vi.mock('@/components/session-changes/session-changes-body', () => ({
  SessionChangesBody: 'SessionChangesBody',
}));
vi.mock('@/components/session-changes/session-changes-comment-dialog', () => ({
  SessionChangesCommentDialog: 'SessionChangesCommentDialog',
}));
vi.mock('@/components/session-changes/session-changes-review-sheet', () => ({
  SessionChangesReviewSheet: 'SessionChangesReviewSheet',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/icons', () => ({
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  LogOut: 'LogOut',
  RefreshCw: 'RefreshCw',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/eyebrow-placeholder', () => ({
  EyebrowPlaceholder: 'EyebrowPlaceholder',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ foreground: '#000' }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => false }),
  useNavigationContainerRef: () => ({ addListener: () => () => undefined }),
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  StatusBar: { currentHeight: 24 },
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 800, fontScale: 1 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));

type ScreenHeaderProps = ComponentProps<typeof ScreenHeader>;

/** The capture the read answered with, or `null` while it has none. */
type Capture = { revision: number; capturedAt: string; files: never[]; truncated: boolean };

const CAPTURE: Capture = {
  revision: 3,
  capturedAt: '2026-11-17T15:52:00.000Z',
  files: [],
  truncated: false,
};

/**
 * The read states the header decides on. A session with a Cloud Agent reads its
 * capture; a session without one reads the read-only session diff; and a read
 * that settled without either answers no capture time at all.
 */
function changesData({
  sessionPending = false,
  cloudAgentSessionId = null,
  readOnly = false,
  changesPending = false,
  snapshot = null,
  legacy = {},
}: {
  sessionPending?: boolean;
  cloudAgentSessionId?: string | null;
  readOnly?: boolean;
  changesPending?: boolean;
  snapshot?: Capture | null;
  legacy?: { isSuccess?: boolean; isPending?: boolean; isError?: boolean };
}): Record<string, unknown> {
  return {
    sessionQuery: { isPending: sessionPending, isError: false, refetch: vi.fn() },
    cloudAgentSessionId,
    readOnly,
    changesQuery: { isPending: changesPending, isError: false, refetch: vi.fn() },
    snapshot,
    legacyDiffQuery: {
      isSuccess: legacy.isSuccess ?? false,
      isPending: legacy.isPending ?? false,
      isError: legacy.isError ?? false,
      dataUpdatedAt: 1_760_000_000_000,
      data: undefined,
      refetch: vi.fn(),
    },
    legacyFiles: null,
    feedback: { status: 'idle' },
    failure: null,
    refresh: vi.fn(),
    cloudSessionQuery: { isError: false, refetch: vi.fn() },
    cloudSession: undefined,
    organizationId: undefined,
    changesKey: [],
  };
}

beforeEach(() => {
  state.data = changesData({});
  state.file = {
    capture: null,
    fileQuery: { isPending: false, isError: false, refetch: vi.fn() },
    commentsForFile: [],
    patchState: { kind: 'idle' },
  };
  state.review = {
    dialog: null,
    commentTarget: null,
    commentError: undefined,
    sendError: undefined,
    reviewOpen: false,
    sent: false,
    sending: false,
    reviewBlock: null,
    initialCommentText: '',
    setReviewOpen: vi.fn(),
    setSendError: vi.fn(),
    resetCommentError: vi.fn(),
    openComment: vi.fn(),
    submitComment: vi.fn(),
    cancelComment: vi.fn(),
    sendReview: vi.fn(),
    discardReview: vi.fn(),
    removeComment: vi.fn(),
  };
});

function renderScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SessionChangesScreen, { sessionId: 'ses-1' }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function headerProps(renderer: TestRenderer.ReactTestRenderer): ScreenHeaderProps {
  return renderer.root.findByType(ScreenHeader).props as ScreenHeaderProps;
}

describe('session changes header eyebrow', () => {
  it('reserves the line with a placeholder bar while the capture time loads', () => {
    state.data = changesData({ sessionPending: true });
    const renderer = renderScreen();
    const header = headerProps(renderer);

    expect(header.eyebrow).toBeUndefined();
    expect(header.reserveEyebrow).toBe(true);
    expect(header.eyebrowPlaceholder).toBeTruthy();
    renderer.unmount();
  });

  it('keeps the wire open while the Cloud Agent capture read can still answer', () => {
    state.data = changesData({ cloudAgentSessionId: 'ca-1', changesPending: true });
    const renderer = renderScreen();
    const header = headerProps(renderer);

    expect(header.eyebrow).toBeUndefined();
    expect(header.reserveEyebrow).toBe(true);
    expect(header.eyebrowPlaceholder).toBeTruthy();
    renderer.unmount();
  });

  it('paints the capture time once the read answers', () => {
    state.data = changesData({ cloudAgentSessionId: 'ca-1', snapshot: CAPTURE });
    const renderer = renderScreen();
    const header = headerProps(renderer);

    expect(header.eyebrow).toBe('agentChat.sessionChanges.asOf');
    expect(header.reserveEyebrow).toBeUndefined();
    expect(header.eyebrowPlaceholder).toBeUndefined();
    renderer.unmount();
  });

  it('reserves no eyebrow when the session settled without a capture and without a diff', () => {
    state.data = changesData({
      readOnly: true,
      legacy: { isPending: false, isError: true },
    });
    const renderer = renderScreen();
    const header = headerProps(renderer);

    // No label can arrive, so the title centres on the back control alone
    // instead of sitting above a line nothing fills.
    expect(header.eyebrow).toBeUndefined();
    expect(header.reserveEyebrow).toBeUndefined();
    expect(header.eyebrowPlaceholder).toBeUndefined();
    renderer.unmount();
  });
});
