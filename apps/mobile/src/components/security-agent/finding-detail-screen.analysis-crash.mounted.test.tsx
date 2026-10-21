// A render throw from the Analysis pane body stays inside the finding detail,
// and one Retry recovers it once the analysis refetch settles.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryError } from '@/components/query-error';
import { type SecurityFinding } from '@/lib/security-agent';
import { FindingAnalysisPanel } from './finding-analysis-panel';
import { FindingDetailScreen } from './finding-detail-screen';

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

// Stands in for a panel body that throws on an unexpected analysis payload.
const analysisPanel = vi.hoisted(() => ({ crashOnRender: false }));

const dismissDraft = vi.hoisted(() => ({
  draft: null,
  clear: vi.fn(),
  refresh: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ history: [] as string[] }));
const focusEffect = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, fontScale: 1, height: 844 }),
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
    canGoBack: () => true,
  }),
  useNavigation: () => ({ getState: () => ({ index: navigation.history.length - 1 }) }),
  useFocusEffect: focusEffect,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({ canManage: true }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
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
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/security-agent/finding-analysis-panel', () => ({
  FindingAnalysisPanel: () => {
    if (analysisPanel.crashOnRender) {
      throw new Error('analysis panel render failed');
    }
    return null;
  },
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
const detailPath = '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-1';

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
  analysis.refetch.mockReset();
  analysisPanel.crashOnRender = false;
  navigation.history = [detailPath];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('FindingDetailScreen analysis pane render crash', () => {
  it('keeps the finding open and recovers the pane on one Retry', async () => {
    const refetch = Promise.withResolvers<undefined>();
    analysis.refetch.mockImplementation(async () => {
      await refetch.promise;
    });
    analysisPanel.crashOnRender = true;
    const tree = renderScreen();
    const tabs = tree.root.findAllByProps({ accessibilityRole: 'tab' });
    act(tabs[1]?.props.onPress as () => void);

    const fallback = tree.root.findByType(QueryError);
    expect(fallback.props.message).toBe('securityAgent.analysis.couldNotLoad');
    expect(tree.root.findAllByType(FindingAnalysisPanel)).toHaveLength(0);

    act(fallback.props.onRetry as () => void);
    expect(analysis.refetch).toHaveBeenCalledOnce();

    // The refetch settles with a healthy payload. A boundary remounted before
    // that point meets the crashing payload again and pins the fallback.
    analysisPanel.crashOnRender = false;
    analysis.data = { status: 'completed' };
    await act(async () => {
      refetch.resolve(undefined);
      await refetch.promise;
    });
    renderScreen();

    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    expect(tree.root.findAllByType(FindingAnalysisPanel)).toHaveLength(1);
  });
});
