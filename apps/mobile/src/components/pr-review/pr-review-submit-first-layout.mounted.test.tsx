/* eslint-disable require-await, @typescript-eslint/require-await -- the mocked hooks settle without await because they resolve immediately, matching the sibling submit suite */

// Regression for the review-submit sheet's first body frame. The sheet builds
// its body from two device reads that start on mount: the stored attribution
// footer preference (which seeds the summary and decides whether the queue card
// shows the block reason or the hint) and the stored pending queue. Painting a
// provisional body before both settled moved the queue card and the submit CTA
// under the reader once the preference arrived — the Android design gate
// measured 8.4 dp on the card paragraph and 5.7 dp on the button. The body must
// paint once, already carrying both settled reads.

import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewSubmit } from './pr-review-submit';

type Event =
  | { kind: 'frame' }
  | { kind: 'field'; value: string }
  | { kind: 'footer-hint' }
  | { kind: 'hint' }
  | { kind: 'block-reason'; message: string }
  | { kind: 'cta'; label: string };

// Every control the body is built from records its rendered props in order; the
// first body element opens a new frame, so the events slice into one frame per
// body render.
const record = vi.hoisted(() => ({ events: [] as Event[] }));

const footerPreference = vi.hoisted(() => {
  let state = { prReviewFooter: true, hasLoaded: false };
  const listeners = new Set<() => void>();
  return {
    read: () => state,
    write: (next: { prReviewFooter?: boolean; hasLoaded?: boolean }) => {
      state = { ...state, ...next };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      state = { prReviewFooter: true, hasLoaded: false };
      listeners.clear();
    },
  };
});

const pendingQueue = vi.hoisted(() => {
  let state = { items: [], hydrated: false };
  const listeners = new Set<() => void>();
  return {
    read: () => state,
    write: (next: { hydrated?: boolean }) => {
      state = { ...state, ...next };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      state = { items: [], hydrated: false };
      listeners.clear();
    },
  };
});

// `vi.mock` factories are hoisted above the module's own imports, so the
// store-backed hooks below cannot reference a top-level `react` import; each
// factory imports the one React hook it needs instead.
vi.mock('@/lib/hooks/use-pr-review-footer-preference', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    usePrReviewFooterPreference: () => {
      const state = useSyncExternalStore(footerPreference.subscribe, footerPreference.read);
      return { ...state, setPrReviewFooter: () => undefined };
    },
  };
});

vi.mock('@/lib/pr-review/pending-review-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    PendingReviewProvider: ({ children }: { children?: unknown }) => children ?? null,
    usePendingReview: () => {
      const { items, hydrated } = useSyncExternalStore(pendingQueue.subscribe, pendingQueue.read);
      return {
        items,
        hydrated,
        addComment: () => undefined,
        updateComment: () => undefined,
        removeComment: () => undefined,
        removeComments: () => undefined,
        clear: () => undefined,
      };
    },
  };
});

vi.mock('@/lib/pr-review/use-pr-review-mutations', () => ({
  useSubmitReviewMutation: () => ({
    mutateAsync: async (): Promise<unknown> => undefined,
    isPending: false,
    error: null,
  }),
  buildProviderSubmitInput: (summary: string, items: readonly unknown[]) => ({
    body: summary,
    comments: items,
  }),
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: async () => ({ kind: 'accepted' as const }),
}));
vi.mock('@/components/pr-review/review-event-chips', () => ({
  ReviewEventChips: (): null => {
    record.events.push({ kind: 'frame' });
    return null;
  },
}));
vi.mock('@/components/pr-review/pr-review-pending-comment-row', () => ({
  focusAfterPendingCommentRemoval: vi.fn(),
  PendingQueueHint: (): null => {
    record.events.push({ kind: 'hint' });
    return null;
  },
  PrReviewPendingCommentRow: 'PrReviewPendingCommentRow',
  ReviewSummaryField: (props: { bodyRef: { current: string } }): null => {
    // The real field paints no seeded content: what it shows is the body ref.
    record.events.push({ kind: 'field', value: props.bodyRef.current });
    return null;
  },
}));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: (props: { message: string }): null => {
    record.events.push({ kind: 'block-reason', message: props.message });
    return null;
  },
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { accessibilityLabel?: string }): null => {
    record.events.push({ kind: 'cta', label: props.accessibilityLabel ?? '' });
    return null;
  },
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { testID?: string }): null => {
    if (props.testID === 'pr-review-submit-footer-hint') {
      record.events.push({ kind: 'footer-hint' });
    }
    return null;
  },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/use-feedback-prompt', () => ({
  useFeedbackPromptRequest: () => () => undefined,
}));
vi.mock('@/lib/feedback', () => ({
  maybeAskAfterSuccessfulOutcome: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61' }),
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used' }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  ActivityIndicator: 'NativeActivityIndicator',
  Keyboard: { addListener: () => ({ remove: vi.fn() }) },
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
}));

