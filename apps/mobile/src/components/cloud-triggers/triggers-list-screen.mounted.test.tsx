/**
 * The triggers list row: what it offers, and only when it can be used.
 *
 * A scheduled trigger has no inbound URL, so the row shows no URL and no copy
 * control for one. The active switch is a write, and the list's rows say whether
 * this viewer may write each of them, so a row the server would refuse keeps its
 * saved state without offering the tap.
 *
 * The row is two controls, not one: the switch owns its own touch and its own
 * accessible node, and the press beside it opens the trigger's detail screen.
 */

import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { COMPACT_CONTROL_BOX_CLASS, textActionTargetClass } from '@/lib/a11y/tap-target';
import { triggerDetailHref } from '@/lib/cloud-triggers/trigger-routes';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

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
const setActive = vi.hoisted(() => ({
  isPending: false,
  variables: { triggerId: 'trigger-a' },
  mutate: vi.fn(),
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  // `textActionTargetClass` reads the platform to pick the shared frame.
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
// RowFrame's trailing renderer calls the selection haptic; the real module loads
// expo-haptics' runtime, which reads `__DEV__`.
vi.mock('@/lib/haptics', () => ({ selectionHaptic: vi.fn() }));
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
  useCloudTriggers: () => ({
    isPending: false,
    isError: false,
    isFetching: false,
    data: rows,
    refetch: vi.fn(),
  }),
  useTriggerMutations: () => ({
    setActive,
  }),
}));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  Copy: 'Copy',
  Plus: 'Plus',
  Workflow: 'Workflow',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/section', () => ({ Section: 'Section' }));
vi.mock('@/components/ui/row-group', () => ({ RowGroup: 'RowGroup' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/icon-tile', () => ({ IconTile: 'IconTile' }));
vi.mock('@/components/ui/row-chevron', () => ({ RowChevron: 'RowChevron' }));
vi.mock('@/lib/font-scale/system-font-scale-context', async importOriginal => ({
  ...(await importOriginal<object>()),
  useLiveFontScale: () => 1,
}));
vi.mock('@/lib/narrow-layout', () => ({ isNarrowLayout: () => false }));

const SWITCH = 'Switch' as ElementType;
const PRESSABLE = 'Pressable' as ElementType;
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
  setActive.mutate.mockClear();
});

describe('TriggersListScreen rows', () => {
  it('shows the inbound URL and its copy control for a webhook trigger only', async () => {
    const root = await mount();
    const texts = root.findAll(node => Object.is(node.type, TEXT));
    const shown = texts.map(node => node.props.children);

    expect(shown).toContain('https://Inbound.example/trigger-a');
    expect(shown).not.toContain('https://Inbound.example/trigger-b');

    const copyButtons = root.findAll(
      node =>
        Object.is(node.type, PRESSABLE) &&
        node.props.accessibilityLabel === i18n.t('common.copyLink') &&
        typeof node.props.onPress === 'function'
    );
    expect(copyButtons).toHaveLength(1);
    const [copyButton] = copyButtons;
    if (!copyButton) {
      throw new Error('missing copy control');
    }
    // The control is the shared compact box, and it declares its reach as slop.
    // React Native clips that reach at the parent view, so the control's parent
    // must carry the platform target on both axes; the row's own content height
    // is the box alone.
    expect(String(copyButton.props.className).split(' ')).toEqual(
      expect.arrayContaining(COMPACT_CONTROL_BOX_CLASS.split(' '))
    );
    const host = copyButton.parent;
    if (!host) {
      throw new Error('copy control has no host');
    }
    expect(String(host.props.className).split(' ')).toEqual(
      expect.arrayContaining([...textActionTargetClass().split(' '), 'shrink-0'])
    );
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

  it('keeps the switch outside the row press, as its sibling', async () => {
    const root = await mount();
    // The row presses carry their trigger id; the copy control below a webhook
    // row is a pressable of its own and is not one of them.
    const presses = root.findAll(
      node =>
        Object.is(node.type, PRESSABLE) &&
        /^trigger-[ab]$/.test(String(node.props.accessibilityLabel ?? ''))
    );
    const switches = root.findAll(node => Object.is(node.type, SWITCH));

    expect(presses).toHaveLength(2);
    expect(switches).toHaveLength(2);
    for (const press of presses) {
      expect(press.findAllByType(SWITCH)).toHaveLength(0);
    }
    // The switch is a sibling of the press inside the frame, so a tap on the
    // switch never reaches the press that opens the trigger.
    for (const [index, press] of presses.entries()) {
      expect(switches[index]?.parent).toBe(press.parent);
    }
  });

  it('opens the trigger from the press beside the switch', async () => {
    const root = await mount();
    const press = root
      .findAll(node => Object.is(node.type, PRESSABLE))
      .find(node => node.props.accessibilityLabel === 'trigger-a');
    if (!press) {
      throw new Error('missing the row press for trigger-a');
    }

    act(() => {
      (press.props.onPress as () => void)();
    });

    expect(router.push).toHaveBeenCalledWith(triggerDetailHref('trigger-a', undefined));
  });

  it('names each switch after its trigger and sends its flip to the mutation', async () => {
    const root = await mount();
    const switches = root.findAll(node => Object.is(node.type, SWITCH));
    const labels = switches.map(node => node.props.accessibilityLabel as string);

    expect(labels[0]).toBe('Trigger active and trigger-a');
    for (const [index, label] of labels.entries()) {
      expect(label).toContain('Trigger active');
      expect(label).toContain(index === 0 ? 'trigger-a' : 'trigger-b');
    }

    const [first] = switches;
    if (!first) {
      throw new Error('missing the first switch');
    }
    act(() => {
      (first.props.onValueChange as (next: boolean) => void)(false);
    });
    expect(setActive.mutate).toHaveBeenCalledWith({ triggerId: 'trigger-a', isActive: false });
  });
});
