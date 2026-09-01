/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Finding-detail load/back states and dismiss retry cards. The screen stays
// mounted while the dismiss sheet is open, so it re-reads the draft on focus.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { type SecurityFinding } from '@/lib/security-agent';
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
  data: undefined as Pick<SecurityFinding, 'status' | 'repo_full_name'> | undefined,
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

const trackInteraction = vi.hoisted(() => ({ mutate: vi.fn() }));
const navigation = vi.hoisted(() => ({ history: [] as string[] }));

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
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
}));
vi.mock('@/components/ui/icons', () => ({
  Ban: 'Ban',
  ShieldOff: 'ShieldOff',
  ChevronDown: 'ChevronDown',
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronLeft: 'ChevronLeft' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: (href: string) => navigation.history.push(href),
    back: () => navigation.history.pop(),
    replace: (href: string) => navigation.history.splice(-1, 1, href),
    // Parent history must not override the detail Stack's own history signal.
    canGoBack: () => true,
  }),
  useNavigation: () => ({ getState: () => ({ index: navigation.history.length - 1 }) }),
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
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Pressable' }));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: vi.fn() }));
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
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

type R = TestRenderer.ReactTestRenderer;
let renderer: R | undefined = undefined;
const scopeRoot = '/(app)/(tabs)/(3_profile)/security-agent/personal';
const detailPath = `${scopeRoot}/findings/finding-1`;

function renderScreen(): R {
  act(() => {
    renderer = TestRenderer.create(
      createElement(FindingDetailScreen, { scope: 'personal', findingId: 'finding-1' })
    );
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function press(tree: R, accessibilityLabel: string) {
  const { onPress } = tree.root.findByProps({ accessibilityLabel }).props as {
    onPress: () => void;
  };
  act(onPress);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dismissDraft.draft = null;
  dismissDraft.hydrated = true;
  finding.isLoading = false;
  finding.isError = false;
  finding.error = null;
  finding.data = { status: 'open', repo_full_name: 'org/repo' };
  finding.refetch.mockReset();
  analysis.isLoading = false;
  analysis.isError = false;
  analysis.data = undefined;
  capability.canManage = true;
  capability.isLoading = false;
  capability.isError = false;
  retryCards.cards = [];
  focusEffect.effect = undefined;
  navigation.history = [detailPath];
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('FindingDetailScreen dismiss retry card states', () => {
  it('renders no retry card when there is no draft (empty)', () => {
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

describe.each([true, false])('finding load states with local history=%s', hasLocalHistory => {
  beforeEach(() => {
    navigation.history = hasLocalHistory ? [scopeRoot, detailPath] : [detailPath];
  });

  function expectSafeBack(tree: R) {
    press(tree, 'screenHeader.goBack');
    expect(navigation.history).toEqual(
      hasLocalHistory ? [scopeRoot] : ['/(app)/(tabs)/(3_profile)']
    );
  }

  it('keeps Back available during loading without offering Retry', () => {
    finding.isLoading = true;
    finding.data = undefined;
    const tree = renderScreen();

    expect(tree.root.findAllByType(Skeleton)).toHaveLength(4);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'common.retry' })).toHaveLength(0);
    expectSafeBack(tree);
  });

  it('keeps Back safe while a transient load failure remains visible', () => {
    finding.isError = true;
    finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    finding.data = undefined;
    const tree = renderScreen();

    expect(tree.root.findAllByType(QueryError)).toHaveLength(1);
    expectSafeBack(tree);
  });

  it('recovers the finding through Retry after a transient load failure', () => {
    finding.isError = true;
    finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    finding.data = undefined;
    finding.refetch.mockImplementationOnce(() => {
      finding.isError = false;
      finding.error = null;
      finding.data = { status: 'open', repo_full_name: 'org/recovered' };
    });
    const tree = renderScreen();
    expect(
      tree.root.findAllByProps({ children: 'securityAgent.findingDetail.couldNotLoad' })
    ).toHaveLength(1);

    press(tree, 'common.retry');
    act(() => {
      tree.update(
        createElement(FindingDetailScreen, { scope: 'personal', findingId: 'finding-1' })
      );
    });

    expect(tree.root.findAllByProps({ children: 'org/recovered' })).toHaveLength(1);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'common.retry' })).toHaveLength(0);
    expectSafeBack(tree);
  });

  it.each(['NOT_FOUND', 'FORBIDDEN'])('shows unavailable guidance and safe Back for %s', code => {
    finding.isError = true;
    finding.error = { data: { code } };
    finding.data = undefined;
    const tree = renderScreen();

    expect(
      tree.root.findAllByProps({ children: 'securityAgent.findingDetail.notFound' })
    ).toHaveLength(1);
    expect(
      tree.root.findAllByProps({ children: 'securityAgent.findingDetail.notFoundDescription' })
    ).toHaveLength(1);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'common.retry' })).toHaveLength(0);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    expectSafeBack(tree);
  });
});
