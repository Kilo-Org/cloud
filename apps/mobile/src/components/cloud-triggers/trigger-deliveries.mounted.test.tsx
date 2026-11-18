/**
 * A delivery's session link carries the trigger's organization scope.
 *
 * An organization trigger's run belongs to that organization; opening it from
 * the personal scope would re-key the session. The literal here is the route
 * helper's own output, so the suite fails if the screen stops using it.
 */

import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerDeliveries } from './trigger-deliveries';

const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('react-native', () => ({
  View: 'View',
  // `textActionTargetClass` reads the platform to pick the shared frame.
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
}));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@/lib/cloud-triggers/use-cloud-triggers', () => ({
  useTriggerDeliveries: () => ({
    isPending: false,
    isError: false,
    isFetching: false,
    data: [
      {
        id: 'delivery-1',
        triggerId: 'trigger-a',
        timestamp: '2026-01-01T00:00:00.000Z',
        triggerSource: 'webhook',
        processStatus: 'success',
        errorMessage: null,
        kiloSessionId: 'session-1',
      },
    ],
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState', StateAction: 'StateAction' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Workflow: 'Workflow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(organizationId?: string): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(
    createElement(TriggerDeliveries, { triggerId: 'trigger-a', organizationId })
  );
  renderer = view.renderer;
  return view.renderer.root;
}

function pressSessionLink(root: ReactTestRenderer['root']): void {
  const [button] = root.findAll(node => Object.is(node.type, BUTTON));
  if (!button) {
    throw new Error('missing session button');
  }
  act(() => {
    (button.props.onPress as () => void)();
  });
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  router.push.mockClear();
});

describe('TriggerDeliveries session link', () => {
  it('opens an organization trigger run in that organization', async () => {
    const root = await mount('organization-1');
    pressSessionLink(root);

    expect(router.push).toHaveBeenCalledWith(
      '/(app)/agent-chat/session-1?organizationId=organization-1'
    );
  });

  it('opens a personal trigger run without a scope', async () => {
    const root = await mount();
    pressSessionLink(root);

    expect(router.push).toHaveBeenCalledWith('/(app)/agent-chat/session-1');
  });
});
