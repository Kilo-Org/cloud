/**
 * A legacy KiloClaw Chat trigger's screen offers no Cloud Agent form.
 *
 * The screen's form posts mode, model, profile and body-schema changes, which a
 * KiloClaw trigger does not have; the web editor keeps a summary for one instead.
 * A viewer who may write it sees the saved values and where the trigger is
 * managed, and the Cloud Agent panel never mounts.
 */

import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerDetailScreen } from './trigger-detail-screen';

const dismissTo = vi.fn();

const detail = {
  triggerId: 'claw-trigger',
  namespace: 'user/user-1',
  userId: 'user-1',
  orgId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
  targetType: 'kiloclaw_chat' as const,
  kiloclawInstanceId: '00000000-0000-4000-8000-000000000001',
  githubRepo: null,
  mode: null,
  model: null,
  promptTemplate: 'Ask me anything',
  webhookAuthConfigured: false,
  activationMode: 'webhook' as const,
  inboundUrl: 'https://Inbound.example/claw-trigger',
  canEdit: true,
  canEditReason: null,
  canRun: true,
};

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), dismissTo }) }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  // An organization-scoped mount resolves the boundary, so the screen renders
  // its content (and the header with it) instead of the boundary fallback.
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
    data: detail,
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
const TEXT = 'Text' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

const DEFAULT_DETAIL_PROPS = { triggerId: 'x' };

async function mount(
  props: { triggerId: string; organizationId?: string } = DEFAULT_DETAIL_PROPS
): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(createElement(TriggerDetailScreen, props));
  renderer = view.renderer;
  return view.renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TriggerDetailScreen target type', () => {
  it('shows a KiloClaw Chat trigger as a summary without the Cloud Agent form', async () => {
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, EDIT_PANEL))).toHaveLength(0);
    const texts = root.findAll(node => Object.is(node.type, TEXT));
    expect(texts.map(node => node.props.children)).toContain('Manage on the web');
  });

  it('sends the header Back control to the scoped triggers list', async () => {
    const root = await mount({ triggerId: 'x', organizationId: 'org-1' });

    const header = root.findByProps({ title: 'x' }).props as {
      onBack: () => void;
    };
    act(() => {
      header.onBack();
    });

    expect(dismissTo).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/triggers?org=org-1');
  });
});
