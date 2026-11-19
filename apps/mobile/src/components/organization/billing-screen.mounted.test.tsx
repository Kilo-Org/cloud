import {
  AUTO_TOP_UP_URL,
  bannerAction,
  boundary,
  manageOnWebLink,
  mount,
  platform,
  queries,
  reads,
  resetBillingQueries,
  seatsReadout,
  subscriptionReadout,
  SUBSCRIPTIONS_URL,
  texts,
} from './billing-screen.test-helpers';
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  resetBillingQueries();
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
    // Shared readout: the fraction runs inside a left-to-right isolate, so a
    // right-to-left layout cannot mirror either number.
    expect(seatsReadout(renderer)).toBe('\u20663 / 4\u2069');
    unmount();
  });
});

describe('OrganizationBillingScreen manage-on-web links', () => {
  it('offers to manage auto top-up once the read answers enabled', async () => {
    queries.autoTopUp.data = { enabled: true, amountCents: 5000, thresholdCents: 1000 };
    const { renderer, unmount } = await mount();

    const autoTopUpLink = manageOnWebLink(renderer, AUTO_TOP_UP_URL);
    expect(autoTopUpLink?.props.label).toBe('Manage auto top-up');
    expect(autoTopUpLink?.props.url).toBe('http://localhost:3000/org-1');
    // The wording change belongs to this link alone: the block's other two
    // destinations keep the copy they had.
    expect(manageOnWebLink(renderer, SUBSCRIPTIONS_URL)?.props.label).toBe('Change plan');
    expect(manageOnWebLink(renderer, `${SUBSCRIPTIONS_URL}/seats`)?.props.label).toBe('Buy seats');
    unmount();
  });

  it('keeps the set-up wording when the read answers disabled', async () => {
    queries.autoTopUp.data = { enabled: false, amountCents: 5000, thresholdCents: 1000 };
    const { renderer, unmount } = await mount();

    expect(manageOnWebLink(renderer, AUTO_TOP_UP_URL)?.props.label).toBe('Set up auto top-up');
    unmount();
  });

  it('keeps the set-up wording while the read is pending', async () => {
    // A pending read has no state to manage, so the block cannot claim one.
    queries.autoTopUp.isPending = true;
    queries.autoTopUp.data = undefined;
    const { renderer, unmount } = await mount();

    expect(manageOnWebLink(renderer, AUTO_TOP_UP_URL)?.props.label).toBe('Set up auto top-up');
    unmount();
  });

  it('keeps the set-up wording when the read failed', async () => {
    // A first read that rejected carries no data, and the error card above
    // already asks for the retry.
    queries.autoTopUp.isError = true;
    queries.autoTopUp.data = undefined;
    const { renderer, unmount } = await mount();

    expect(manageOnWebLink(renderer, AUTO_TOP_UP_URL)?.props.label).toBe('Set up auto top-up');
    unmount();
  });
});

describe('OrganizationBillingScreen organization override', () => {
  // The route carries the organization a refusal step resolved its role
  // against. Every read and link here is built from the boundary's returned id,
  // so the override has to reach the boundary or the screen shows another
  // organization's plan.
  it('reads and links the organization the route names', async () => {
    const { renderer, unmount } = await mount('org-2');

    expect(boundary.override).toBe('org-2');
    expect(reads.subscription).toBe('org-2');
    expect(reads.seats).toBe('org-2');
    expect(
      manageOnWebLink(renderer, 'http://localhost:3000/organizations/org-2/subscriptions')
    ).toBeDefined();
    unmount();
  });

  it('gives the placeholder boundary the same organization while it resolves', async () => {
    boundary.isResolving = true;
    const { renderer, unmount } = await mount('org-2');

    const placeholder = renderer.root.findByType('OrganizationBoundary' as never);
    expect(placeholder.props.organizationIdOverride).toBe('org-2');
    unmount();
  });
});

describe('OrganizationBillingScreen change plan placement', () => {
  it('leads a lapsed plan from the banner and keeps its row neutral', async () => {
    boundary.isTrialExpiredForEnforcement = true;
    queries.subscription.data = subscriptionReadout();
    const { renderer, unmount } = await mount();

    expect(bannerAction(renderer)?.label).toBe('Change plan');
    // The banner above already holds this destination, so the card's own copy
    // is gone; the block's other destinations stay.
    expect(manageOnWebLink(renderer, SUBSCRIPTIONS_URL)).toBeUndefined();
    expect(manageOnWebLink(renderer, `${SUBSCRIPTIONS_URL}/seats`)?.props.label).toBe('Buy seats');
    expect(manageOnWebLink(renderer, AUTO_TOP_UP_URL)?.props.url).toBe(AUTO_TOP_UP_URL);
    // The banner carries the ended state, so the plan value keeps the row's
    // own neutral tone instead of a second danger colour.
    const plan = renderer.root
      .findAllByType('KvRow' as never)
      .find(node => node.props.label === 'Organization plan');
    expect(plan).toBeDefined();
    expect(plan?.props.valueTone).toBeUndefined();
    unmount();
  });

  it('states where the settings live when the storefront rule refuses the link', async () => {
    // Outside the US storefront nothing links, so the banner has no action and
    // the card states where the settings live: one line, no heading naming the
    // web, and no purchase call to action.
    boundary.isTrialExpiredForEnforcement = true;
    platform.linkAllowed = false;
    const { renderer, unmount } = await mount();

    expect(bannerAction(renderer)).toBeUndefined();
    expect(renderer.root.findAllByType('ExternalBillingLink' as never)).toHaveLength(0);
    expect(texts(renderer)).toContain('The plan, seats and auto top-up are managed on the web.');
    unmount();
  });

  it('renders no banner and keeps the card copy while the plan is active', async () => {
    const { renderer, unmount } = await mount();

    expect(renderer.root.findAllByType('OrganizationPlanRefusal' as never).length).toBe(0);
    expect(manageOnWebLink(renderer, SUBSCRIPTIONS_URL)?.props.label).toBe('Change plan');
    unmount();
  });
});