type Frame = {
  field?: string;
  footerHint?: boolean;
  hint?: boolean;
  blockReason?: string;
  ctas: string[];
};

function frames(): Frame[] {
  const collected: Frame[] = [];
  for (const event of record.events) {
    if (event.kind === 'frame') {
      collected.push({ ctas: [] });
    } else {
      const current = collected.at(-1);
      if (!current) {
        throw new Error(`body element rendered before its frame opened: ${event.kind}`);
      }
      if (event.kind === 'field') {
        current.field = event.value;
      } else if (event.kind === 'footer-hint') {
        current.footerHint = true;
      } else if (event.kind === 'hint') {
        current.hint = true;
      } else if (event.kind === 'block-reason') {
        current.blockReason = event.message;
      } else {
        current.ctas.push(event.label);
      }
    }
  }
  return collected;
}

function mount(): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      <PrReviewSubmit
        owner="acme"
        repo="widgets"
        number={1}
        headSha="head-1"
        title="Submit review"
        eyebrow="acme/widgets#1"
        onDismiss={vi.fn(() => undefined)}
      />
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to mount PrReviewSubmit');
  }
  return renderer;
}

const SETTLED_FRAME: Frame = {
  // The summary starts empty; the attribution footer is appended at submit and
  // the hint line under the field says so.
  field: '',
  footerHint: true,
  // Nothing typed and nothing queued: a comment review paints the block
  // reason, which the footer preference no longer hides.
  blockReason: 'Add a summary or at least one comment to post a comment review.',
  ctas: ['Submit review'],
};

beforeEach(() => {
  record.events = [];
  footerPreference.reset();
  pendingQueue.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PrReviewSubmit first body frame', () => {
  it('keeps the body gated while the stored queue is the only read still pending', () => {
    mount();

    expect(frames()).toHaveLength(0);

    // The footer preference settles on its own: the queue half must still
    // hold the body, or the cards would repaint when the rows arrive.
    act(() => {
      footerPreference.write({ hasLoaded: true });
    });
    expect(frames()).toHaveLength(0);
    expect(record.events).toEqual([]);
  });

  it('keeps the body gated while the footer preference is the only read still pending', () => {
    const renderer = mount();

    expect(frames()).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(
      1
    );

    act(() => {
      pendingQueue.write({ hydrated: true });
    });
    expect(frames()).toHaveLength(0);
    expect(record.events).toEqual([]);
  });

  it('paints one body frame that already carries both settled reads', () => {
    mount();

    act(() => {
      footerPreference.write({ hasLoaded: true });
    });
    act(() => {
      pendingQueue.write({ hydrated: true });
    });

    expect(frames()).toEqual([SETTLED_FRAME]);
  });

  it('never paints a provisional frame on the way to the settled one', () => {
    mount();

    act(() => {
      pendingQueue.write({ hydrated: true });
      footerPreference.write({ hasLoaded: true });
    });

    expect(frames()).toEqual([SETTLED_FRAME]);
    // The block reason belongs to the settled frame only: no earlier body
    // painted it (or the queue hint) before the footer preference landed.
    expect(record.events.filter(event => event.kind === 'block-reason')).toHaveLength(1);
    expect(record.events.some(event => event.kind === 'hint')).toBe(false);
  });
});
