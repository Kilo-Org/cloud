// Billing screen failure contract: a rejected read renders that block's error
// card with a Retry, and the Retry refetches only the query that failed — not
// its siblings. The query layer is mocked so each block's state is driven
// directly through the screen JSX.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { OrganizationBillingScreen } from './billing-screen';

const queries = vi.hoisted(() => ({
  subscription: {
    isPending: false,
    isError: false,
    isFetching: false,
    data: undefined as unknown,
    refetch: vi.fn(),
  },
  seats: {
    isPending: false,
    isError: false,
    isFetching: false,
    data: undefined as unknown,
    refetch: vi.fn(),
  },
  autoTopUp: {
    isPending: false,
    isError: false,
    isFetching: false,
    data: undefined as unknown,
    refetch: vi.fn(),
  },
  kiloPass: {
    isPending: false,
    isError: false,
    isFetching: false,
    data: undefined as unknown,
    refetch: vi.fn(),
  },
}));

/** The boundary's own seat numbers, which the seats read corrects once it lands. */
const boundary = vi.hoisted(() => ({
  requireSeats: true,
  seatCount: { used: 3, total: 3 },
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => true,
  useOrgBoundary: () => ({
    organizationId: 'org-1',
    role: 'owner',
    org: {
      id: 'org-1',
      name: 'Acme',
      plan: 'enterprise',
      seatCount: boundary.seatCount,
      requireSeats: boundary.requireSeats,
      isTrialExpiredForEnforcement: false,
      parentOrganizationId: null,
    },
    isResolving: false,
  }),
  useOrgParentLink: () => ({ parentLink: null }),
  useOrgKiloPassSummary: () => queries.kiloPass,
}));

vi.mock('@/lib/hooks/use-org-billing-queries', () => ({
  useOrgSeatSubscription: () => queries.subscription,
  useOrgSeats: () => queries.seats,
  useOrgAutoTopUpConfig: () => queries.autoTopUp,
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'http://localhost:3000' }));

vi.mock('@/lib/credits/add-credits-destination', () => ({
  organizationBillingUrl: (organizationId: string) => `http://localhost:3000/${organizationId}`,
}));

vi.mock('@/lib/external-billing-action', () => ({
  externalBillingAction: (url: string) => ({ kind: 'link', url }),
}));

vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/a11y/tap-target', () => ({ STATE_ACTION_CLASS: 'state-action' }));

vi.mock('@/components/organization/external-billing-link', async () => {
  const { createElement: h } = await import('react');
  return { ExternalBillingLink: (props: { label?: string }) => h('ExternalBillingLink', props) };
});

vi.mock('@/components/organization/organization-boundary', async () => {
  const { createElement: h } = await import('react');
  return { OrganizationBoundary: (props: { title?: string }) => h('OrganizationBoundary', props) };
});

vi.mock('@/components/organization/permission-denied', async () => {
  const { createElement: h } = await import('react');
  return { PermissionDenied: (props: { description?: string }) => h('PermissionDenied', props) };
});

vi.mock('@/components/organization/plan-refusal', async () => {
  const { createElement: h } = await import('react');
  return {
    OrganizationPlanRefusal: (props: { message?: string }) => h('OrganizationPlanRefusal', props),
  };
});

vi.mock('@/components/organization/org-kilo-pass-row-state', () => ({
  getOrgKiloPassRowState: () => null,
}));

vi.mock('@/components/screen-header', async () => {
  const { createElement: h } = await import('react');
  return { ScreenHeader: (props: { title?: string }) => h('ScreenHeader', props) };
});

vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));

vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/components/ui/button', async () => {
  const { createElement: h } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Button', props, props.children as never),
  };
});

vi.mock('@/components/ui/text', async () => {
  const { createElement: h } = await import('react');
  return {
    Text: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Text', props, props.children as never),
  };
});

vi.mock('react-native', () => ({ View: 'View' }));

function mount() {
  return renderWithProviders(createElement(OrganizationBillingScreen));
}

type Handler = () => void;

