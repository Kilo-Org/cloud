import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';

import { OrgKiloPassUsage } from './org-kilo-pass-usage';

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isPending: false,
  isError: false,
  error: null as unknown,
  isFetching: false,
  refetch: vi.fn(),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgKiloPassUsage: () => query,
}));

// The primitives' own geometry is asserted where they live; here the section's
// copy is what matters, so each one renders the props it was handed.
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/section', () => ({ Section: 'Section' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/row-group', () => ({ RowGroup: 'RowGroup' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));

vi.mock('@/components/ui/button', async () => {
  const { createElement: h } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Button', props, props.children as never),
  };
});

vi.mock('@/components/ui/row-frame', async () => {
  const { createElement: h } = await import('react');
  return {
    RowFrame: (props: {
      title?: string;
      subtitle?: { text: string };
      footer?: unknown;
      icon?: unknown;
    }) =>
      h('RowFrame', props, [
        h('Text', { key: 'title' }, props.title),
        h('Text', { key: 'subtitle' }, props.subtitle?.text),
        h('Footer', { key: 'footer' }, props.footer as never),
      ]),
  };
});

function allocation(overrides?: Record<string, unknown>) {
  return {
    organizationId: 'org-1',
    organizationName: 'Acme',
    passCount: 2,
    kind: 'parent',
    hasProratedCredits: false,
    baseCreditsMicrodollars: 40_000_000,
    qualifyingSpendMicrodollars: 10_000_000,
    unlockTargetMicrodollars: 40_000_000,
    bonusCreditsMicrodollars: 5_000_000,
    bonusState: 'locked',
    ...overrides,
  };
}

function usage(allocations: Record<string, unknown>[]) {
  return {
    tier: 'tier_49',
    terms: {
      tier: 'tier_49',
      tierName: 'Kilo Pass 49',
      pricePerPassUsd: 49,
      baseCreditsPerPassUsd: 20,
      bonusCreditsPerPassUsd: 5,
      unlockSpendPerPassUsd: 20,
      bonusMode: 'after_base',
    },
    currentWindow: {
      startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-12-01T00:00:00.000Z',
    },
    currentAllocations: allocations,
  };
}

function mount(props?: { hasBillingRole?: boolean; agreementOpen?: boolean }) {
  return renderWithProviders(
    createElement(OrgKiloPassUsage, {
      organizationId: 'org-1',
      hasBillingRole: props?.hasBillingRole ?? true,
      agreementOpen: props?.agreementOpen ?? true,
    })
  );
}

function texts(renderer: {
  root: { findAllByType: (type: string) => { props: Record<string, unknown> }[] };
}): unknown[] {
  return renderer.root.findAllByType('Text').flatMap(node => node.props.children);
}

function meterWidths(renderer: {
  root: { findAllByType: (type: string) => { props: Record<string, unknown> }[] };
}): unknown[] {
  return renderer.root
    .findAllByType('View')
    .map(node => (node.props.style as { width?: unknown } | undefined)?.width)
    .filter(width => width !== undefined);
}

beforeEach(() => {
  query.data = undefined;
  query.isPending = false;
  query.isError = false;
  query.error = null;
  query.isFetching = false;
  query.refetch.mockClear();
});

