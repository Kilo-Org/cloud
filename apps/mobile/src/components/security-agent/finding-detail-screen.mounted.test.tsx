/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Finding-detail dismiss retry-card contract: the card shows only when the
// stored draft carries a non-null `lastError` (a pre-accept failure no command
// observer will reconcile). A retryable failure offers Retry, a non-retryable
// one hides it, and a cleared/absent draft (accept or empty) shows no card.
// The screen stays mounted while the dismiss sheet is open, so it re-reads the
// draft on focus.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingDetailScreen } from './finding-detail-screen';

type Draft = {
  reason: string;
  comment: string;
  lastError: string | null;
  retryable: boolean | null;
};

const dismissDraft = vi.hoisted(() => ({
  draft: null as Draft | null,
  hydrated: true,
  persist: vi.fn(),
  clear: vi.fn(),
  refresh: vi.fn(),
}));

const finding = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  error: null as unknown,
  data: { status: 'open', repo_full_name: 'org/repo' },
  refetch: vi.fn(),
}));

const analysis = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  data: undefined as unknown,
  refetch: vi.fn(),
}));

const capability = vi.hoisted(() => ({
  canManage: true,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

const trackInteraction = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

// Captures the useFocusEffect callback so a test can simulate a focus event.
const focusEffect = vi.hoisted(() => ({
  effect: undefined as (() => void) | undefined,
}));

// Captures the retry-card props the screen renders.
const retryCards = vi.hoisted(() => ({
  cards: [] as {
    lastError: string;
    retryable: boolean;
    onRetry?: () => void;
    onDiscard?: () => void;
  }[],
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('@/components/ui/icons', () => ({
  Ban: 'Ban',
  ShieldOff: 'ShieldOff',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useNavigation: () => ({ getState: vi.fn(() => ({})) }),
  useFocusEffect: (effect: () => void) => {
    focusEffect.effect = effect;
  },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useTrackSecurityAgentInteraction: () => trackInteraction,
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useSecurityFinding: () => finding,
  useSecurityAnalysis: () => analysis,
}));
vi.mock('@/lib/hooks/use-security-dismiss-draft', () => ({
  useSecurityDismissDraft: () => dismissDraft,
}));
vi.mock('@/components/security-agent/security-command-retry-card', () => ({
  SecurityCommandRetryCard: (props: {
    lastError: string;
    retryable: boolean;
    onRetry?: () => void;
    onDiscard?: () => void;
  }) => {
    retryCards.cards.push(props);
    return null;
  },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/empty-state', () => ({ EmptyState: () => null }));
vi.mock('@/components/query-error', () => ({ QueryError: () => null }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
  useTabBarBottomPadding: () => 0,
}));
vi.mock('@/components/security-agent/finding-analysis-panel', () => ({
  FindingAnalysisPanel: () => null,
}));
vi.mock('@/components/security-agent/finding-details-panel', () => ({
  FindingDetailsPanel: () => null,
}));
vi.mock('@/components/security-agent/finding-remediation-panel', () => ({
  FindingRemediationPanel: () => null,
}));
vi.mock('@/lib/finding-detail-back', () => ({
  findingDetailBackTarget: vi.fn(() => ({ kind: 'pop' })),
  findingDetailHasLocalHistory: vi.fn(() => false),
}));
vi.mock('@/lib/security-agent', () => ({
  getSecurityAgentPath: (scope: string, section: string) => `/security/${scope}/${section}`,
}));
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

type R = TestRenderer.ReactTestRenderer;

function renderScreen(): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(FindingDetailScreen, { scope: 'personal', findingId: 'finding-1' })
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

describe('FindingDetailScreen dismiss retry card states', () => {
  beforeEach(() => {
    dismissDraft.draft = null;
    dismissDraft.hydrated = true;
    dismissDraft.persist.mockClear();
    dismissDraft.clear.mockClear();
    dismissDraft.refresh.mockClear();
    finding.isLoading = false;
    finding.isError = false;
    finding.data = { status: 'open', repo_full_name: 'org/repo' };
    analysis.isLoading = false;
    analysis.isError = false;
    analysis.data = undefined;
    capability.canManage = true;
    capability.isLoading = false;
    capability.isError = false;
    trackInteraction.mutate.mockClear();
    retryCards.cards = [];
    focusEffect.effect = undefined;
  });

  it('renders no retry card when there is no draft (empty)', () => {
    dismissDraft.draft = null;
    renderScreen();

    expect(retryCards.cards).toHaveLength(0);
  });

  it('renders no retry card after accept (no failure recorded)', () => {
    dismissDraft.draft = { reason: 'not_used', comment: '', lastError: null, retryable: null };
    renderScreen();

    expect(retryCards.cards).toHaveLength(0);
  });

  it('renders a retry card with the error and Retry for a retryable failure', () => {
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'Network error',
      retryable: true,
    };
    renderScreen();

    expect(retryCards.cards).toHaveLength(1);
    expect(retryCards.cards[0]?.lastError).toBe('Network error');
    expect(retryCards.cards[0]?.retryable).toBe(true);
  });

  it('renders a retry card with the error and no Retry for a non-retryable failure', () => {
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'Security service is not configured',
      retryable: false,
    };
    renderScreen();

    expect(retryCards.cards).toHaveLength(1);
    expect(retryCards.cards[0]?.lastError).toBe('Security service is not configured');
    expect(retryCards.cards[0]?.retryable).toBe(false);
  });

  it('drops the card on discard by clearing the draft', () => {
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'boom',
      retryable: true,
    };
    renderScreen();
    expect(retryCards.cards).toHaveLength(1);

    act(() => {
      retryCards.cards[0]?.onDiscard?.();
    });

    expect(dismissDraft.clear).toHaveBeenCalledTimes(1);
  });

  it('re-reads the draft on focus', () => {
    renderScreen();

    act(() => {
      focusEffect.effect?.();
    });

    expect(dismissDraft.refresh).toHaveBeenCalledTimes(1);
  });
});
