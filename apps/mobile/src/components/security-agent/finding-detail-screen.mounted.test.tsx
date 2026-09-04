/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Finding-detail load/back states and dismiss retry cards. The screen stays
// mounted while the dismiss sheet is open, so it re-reads the draft on focus.

import { createElement } from 'react';
import { type SecurityDismissDraft } from '@/lib/hooks/use-security-dismiss-draft';
import { SecurityCommandRetryCard } from './security-command-retry-card';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CenteredState } from '@/components/centered-state';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { SettingsRecoveryStatus } from './settings-recovery-status';
import { FindingDetailsPanel } from './finding-details-panel';
import { FindingAnalysisPanel } from './finding-analysis-panel';
import { FindingRemediationPanel } from './finding-remediation-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { type SecurityFinding } from '@/lib/security-agent';
import { FindingDetailScreen } from './finding-detail-screen';

const dismissDraft = vi.hoisted(() => ({
  draft: null as SecurityDismissDraft | null,
  clear: vi.fn(),
  refresh: vi.fn(),
}));

const finding = vi.hoisted(() => ({
  isLoading: false,
  isFetching: false,
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

const capability = vi.hoisted(() => ({ canManage: true }));

const trackInteraction = vi.hoisted(() => ({ mutate: vi.fn() }));
const navigation = vi.hoisted(() => ({ history: [] as string[] }));

const focusEffect = vi.hoisted(() => vi.fn());

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
  useFocusEffect: focusEffect,
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
vi.mock('./security-command-retry-card', () => ({ SecurityCommandRetryCard: 'RetryCard' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Pressable' }));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: vi.fn() }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'TabScreenScrollView',
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
  const screen = createElement(FindingDetailScreen, { scope: 'personal', findingId: 'finding-1' });
  act(() => {
    if (renderer) {
      renderer.update(screen);
    } else {
      renderer = TestRenderer.create(screen);
    }
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function press(tree: R, accessibilityLabel: string) {
  act(tree.root.findByProps({ accessibilityLabel }).props.onPress as () => void);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dismissDraft.draft = null;
  finding.isLoading = false;
  finding.isFetching = false;
  finding.isError = false;
  finding.error = null;
  finding.data = { status: 'open', repo_full_name: 'org/repo' };
  finding.refetch.mockReset();
  analysis.isLoading = false;
  analysis.isError = false;
  analysis.data = undefined;
  capability.canManage = true;
  navigation.history = [detailPath];
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('FindingDetailScreen pane containers', () => {
  it.each([
    ['analysis', FindingAnalysisPanel],
    ['remediation', FindingRemediationPanel],
  ] as const)('keeps finding Retry outside the selected %s pane scroller', (tab, Panel) => {
    finding.isError = true;
    finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const tree = renderScreen();
    const tabs = tree.root.findAllByProps({ accessibilityRole: 'tab' });
    const onPress = tabs[tab === 'analysis' ? 1 : 2]?.props.onPress as () => void;
    act(onPress);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(0);
    expect(tree.root.findAllByType(Panel)).toHaveLength(1);
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(0);
    press(tree, 'common.retry');
    expect(finding.refetch).toHaveBeenCalledOnce();
    expect(analysis.refetch).not.toHaveBeenCalled();
  });

  it('keeps cached details mounted through a failed refetch and Retry', () => {
    const tree = renderScreen();
    const details = tree.root.findByType(FindingDetailsPanel);
    finding.isError = true;
    finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    renderScreen();
    expect(tree.root.findByType(FindingDetailsPanel)).toBe(details);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(1);
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(0);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    const retry = tree.root.findByType(SettingsRecoveryStatus);
    expect(retry.props.message).toBe('securityAgent.findingDetail.couldNotLoad');
    press(tree, 'common.retry');
    expect(finding.refetch).toHaveBeenCalledOnce();
    expect(analysis.refetch).not.toHaveBeenCalled();
    finding.isFetching = true;
    renderScreen();
    expect(retry.props.isRetrying).toBe(true);
    expect(tree.root.findByType(FindingDetailsPanel)).toBe(details);
    finding.isFetching = false;
    finding.isError = false;
    finding.error = null;
    renderScreen();
    expect(tree.root.findByType(FindingDetailsPanel)).toBe(details);
    expect(tree.root.findAllByType(SettingsRecoveryStatus)).toHaveLength(0);
  });

  it.each(['NOT_FOUND', 'FORBIDDEN'])('does not retain cached details after %s', code => {
    finding.isError = true;
    finding.error = { data: { code } };
    const tree = renderScreen();
    expect(tree.root.findAllByType(FindingDetailsPanel)).toHaveLength(0);
    expect(tree.root.findAllByType(TabScreenScrollView)).toHaveLength(0);
    expect(tree.root.findAllByType(CenteredState)).toHaveLength(1);
    expect(tree.root.findAllByType(SettingsRecoveryStatus)).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'common.retry' })).toHaveLength(0);
  });
});

describe('FindingDetailScreen dismiss retry card states', () => {
  it.each([null, { reason: 'not_used', comment: '', lastError: null, retryable: null }])(
    'renders no retry card without a recorded failure: %j',
    draft => {
      dismissDraft.draft = draft;
      expect(renderScreen().root.findAllByType(SecurityCommandRetryCard)).toHaveLength(0);
    }
  );

  it.each([
    ['Network error', true],
    ['Security service is not configured', false],
  ] as const)('renders the %s failure with retryable=%s', (lastError, retryable) => {
    dismissDraft.draft = { reason: 'not_used', comment: '', lastError, retryable };
    const card = renderScreen().root.findByType(SecurityCommandRetryCard);
    expect(card.props).toMatchObject({ lastError, retryable });
  });

  it('drops the card on discard by clearing the draft', () => {
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'boom',
      retryable: true,
    };
    const card = renderScreen().root.findByType(SecurityCommandRetryCard);
    act(card.props.onDiscard as () => void);

    expect(dismissDraft.clear).toHaveBeenCalledTimes(1);
  });

  it('re-reads the draft on focus', () => {
    renderScreen();

    act(focusEffect.mock.lastCall?.[0] as () => void);

    expect(dismissDraft.refresh).toHaveBeenCalledTimes(1);
  });
});

describe.each([true, false])('finding load states with local history=%s', hasLocalHistory => {
  beforeEach(() => {
    navigation.history = hasLocalHistory ? [scopeRoot, detailPath] : [detailPath];
  });

  function expectSafeBack(tree: R) {
    press(tree, 'common.goBack');
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
    renderScreen();

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
