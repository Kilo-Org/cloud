import { type ElementType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { BriefingScorecard } from './briefing-card';

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
  useBriefingDismissals: () => ({ isSuccess: true, data: [] }),
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
