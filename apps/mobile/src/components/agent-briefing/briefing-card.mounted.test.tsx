import { type ElementType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { BriefingCard, BriefingScorecard } from './briefing-card';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ X: 'X' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'Chevron' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn<() => void>() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { value?: string }) =>
      values?.value === undefined ? key : `${key}:${values.value}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/agent-briefing', () => ({
  BRIEFING_PATH: '/(app)/agent-briefing',
  useBriefings: () => ({ reports: [] }),
  useBriefingDismissals: () => ({
    isSuccess: true,
    data: [],
    save: { isPending: false },
    dismiss: () => undefined,
  }),
}));
vi.mock('@/lib/hooks/use-now-ticker', () => ({ useNowTicker: () => Date.now() }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' '),
}));

type Coverage = Parameters<typeof BriefingScorecard>[0]['report']['coverage'];
type Scorecard = Parameters<typeof BriefingScorecard>[0]['report']['scorecard'];

const complete: Coverage = {
  activity: 'complete',
  spend: 'complete',
  blockers: 'complete',
  pullRequests: 'complete',
};
const partial: Coverage = {
  activity: 'partial',
  spend: 'unavailable',
  blockers: 'partial',
  pullRequests: 'partial',
};

function renderScorecard(scorecard: Scorecard, coverage: Coverage): ReactTestRenderer {
  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <BriefingScorecard
        report={
          { scorecard, coverage } as unknown as Parameters<typeof BriefingScorecard>[0]['report']
        }
      />
    );
  });
  if (!ref.current) {
    throw new Error('BriefingScorecard did not mount');
  }
  return ref.current;
}

function renderedScorecard(renderer: ReactTestRenderer): { values: string[]; labels: string[] } {
  const texts = renderer.root
    .findAllByType('Text' as ElementType)
    .map(node => String(node.props.children));
  return {
    values: texts.filter((_, index) => index % 2 === 0),
    labels: texts.filter((_, index) => index % 2 === 1),
  };
}

describe('BriefingScorecard', () => {
  it('shows proven zeros for a collected quiet night', () => {
    const rendered = renderedScorecard(
      renderScorecard({ sessions: 0, pullRequests: 0, blockers: 0, spendMicrodollars: 0 }, complete)
    );
    expect(rendered.values).toEqual(['0', '0', '0', '$0.00']);
    expect(rendered.labels).toEqual([
      'agentBriefing.sessions',
      'agentBriefing.pullRequests',
      'agentBriefing.blockers',
      'agentBriefing.spend',
    ]);
  });

  it('keeps unknown for values the evidence cannot prove', () => {
    expect(
      renderedScorecard(
        renderScorecard(
          { sessions: 0, pullRequests: 0, blockers: 0, spendMicrodollars: 0 },
          partial
        )
      ).values
    ).toEqual(['common.unknown', 'common.unknown', 'common.unknown', 'common.unknown']);
  });

  it('marks a positive count as a lower bound while coverage is partial', () => {
    expect(
      renderedScorecard(
        renderScorecard(
          { sessions: 3, pullRequests: 1, blockers: 0, spendMicrodollars: 0 },
          partial
        )
      ).values
    ).toEqual([
      'agentBriefing.atLeast:3',
      'agentBriefing.atLeast:1',
      'common.unknown',
      'common.unknown',
    ]);
  });
});

describe('BriefingCard', () => {
  const report = {
    id: 'report-e2e',
    kind: 'scheduled',
    createdAt: '2026-10-23T04:00:00.000Z',
    timezone: 'UTC',
    context: { id: 'personal', organizationId: null, name: 'Personal' },
    localDate: '2026-10-23',
    nightStartAt: '2026-10-22T20:00:00.000Z',
    cutoffAt: '2026-10-23T04:00:00.000Z',
    morningEndAt: '2026-10-24T08:00:00.000Z',
    publishedAt: '2026-10-23T04:05:00.000Z',
    updatedAt: '2026-10-23T04:05:00.000Z',
    revision: 1,
    revised: false,
    readAt: null,
    dismissedAt: null,
    scorecard: { sessions: 2, pullRequests: 1, blockers: 0, spendMicrodollars: 1200 },
    coverage: complete,
    sessions: [],
    sources: [],
    summary: {
      status: 'ready',
      text: 'Two sessions ran overnight.',
      model: null,
      costMicrodollars: 0,
      chargeStatus: 'settled',
      estimatedCostMicrodollars: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
      canRetry: false,
    },
    expiresAt: '2026-10-24T08:00:00.000Z',
  } satisfies Parameters<typeof BriefingCard>[0]['report'];

  it('gives the dismiss control the shared 48dp frame and keeps its circle compact', () => {
    // Field defect: the control was `size-11`, 38.5pt at NativeWind's 14pt rem,
    // under both the 44pt design target and Android's 48dp minimum, and a size
    // audit reads the node's own rect rather than a hit slop.
    const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(<BriefingCard report={report} />);
    });
    const node = ref.current?.root;
    if (!node) {
      throw new Error('BriefingCard did not mount');
    }
    const dismiss = node.findByProps({ accessibilityLabel: 'agentBriefing.dismiss' });
    expect(dismiss.props.className).toContain(ICON_TARGET_BOX_CLASS);
    expect(dismiss.props.hitSlop).toBeUndefined();
    expect(dismiss.findByType('View' as ElementType).props.className).toContain('size-11');
  });
});
