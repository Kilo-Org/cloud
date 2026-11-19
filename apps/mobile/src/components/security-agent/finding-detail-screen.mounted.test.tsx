/* eslint-disable max-lines -- the load/back-state and dismiss-retry-card suites share one screen harness */

// Finding-detail load/back states and dismiss retry cards. The screen stays
// mounted while the dismiss sheet is open, so it re-reads the draft on focus.

import { createElement } from 'react';
import { type SecurityDismissDraft } from '@/lib/hooks/use-security-dismiss-draft';
import { SecurityCommandRetryCard } from './security-command-retry-card';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OrganizationsModule from '@kilocode/app-shared/organizations';
import type * as ReactI18nextModule from 'react-i18next';

import { CenteredState } from '@/components/centered-state';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { SettingsRecoveryStatus } from './settings-recovery-status';
import { FindingDetailsPanel } from './finding-details-panel';
import { FindingAnalysisPanel } from './finding-analysis-panel';
import { FindingRemediationPanel } from './finding-remediation-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { type SecurityFinding } from '@/lib/security-agent';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { TRIAL_ENDED_BILLING_COPY_KEY, TRIAL_ENDED_COPY_KEY } from '@/lib/trial-refusal-copy';
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

const useSecurityAnalysis = vi.hoisted(() =>
  vi.fn((_scope: string, _findingId: string, _enabled?: boolean) => analysis)
);

const capability = vi.hoisted(() => ({ canManage: true }));

const trackInteraction = vi.hoisted(() => ({ mutate: vi.fn() }));
const navigation = vi.hoisted(() => ({ history: [] as string[] }));

