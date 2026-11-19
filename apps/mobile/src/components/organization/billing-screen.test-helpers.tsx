import { vi } from 'vitest';

import { type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
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
  /** The id the screen asked the boundary for; a route's `?org=` arrives here. */
  override: undefined as string | undefined,
  isResolving: false,
  isTrialExpiredForEnforcement: false,
}));

/** The id each billing read was keyed on. */
const reads = vi.hoisted(() => ({
  subscription: undefined as string | undefined,
  seats: undefined as string | undefined,
}));

/** Whether the storefront rule lets this surface link to the web page. */
const platform = vi.hoisted(() => ({ linkAllowed: true }));

// `vi.hoisted` results cannot be exported at their declaration (vitest hoists
// them above the export), so they are exported after the declaration instead.
export { boundary, platform, queries, reads };

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => true,
  useOrgBoundary: (organizationIdOverride?: string) => {
    boundary.override = organizationIdOverride;
    const organizationId = organizationIdOverride ?? 'org-1';
    return {
      organizationId,
      role: 'owner',
      org: {
        id: organizationId,
        name: 'Acme',
        plan: 'enterprise',
        seatCount: boundary.seatCount,
        requireSeats: boundary.requireSeats,
        isTrialExpiredForEnforcement: boundary.isTrialExpiredForEnforcement,
        parentOrganizationId: null,
      },
      isResolving: boundary.isResolving,
    };
  },
  useOrgParentLink: () => ({ parentLink: null }),
  useOrgKiloPassSummary: () => queries.kiloPass,
}));

vi.mock('@/lib/hooks/use-org-billing-queries', () => ({
  useOrgSeatSubscription: (organizationId?: string) => {
    reads.subscription = organizationId;
    return queries.subscription;
  },
  useOrgSeats: (organizationId?: string) => {
    reads.seats = organizationId;
    return queries.seats;
  },
  useOrgAutoTopUpConfig: () => queries.autoTopUp,
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'http://localhost:3000' }));

vi.mock('@/lib/credits/add-credits-destination', () => ({
  organizationBillingUrl: (organizationId: string) => `http://localhost:3000/${organizationId}`,
}));

vi.mock('@/lib/billing/external-purchase-link', () => ({
  useCanLinkExternalPurchase: () => platform.linkAllowed,
}));

vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/a11y/tap-target', () => ({
  STATE_ACTION_CLASS: 'state-action',
  TOUCH_TARGET_OVERHANG_DP: 8,
}));

vi.mock('@/components/organization/external-billing-link', async () => {
  const { createElement: h } = await import('react');
  return {
    // The settings block owns the storefront gate, so this control is always
    // the control it was asked for.
    ExternalBillingLink: (props: { label?: string }) => h('ExternalBillingLink', props),
  };
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

export function mount(organizationIdOverride?: string) {
  return renderWithProviders(
    <OrganizationBillingScreen organizationIdOverride={organizationIdOverride} />
  );
}

type Handler = () => void;

/** The element's callback, narrowed out of the renderer's untyped props. */
export function handlerOf(node: ReactTestInstance, name: 'onPress'): Handler | undefined {
  const handler: unknown = node.props[name];
  return typeof handler === 'function' ? (handler as Handler) : undefined;
}

export function texts(renderer: ReactTestRenderer): unknown[] {
  return renderer.root.findAllByType('Text').flatMap(node => node.props.children);
}

export function onlyButton(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByType('Button');
}

export function subscriptionReadout() {
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
export function seatsReadout(renderer: ReactTestRenderer): unknown {
  const row = renderer.root.findAllByType('KvRow').find(node => node.props.label === 'In use');
  return row?.props.value;
}

/** The manage-on-web destinations, as the screen builds them from `org-1`. */
export const SUBSCRIPTIONS_URL = 'http://localhost:3000/organizations/org-1/subscriptions';
/** The auto top-up link's page: the billing page the destination mock returns. */
export const AUTO_TOP_UP_URL = 'http://localhost:3000/org-1';

/** A manage-on-web link, found by the page it opens. */
export function manageOnWebLink(
  renderer: ReactTestRenderer,
  url: string
): ReactTestInstance | undefined {
  return renderer.root
    .findAllByType('ExternalBillingLink' as never)
    .find(node => node.props.url === url);
}

/** The lapsed-plan banner's action, narrowed out of the renderer's untyped props. */
export function bannerAction(renderer: ReactTestRenderer): { label?: string } | undefined {
  const banner = renderer.root.findByType('OrganizationPlanRefusal' as never);
  const action: unknown = banner.props.action;
  return action as { label?: string } | undefined;
}

export function resetBillingQueries() {
  for (const query of Object.values(queries)) {
    query.isPending = false;
    query.isError = false;
    query.isFetching = false;
    query.data = undefined;
    query.refetch.mockClear();
  }
  boundary.requireSeats = true;
  boundary.seatCount = { used: 3, total: 3 };
  boundary.override = undefined;
  boundary.isResolving = false;
  boundary.isTrialExpiredForEnforcement = false;
  reads.subscription = undefined;
  reads.seats = undefined;
  platform.linkAllowed = true;
  queries.seats.data = { usedSeats: 3, totalSeats: 3 };
  queries.autoTopUp.data = { enabled: true, amountCents: 5000, thresholdCents: 1000 };
}
