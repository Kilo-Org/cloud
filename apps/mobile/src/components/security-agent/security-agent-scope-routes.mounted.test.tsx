// Every route under `[scope]/` validates its own segment. The layout validates
// too, but it keeps the segment it mounted with when a warm link replaces it —
// observed on the emulator: a link to `/security-agent/undefined` delivered to a
// running app reached the scope entry and issued the organization procedures
// with a non-uuid owner. These cases mount the route modules directly, so the
// route's own guard is what they prove.
import { type ComponentType, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SecurityAgentScopeRoute from '@/app/(app)/security-agent/[scope]/index';
import SecurityAgentAuditReportRoute from '@/app/(app)/security-agent/[scope]/audit-report';
import SecurityAgentDismissFindingRoute from '@/app/(app)/security-agent/[scope]/dismiss/[id]';
import SecurityAgentFindingDetailRoute from '@/app/(app)/security-agent/[scope]/findings/[id]';
import SecurityAgentFindingListRoute from '@/app/(app)/security-agent/[scope]/findings/index';
import SecurityAgentAnalysisSettingsRoute from '@/app/(app)/security-agent/[scope]/settings/analysis';
import SecurityAgentAutomationSettingsRoute from '@/app/(app)/security-agent/[scope]/settings/automation';
import SecurityAgentSettingsRoute from '@/app/(app)/security-agent/[scope]/settings/index';
import SecurityAgentNotificationSettingsRoute from '@/app/(app)/security-agent/[scope]/settings/notifications';
import SecurityAgentRepositorySettingsRoute from '@/app/(app)/security-agent/[scope]/settings/repositories';
import SecurityAgentSlaSettingsRoute from '@/app/(app)/security-agent/[scope]/settings/sla';

const params = vi.hoisted(() => ({ current: Object.create(null) as Record<string, string> }));
const mounted = vi.hoisted(() => ({ screens: [] as string[] }));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.current,
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), dismissTo: vi.fn() }),
}));

function screenMock(name: string) {
  return (props: { scope: string }) => {
    mounted.screens.push(`${name}:${props.scope}`);
    return null;
  };
}

vi.mock('@/components/security-agent/scope-entry-screen', () => ({
  ScopeEntryScreen: screenMock('entry'),
}));
vi.mock('@/components/security-agent/audit-report-screen', () => ({
  AuditReportScreen: screenMock('audit-report'),
}));
vi.mock('@/components/security-agent/dismiss-finding-screen', () => ({
  DismissFindingScreen: screenMock('dismiss'),
}));
vi.mock('@/components/security-agent/finding-detail-screen', () => ({
  FindingDetailScreen: screenMock('finding-detail'),
}));
vi.mock('@/components/security-agent/finding-list-screen', () => ({
  FindingListScreen: screenMock('finding-list'),
}));
vi.mock('@/components/security-agent/analysis-settings-screen', () => ({
  AnalysisSettingsScreen: screenMock('analysis'),
}));
vi.mock('@/components/security-agent/automation-settings-screen', () => ({
  AutomationSettingsScreen: screenMock('automation'),
}));
vi.mock('@/components/security-agent/settings-overview-screen', () => ({
  SettingsOverviewScreen: screenMock('settings'),
}));
vi.mock('@/components/security-agent/notification-settings-screen', () => ({
  NotificationSettingsScreen: screenMock('notifications'),
}));
vi.mock('@/components/security-agent/repository-settings-screen', () => ({
  RepositorySettingsScreen: screenMock('repositories'),
}));
vi.mock('@/components/security-agent/sla-settings-screen', () => ({
  SlaSettingsScreen: screenMock('sla'),
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/picker-sheet', () => ({ PickerSheet: () => null }));
vi.mock('@/components/security-agent/finding-filter-modal', () => ({
  FindingFilterModal: () => null,
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentConfig: () => ({ data: undefined }),
  useSecurityAgentRepositories: () => ({ data: undefined }),
}));

type RouteModule = ComponentType;

const ROUTES: [string, RouteModule][] = [
  ['index', SecurityAgentScopeRoute],
  ['audit-report', SecurityAgentAuditReportRoute],
  ['dismiss/[id]', SecurityAgentDismissFindingRoute],
  ['findings/[id]', SecurityAgentFindingDetailRoute],
  ['findings/index', SecurityAgentFindingListRoute],
  ['settings/analysis', SecurityAgentAnalysisSettingsRoute],
  ['settings/automation', SecurityAgentAutomationSettingsRoute],
  ['settings/index', SecurityAgentSettingsRoute],
  ['settings/notifications', SecurityAgentNotificationSettingsRoute],
  ['settings/repositories', SecurityAgentRepositorySettingsRoute],
  ['settings/sla', SecurityAgentSlaSettingsRoute],
];

const ORG_SCOPE = 'c0a8012e-9a3b-4f5c-8d1e-2b3c4d5e6f70';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(Route: RouteModule): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Route));
  });
  const created = ref.current;
  if (!created) {
    throw new Error('renderer was not created');
  }
  renderer = created;
  return created;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  params.current = {};
  mounted.screens = [];
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe.each(ROUTES)('%s route scope guard', (_name, Route) => {
  it.each([{ scope: 'undefined' }, { scope: 'not-a-scope' }, { scope: '' }])(
    'renders the invalid state for scope $scope instead of the screen',
    ({ scope }) => {
      params.current = { scope, id: 'finding-1' };
      const tree = mount(Route);

      // No screen mounted, so no query ran with an owner that cannot exist.
      expect(mounted.screens).toEqual([]);
      expect(tree.root.findAllByType('InvalidRouteState')).toHaveLength(1);
    }
  );

  it('renders the screen for a real scope', () => {
    params.current = { scope: ORG_SCOPE, id: 'finding-1' };
    mount(Route);

    expect(mounted.screens).toHaveLength(1);
    expect(mounted.screens[0]?.endsWith(`:${ORG_SCOPE}`)).toBe(true);
  });
});

describe('personal scope', () => {
  it('reaches the entry screen', () => {
    params.current = { scope: 'personal' };
    mount(SecurityAgentScopeRoute);
    expect(mounted.screens).toEqual(['entry:personal']);
  });
});