const focusEffect = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  // The header reads the window to decide whether its actions share the title
  // row; this phone is wide enough for them to.
  useWindowDimensions: () => ({ width: 390, fontScale: 1, height: 844 }),
}));
vi.mock('@/components/ui/icons', () => ({
  RotateCcw: 'RotateCcw',
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
vi.mock('react-i18next', async importOriginal => ({
  // The refusal module imports `@/i18n`, whose init registers this plugin.
  ...(await importOriginal<typeof ReactI18nextModule>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('expo-router', () => ({
  useNavigationContainerRef: () => ({ addListener: () => () => undefined }),
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
  useMutedDisabledInk: () => '#666',
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));
// The refusal hooks read the reader's role through the organization query
// chain; this harness has no organization provider and the chain pulls the Expo
// runtime it cannot load, so the boundary is stubbed and the real money-role
// rule decides from the role a case sets.
const trialRole = vi.hoisted(() => ({ role: undefined as string | undefined }));
vi.mock('@/lib/hooks/use-organization-queries', async () => {
  const { canManageOrganizationBilling } = await vi.importActual<typeof OrganizationsModule>(
    '@kilocode/app-shared/organizations'
  );
  return {
    isMoneyRole: canManageOrganizationBilling,
    useOrgBoundary: () => ({ role: trialRole.role }),
  };
});
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useTrackSecurityAgentInteraction: () => trackInteraction,
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useSecurityFinding: () => finding,
  useSecurityAnalysis: (scope: string, findingId: string, enabled?: boolean) =>
    useSecurityAnalysis(scope, findingId, enabled),
}));
const dismissFailureCopy = vi.hoisted(() =>
  vi.fn((draft: { lastError: string | null }) => draft.lastError ?? '')
);

vi.mock('@/lib/hooks/use-security-dismiss-draft', () => ({
  useSecurityDismissDraft: () => dismissDraft,
  securityDismissFailureCopy: dismissFailureCopy,
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
const scopeRoot = '/(app)/security-agent/personal';
const detailPath = `${scopeRoot}/findings/finding-1`;

function renderScreen(findingId = 'finding-1'): R {
  const screen = createElement(FindingDetailScreen, { scope: 'personal', findingId });
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

/**
 * The detail strip's entries. The mocked platform is iOS, where an entry is
 * typed as a button (see lib/a11y/tab-entry); the `tablist` container keeps
 * them apart from the header's own buttons.
 */
function findingTabs(tree: R): TestRenderer.ReactTestInstance[] {
  const strip = tree.root.findAllByProps({ accessibilityRole: 'tablist' })[0];
  if (!strip) {
    throw new Error('finding tabs not mounted');
  }
  return strip.findAllByProps({ role: 'button' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  trialRole.role = undefined;
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

describe('FindingDetailScreen tab touch target', () => {
  // Regression: each tab was a `min-h-11` node, 38.5 dp in this app's rem, so
  // the strip's upper and lower bands were not part of the tab. The floor has
  // to be the tab node's own class; `hitSlop` would not move the rect a
  // control-size audit measures.
  it('carries the shared row floor on every tab node', () => {
    const tree = renderScreen();
    const tabs = findingTabs(tree);

    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(String(tab.props.className).split(' ')).toContain(ROW_TARGET_CLASS);
      expect(tab.props.hitSlop).toBeUndefined();
    }
  });
});

describe('FindingDetailScreen pane containers', () => {
  it.each([
    ['analysis', FindingAnalysisPanel],
    ['remediation', FindingRemediationPanel],
  ] as const)('keeps finding Retry outside the selected %s pane scroller', (tab, Panel) => {
    finding.isError = true;
    finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const tree = renderScreen();
    const tabs = findingTabs(tree);
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
    expect(retry.props.message).toBe('securityAgent.dismiss.couldNotLoad');
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

describe('FindingDetailScreen analysis query activation', () => {
  // The analysis query polls while a run is active, so it stays disabled until
  // an analysis surface (analysis or remediation) is the selected tab: the
  // details tab reads the finding, never its analysis.
  function enabledArg(): unknown {
    return useSecurityAnalysis.mock.lastCall?.[2];
  }

  function pressTab(tree: R, index: number) {
    act(findingTabs(tree)[index]?.props.onPress as () => void);
  }

  it('reads the analysis only while an analysis surface is selected', () => {
    const tree = renderScreen();
    expect(enabledArg()).toBeFalsy();

    pressTab(tree, 1);
    expect(enabledArg()).toBe(true);

    pressTab(tree, 2);
    expect(enabledArg()).toBe(true);

    pressTab(tree, 0);
    expect(enabledArg()).toBeFalsy();
  });

  it('keeps the analysis query off while the finding is unavailable', () => {
    finding.isError = true;
    finding.error = { data: { code: 'NOT_FOUND' } };
    finding.data = undefined;
    const tree = renderScreen();

    expect(tree.root.findAllByType(CenteredState)).toHaveLength(1);
    expect(useSecurityAnalysis).toHaveBeenCalled();
    expect(enabledArg()).toBeFalsy();
  });
});

describe('FindingDetailScreen dismiss retry card states', () => {
  it.each([
    null,
    { reason: 'not_used', comment: '', lastError: null, lastErrorKey: null, retryable: null },
  ])('renders no retry card without a recorded failure: %j', draft => {
    dismissDraft.draft = draft;
    expect(renderScreen().root.findAllByType(SecurityCommandRetryCard)).toHaveLength(0);
  });

  it.each([
    ['Network error', true],
    ['Security service is not configured', false],
  ] as const)('renders the %s failure with retryable=%s', (lastError, retryable) => {
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError,
      lastErrorKey: null,
      retryable,
    };
    const card = renderScreen().root.findByType(SecurityCommandRetryCard);
    expect(card.props).toMatchObject({ lastError, retryable });
  });

  it('gives a billing role the plan step under a stored trial refusal', () => {
    trialRole.role = 'owner';
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'The organization trial has ended.',
      lastErrorKey: TRIAL_ENDED_BILLING_COPY_KEY,
      retryable: false,
    };
    const card = renderScreen().root.findByType(SecurityCommandRetryCard);

    expect(card.props.action).toMatchObject({ label: 'organization.hub.manageBilling' });
    // The step ends the refusal; the Retry/Discard rules still come from the
    // stored failure, and a terminal one keeps the card without a retry.
    expect(card.props.retryable).toBe(false);
  });

  it('keeps a stored trial refusal on the member copy with no step', () => {
    trialRole.role = 'member';
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'The organization trial has ended.',
      lastErrorKey: TRIAL_ENDED_COPY_KEY,
      retryable: false,
    };
    const card = renderScreen().root.findByType(SecurityCommandRetryCard);

    expect(card.props.action).toBeUndefined();
  });

  // The stored key names which refusal the draft recorded, not which reader saw
  // it: a draft written while the role read was unresolved gains the sentence
  // and the step together when a billing role opens it, and a draft written by
  // a billing role keeps the ask-an-owner copy, without a step, for a member.
  it('gives a billing role the step under a refusal stored with the ask-an-owner key', () => {
    trialRole.role = 'owner';
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'The organization trial has ended.',
      lastErrorKey: TRIAL_ENDED_COPY_KEY,
      retryable: false,
    };
    const card = renderScreen().root.findByType(SecurityCommandRetryCard);

    expect(card.props.action).toMatchObject({ label: 'organization.hub.manageBilling' });
    // The sentence is re-translated from the same role answer that built the
    // step, never from the reader the draft was written for.
    expect(dismissFailureCopy).toHaveBeenCalledWith(
      expect.objectContaining({ lastErrorKey: TRIAL_ENDED_COPY_KEY }),
      true
    );
  });

  it('keeps a member on the ask-an-owner copy with no step for a billing-keyed draft', () => {
    trialRole.role = 'member';
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'The organization trial has ended.',
      lastErrorKey: TRIAL_ENDED_BILLING_COPY_KEY,
      retryable: false,
    };
    const card = renderScreen().root.findByType(SecurityCommandRetryCard);

    expect(card.props.action).toBeUndefined();
    expect(dismissFailureCopy).toHaveBeenCalledWith(
      expect.objectContaining({ lastErrorKey: TRIAL_ENDED_BILLING_COPY_KEY }),
      false
    );
  });

  it('adds no step to a stored failure that is not the trial refusal', () => {
    trialRole.role = 'owner';
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'boom',
      lastErrorKey: 'securityAgent.mutations.actionBlocked',
      retryable: true,
    };
    const card = renderScreen().root.findByType(SecurityCommandRetryCard);

    expect(card.props.action).toBeUndefined();
    expect(card.props.retryable).toBe(true);
  });

  it('drops the card on discard by clearing the draft', () => {
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: 'boom',
      lastErrorKey: null,
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
      hasLocalHistory ? [scopeRoot] : ['/(app)/security-agent/personal/findings']
    );
  }

  it('keeps Back available during loading without offering Retry', () => {
    finding.isLoading = true;
    finding.isFetching = true;
    finding.data = undefined;
    const tree = renderScreen();

    // Four body skeletons plus the bar on the header's reserved eyebrow line.
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(5);
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
    // The header keeps the eyebrow line it reserved while loading, and no bar
    // paints over it once the read has failed: this state leaves no skeleton.
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0);
    expectSafeBack(tree);
  });

  it('holds the failed load with retry progress while the retry runs', () => {
    finding.isError = true;
    finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    finding.data = undefined;
    const tree = renderScreen();
    expect(tree.root.findByType(QueryError).props.isRetrying).toBe(false);

    // React Query resets a failed query to pending when its retry starts, so
    // the surface has to survive isError turning false for the retry window.
    finding.isError = false;
    finding.error = null;
    finding.isFetching = true;
    renderScreen();

    expect(tree.root.findAllByType(QueryError)).toHaveLength(1);
    expect(tree.root.findByType(QueryError).props.isRetrying).toBe(true);
    // The body stays on the error surface; only the header's reserved eyebrow
    // bar remains, so the retry window paints no body skeleton.
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(1);

    finding.isFetching = false;
    finding.data = { status: 'open', repo_full_name: 'org/recovered' };
    renderScreen();

    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    expect(tree.root.findAllByProps({ children: 'org/recovered' })).toHaveLength(1);
  });

  it('does not carry a failed load onto another finding', () => {
    finding.isError = true;
    finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    finding.data = undefined;
    const tree = renderScreen();
    expect(tree.root.findAllByType(QueryError)).toHaveLength(1);

    finding.isError = false;
    finding.error = null;
    finding.isFetching = true;
    renderScreen('finding-2');

    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    // Four body skeletons plus the bar on the header's reserved eyebrow line.
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(5);
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
      tree.root.findAllByProps({ children: 'securityAgent.dismiss.couldNotLoad' })
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
      tree.root.findAllByProps({ children: 'securityAgent.dismiss.notFoundTitle' })
    ).toHaveLength(1);
    expect(
      tree.root.findAllByProps({ children: 'securityAgent.dismiss.notFoundDescription' })
    ).toHaveLength(1);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'common.retry' })).toHaveLength(0);
    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    // The first frame of every open is the loading one, so the not-found answer
    // keeps the line it reserved then instead of pulling the title up — held
    // blank, because no read is running to fill it.
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0);
    expectSafeBack(tree);
  });
});