/** The element's callback, narrowed out of the renderer's untyped props. */
function handlerOf(node: ReactTestInstance, name: 'onPress'): Handler | undefined {
  const handler: unknown = node.props[name];
  return typeof handler === 'function' ? (handler as Handler) : undefined;
}

function texts(renderer: ReactTestRenderer): unknown[] {
  return renderer.root.findAllByType('Text').flatMap(node => node.props.children);
}

function onlyButton(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByType('Button');
}

function subscriptionReadout() {
  return {
    subscription: {
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', current_period_end: 1_767_225_600 }] },
    },
    seatsUsed: 3,
    totalSeats: 3,
    nextSeatCount: null,
    nextSeatCountEffectiveAt: null,
    paidSeatItemId: 'si_1',
  };
}

/** The seats row's rendered value, as the screen hands it to `KvRow`. */
function seatsReadout(renderer: ReactTestRenderer): unknown {
  const row = renderer.root
    .findAllByType('KvRow')
    .find(node => node.props.label === 'Organization seats');
  return row?.props.value;
}

beforeEach(() => {
  for (const query of Object.values(queries)) {
    query.isPending = false;
    query.isError = false;
    query.isFetching = false;
    query.data = undefined;
    query.refetch.mockClear();
  }
  boundary.requireSeats = true;
  boundary.seatCount = { used: 3, total: 3 };
  queries.seats.data = { usedSeats: 3, totalSeats: 3 };
  queries.autoTopUp.data = { enabled: true, amountCents: 5000, thresholdCents: 1000 };
});

describe('OrganizationBillingScreen failure states', () => {
  it('offers Retry when the subscription read fails, and refetches only that read', async () => {
    queries.subscription.isError = true;
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toContain('Something went wrong');
    expect(copy).toContain('Retry');

    await act(() => {
      handlerOf(onlyButton(renderer), 'onPress')?.();
    });

    expect(queries.subscription.refetch).toHaveBeenCalledTimes(1);
    expect(queries.seats.refetch).not.toHaveBeenCalled();
    expect(queries.autoTopUp.refetch).not.toHaveBeenCalled();
    unmount();
  });

  it('offers Retry when the auto top-up read fails, and refetches only that read', async () => {
    queries.subscription.data = subscriptionReadout();
    queries.autoTopUp.isError = true;
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toContain('Retry');
    // The subscription block painted its card, so the only error card is the
    // auto top-up one, and its Retry asks that read again.
    expect(renderer.root.findAllByType('KvRow').length).toBeGreaterThan(0);

    await act(() => {
      handlerOf(onlyButton(renderer), 'onPress')?.();
    });

    expect(queries.autoTopUp.refetch).toHaveBeenCalledTimes(1);
    expect(queries.subscription.refetch).not.toHaveBeenCalled();
    expect(queries.seats.refetch).not.toHaveBeenCalled();
    unmount();
  });
});

describe('OrganizationBillingScreen seats row', () => {
  it('holds an unenforced organization at seats used-only, before and after the read', async () => {
    boundary.requireSeats = false;
    // A legacy organization has never bought seats, and the seats read answers
    // `seat_count || 0` — so `3 / 0` is exactly the row it must not paint.
    boundary.seatCount = { used: 3, total: 0 };
    queries.subscription.data = subscriptionReadout();

    queries.seats.data = undefined;
    const firstFrame = await mount();
    expect(seatsReadout(firstFrame.renderer)).toBe('3');
    firstFrame.unmount();

    queries.seats.data = { usedSeats: 3, totalSeats: 0 };
    const settled = await mount();
    expect(seatsReadout(settled.renderer)).toBe('3');
    settled.unmount();
  });

  it('appends the total once a seat-enforcing organization has a positive one', async () => {
    boundary.requireSeats = true;
    boundary.seatCount = { used: 3, total: 0 };
    queries.subscription.data = subscriptionReadout();
    queries.seats.data = { usedSeats: 3, totalSeats: 4 };

    const { renderer, unmount } = await mount();
    expect(seatsReadout(renderer)).toBe('3 / 4');
    unmount();
  });
});
