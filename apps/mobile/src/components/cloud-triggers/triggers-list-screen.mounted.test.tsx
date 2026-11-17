/**
 * The triggers list row: what it offers, and only when it can be used.
 *
 * A scheduled trigger has no inbound URL, so the row shows no URL and no copy
 * control for one. The active switch is a write, and the list's rows say whether
 * this viewer may write each of them, so a row the server would refuse keeps its
 * saved state without offering the tap.
 */

import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { TriggersListScreen } from './triggers-list-screen';

const rows = [
  {
    id: 'row-a',
    triggerId: 'trigger-a',
    targetType: 'cloud_agent' as const,
    githubRepo: 'owner/repo',
    kiloclawInstanceId: null,
    isActive: true,
    activationMode: 'webhook' as const,
    cronExpression: null,
    cronTimezone: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    inboundUrl: 'https://Inbound.example/trigger-a',
    canEdit: true,
    canEditReason: null,
  },
  {
    id: 'row-b',
    triggerId: 'trigger-b',
    targetType: 'cloud_agent' as const,
    githubRepo: null,
    kiloclawInstanceId: null,
    isActive: false,
    activationMode: 'scheduled' as const,
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    inboundUrl: 'https://Inbound.example/trigger-b',
    canEdit: false,
    canEditReason: 'creator_run' as const,
  },
];

const copyWebhookUrl = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: vi.fn() }));
const listState = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  isFetching: false,
  data: [] as typeof rows,
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => new Proxy({}, { get: () => '#000000' }),
}));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    organizationId: null,
    role: null,
    org: null,
    isResolving: false,
  }),
}));
vi.mock('@/lib/cloud-triggers/copy-webhook-url', () => ({ copyWebhookUrl }));
vi.mock('@/lib/cloud-triggers/use-cloud-triggers', () => ({
  useCloudTriggers: () =>
    listState.isPending || listState.isError
      ? { ...listState, data: undefined, refetch: vi.fn() }
      : { ...listState, data: rows, refetch: vi.fn() },
  useTriggerMutations: () => ({
    setActive: { isPending: false, variables: { triggerId: 'trigger-a' }, mutate: vi.fn() },
  }),
}));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/icons', () => ({
  Copy: 'Copy',
  Plus: 'Plus',
  Workflow: 'Workflow',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const BUTTON = 'Button' as ElementType;
const QUERY_ERROR = 'QueryError' as ElementType;
const SCREEN_HEADER = 'ScreenHeader' as ElementType;
const SWITCH = 'Switch' as ElementType;
const ICON_BUTTON = 'IconButton' as ElementType;
const TEXT = 'Text' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(createElement(TriggersListScreen, {}));
  renderer = view.renderer;
  return view.renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  copyWebhookUrl.mockClear();
  router.push.mockClear();
  listState.isPending = false;
  listState.isError = false;
  listState.isFetching = false;
  listState.data = [];
});

describe('TriggersListScreen rows', () => {
  it('shows the inbound URL and its copy control for a webhook trigger only', async () => {
    const root = await mount();
    const texts = root.findAll(node => Object.is(node.type, TEXT));
    const shown = texts.map(node => node.props.children);

    expect(shown).toContain('https://Inbound.example/trigger-a');
    expect(shown).not.toContain('https://Inbound.example/trigger-b');

    const copyButtons = root.findAll(node => Object.is(node.type, ICON_BUTTON));
    expect(copyButtons).toHaveLength(1);
    const [copyButton] = copyButtons;
    if (!copyButton) {
      throw new Error('missing copy control');
    }
    act(() => {
      (copyButton.props.onPress as () => void)();
    });
    expect(copyWebhookUrl).toHaveBeenCalledWith('https://Inbound.example/trigger-a');
  });

  it('disables the active switch on a row the viewer cannot write', async () => {
    const root = await mount();
    const switches = root.findAll(node => Object.is(node.type, SWITCH));
    expect(switches.map(node => node.props.disabled)).toEqual([false, true]);
    expect(switches.map(node => node.props.value)).toEqual([true, false]);
  });
});

describe('TriggersListScreen error state', () => {
  it('renders the Retry error and no New footer while the header New stays reachable', async () => {
    listState.isError = true;
    listState.data = [];
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, QUERY_ERROR))).toHaveLength(1);
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);

    // The mocked header is a host node, so its New action is reached through
    // the `headerRight` prop rather than a mounted child.
    const [header] = root.findAll(node => Object.is(node.type, SCREEN_HEADER));
    if (!header) {
      throw new Error('missing screen header');
    }
    const newControl = header.props.headerRight as {
      type: ElementType;
      props: { accessibilityLabel: string; onPress: () => void };
    };
    expect(newControl.type).toBe('IconButton');
    expect(newControl.props.accessibilityLabel).toBe('New trigger');
    act(() => {
      newControl.props.onPress();
    });
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});
