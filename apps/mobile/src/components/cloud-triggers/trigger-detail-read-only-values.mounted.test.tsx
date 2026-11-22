/**
 * The read-only half of a trigger's screen names the saved agent and model the
 * way the form does.
 *
 * The panel belongs to a viewer who cannot change the trigger, so every row is
 * a saved value and carries no control. The agent row reads the built-in mode's
 * own name, and the model row reads the catalogue name of the saved id, or its
 * readable last segment while the catalogue does not carry it.
 */

import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerDetailScreen } from './trigger-detail-screen';

const dismissTo = vi.fn();

/** The trigger and catalogue the screen under test reads, replaced per test. */
const state = vi.hoisted(() => {
  const baseDetail = () => ({
    triggerId: 'release-gate',
    namespace: 'org/org-1',
    userId: null,
    orgId: 'org-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: true,
    targetType: 'cloud_agent' as const,
    githubRepo: 'Kilo-Org/release-gate',
    mode: 'code' as string | null,
    model: 'kilo/fake-deterministic' as string | null,
    promptTemplate: 'Run the release gate.',
    webhookAuthConfigured: false,
    activationMode: 'webhook' as const,
    inboundUrl: 'https://Inbound.example/release-gate',
    canEdit: false,
    canEditReason: 'role' as 'role' | 'creator_run' | null,
    canRun: false,
  });
  return {
    detail: baseDetail(),
    /** The catalogue the model row resolves the saved id against. */
    models: [] as { id: string; name: string; variants: string[]; isPreferred: boolean }[],
    reset() {
      this.detail = baseDetail();
      this.models = [];
    },
  };
});

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), dismissTo }) }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: (organizationId?: string) => ({
    organizationId: organizationId ?? null,
    role: null,
    org: organizationId === undefined ? null : { id: organizationId },
    isResolving: false,
  }),
}));
vi.mock('@/lib/cloud-triggers/use-cloud-triggers', () => ({
  useCloudTrigger: () => ({
    isPending: false,
    isError: false,
    isFetching: false,
    data: state.detail,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    models: state.models,
    isLoading: false,
    isError: false,
    isFetching: false,
    isFetched: true,
    hasDeliveredData: true,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', async () => {
  const { createElement: h } = await import('react');
  return {
    ScreenHeader: (props: Record<string, unknown>) => h('ScreenHeader', props),
  };
});
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./trigger-edit-panel', () => ({ TriggerEditPanel: 'TriggerEditPanel' }));
vi.mock('./trigger-deliveries', () => ({ TriggerDeliveries: 'TriggerDeliveries' }));
vi.mock('./trigger-url-card', () => ({ TriggerUrlCard: 'TriggerUrlCard' }));

const EDIT_PANEL = 'TriggerEditPanel' as ElementType;
const KV_ROW = 'KvRow' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(
    createElement(TriggerDetailScreen, { triggerId: 'release-gate', organizationId: 'org-1' })
  );
  renderer = view.renderer;
  return view.renderer.root;
}

/** The value one read-only row renders, found by its label. */
function rowValue(root: ReactTestRenderer['root'], label: string): unknown {
  const rows = root.findAll(node => Object.is(node.type, KV_ROW) && node.props.label === label);
  if (rows.length !== 1) throw new Error(`expected one ${label} row, found ${rows.length}`);
  return rows[0]?.props.value;
}

beforeEach(() => {
  state.reset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TriggerDetailScreen read-only values', () => {
  it('offers no form to a viewer who cannot change the trigger', async () => {
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, EDIT_PANEL))).toHaveLength(0);
  });

  it('names the built-in agent mode and a model the catalogue lacks', async () => {
    const root = await mount();

    expect(rowValue(root, 'Agent')).toBe(i18n.t('agentChat.modeOptions.code'));
    expect(rowValue(root, 'Model')).toBe('fake deterministic');
  });

  it('names a model the catalogue carries', async () => {
    state.models = [
      { id: 'kilo/fake-deterministic', name: 'Fake Deterministic', variants: [], isPreferred: false },
    ];

    const root = await mount();

    expect(rowValue(root, 'Model')).toBe('Fake Deterministic');
  });

  it('translates a localized Auto model name', async () => {
    state.detail = { ...state.detail, model: 'kilo-auto/efficient' };
    state.models = [
      { id: 'kilo-auto/efficient', name: 'Auto Efficient', variants: [], isPreferred: false },
    ];

    const root = await mount();

    expect(rowValue(root, 'Model')).toBe(i18n.t('models.auto.efficient'));
  });

  it('shows a custom agent slug as itself', async () => {
    state.detail = { ...state.detail, mode: 'foreman' };

    const root = await mount();

    expect(rowValue(root, 'Agent')).toBe('foreman');
  });

  it('shows both values as unknown when the trigger saved neither', async () => {
    state.detail = { ...state.detail, mode: null, model: null };

    const root = await mount();

    expect(rowValue(root, 'Agent')).toBe(i18n.t('common.unknown'));
    expect(rowValue(root, 'Model')).toBe(i18n.t('common.unknown'));
  });
});