describe('OrgKiloPassUsage rows', () => {
  it('prints every allocation with its pass line, bonus copy, bonus amount and meter', async () => {
    query.data = usage([
      allocation(),
      allocation({
        organizationId: 'org-child',
        organizationName: 'Acme Child',
        passCount: 1,
        kind: 'child',
        baseCreditsMicrodollars: 20_000_000,
        qualifyingSpendMicrodollars: 40_000_000,
        bonusState: 'unlocked',
      }),
    ]);
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toEqual(expect.arrayContaining(['Acme', 'Acme Child']));
    expect(copy).toContain(
      i18n.t('organization.kiloPass.usage.passLine', {
        count: 2,
        passes: '2',
        credits: isolateLtrBidiText('$40.00'),
      })
    );
    expect(copy).toContain(
      i18n.t('organization.kiloPass.usage.bonusLocked', {
        spent: isolateLtrBidiText('$10.00'),
        target: isolateLtrBidiText('$40.00'),
      })
    );
    expect(copy).toContain(i18n.t('organization.kiloPass.usage.bonusUnlocked'));
    expect(copy).toEqual(expect.arrayContaining([isolateLtrBidiText('$5.00')]));
    // The locked row measures its spend against the target; the paid one reads
    // full whatever it spent.
    expect(meterWidths(renderer)).toEqual(['25%', '100%']);
    unmount();
  });

  it('renders the singular pass line for a single-pass allocation', async () => {
    query.data = usage([
      allocation({ organizationName: 'Acme Child', passCount: 1, kind: 'child' }),
    ]);
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toContain('1 pass · \u2066$40.00\u2069 monthly Credits');
    expect(copy).not.toContain('1 passes · \u2066$40.00\u2069 monthly Credits');
    unmount();
  });

  it('states an allocation with no passes instead of its bonus progress', async () => {
    query.data = usage([
      allocation({ passCount: 0, baseCreditsMicrodollars: 0, qualifyingSpendMicrodollars: 0 }),
    ]);
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toContain(i18n.t('organization.kiloPass.usage.noPasses'));
    expect(copy).not.toContain(
      i18n.t('organization.kiloPass.usage.bonusLocked', {
        spent: isolateLtrBidiText('$0.00'),
        target: isolateLtrBidiText('$40.00'),
      })
    );
    expect(meterWidths(renderer)).toEqual(['0%']);
    unmount();
  });

  it('adds the prorated note, naming the full month a pass is worth', async () => {
    query.data = usage([allocation({ hasProratedCredits: true })]);
    const { renderer, unmount } = await mount();

    expect(texts(renderer)).toContain(
      i18n.t('organization.kiloPass.usage.proratedNote', {
        credits: isolateLtrBidiText('$20.00'),
      })
    );
    unmount();
  });
});

describe('OrgKiloPassUsage states', () => {
  it('renders the empty sentence before the first window is issued', async () => {
    query.data = null;
    const { renderer, unmount } = await mount();

    expect(texts(renderer)).toEqual([i18n.t('organization.kiloPass.usage.empty')]);
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
    unmount();
  });

  it('renders Retry for a failure asking again can fix, and presses it', async () => {
    query.isError = true;
    query.error = new Error('network down');
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toContain(i18n.t('common.somethingWentWrong'));
    const [retry] = renderer.root.findAllByType('Button');
    if (retry === undefined) {
      throw new Error('the retryable state renders no Retry');
    }
    expect(retry.props.loading).toBe(false);
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(query.refetch).toHaveBeenCalledOnce();
    unmount();
  });

  it('states a terminal failure without offering Retry', async () => {
    query.isError = true;
    query.error = { data: { code: 'FORBIDDEN' } };
    const { renderer, unmount } = await mount();

    expect(texts(renderer)).toEqual([i18n.t('organization.kiloPass.usage.unavailable')]);
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
    unmount();
  });

  it('reserves the loaded rows while the first read runs', async () => {
    query.isPending = true;
    const { renderer, unmount } = await mount();

    expect(renderer.root.findAllByType('RowSkeleton')).toHaveLength(1);
    expect(renderer.root.findAllByType('RowFrame')).toHaveLength(0);
    unmount();
  });

  it('renders nothing without a billing role or without a live agreement', async () => {
    query.data = usage([allocation()]);
    const withoutRole = await mount({ hasBillingRole: false });
    expect(withoutRole.renderer.toJSON()).toBeNull();
    withoutRole.unmount();

    const withoutAgreement = await mount({ agreementOpen: false });
    expect(withoutAgreement.renderer.toJSON()).toBeNull();
    withoutAgreement.unmount();
  });
});
