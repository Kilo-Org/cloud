import { type ElementType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { AdaptiveHomeCardFrame } from '@/components/home/adaptive-home-card-frame';

import { BriefingCard, BriefingScorecard } from './briefing-card';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'android' },
  I18nManager: { isRTL: false, getConstants: () => ({ isRTL: false }) },
}));
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
    dismiss: vi.fn<() => void>(),
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

type Scorecard = Parameters<typeof BriefingScorecard>[0]['report']['scorecard'];

function renderScorecard(scorecard: Scorecard): ReactTestRenderer {
  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <BriefingScorecard
        report={{ scorecard } as unknown as Parameters<typeof BriefingScorecard>[0]['report']}
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
  it('shows the selected snapshot counts, including zero', () => {
    const rendered = renderedScorecard(
      renderScorecard({ sessions: 0, pullRequests: 0, blockers: 0 })
    );
    expect(rendered.values).toEqual(['0', '0', '0']);
    expect(rendered.labels).toEqual([
      'agentBriefing.selectedSessions',
      'agentBriefing.snapshotPullRequests',
      'agentBriefing.snapshotBlockers',
    ]);
  });

  it('renders selected counts without historical-total or spend claims', () => {
    expect(
      renderedScorecard(renderScorecard({ sessions: 3, pullRequests: 1, blockers: 0 })).values
    ).toEqual(['3', '1', '0']);
  });
});

// Only the fields BriefingCard reads: the summary line and the scorecard counts.
const briefingReport = {
  id: 'report-1',
  localDate: '2026-11-02',
  summary: { status: 'ready', text: 'Overnight work' },
  scorecard: { sessions: 2, pullRequests: 1, blockers: 1 },
} as unknown as Parameters<typeof BriefingCard>[0]['report'];

function renderCardInFrame(layer: 'drawn' | 'reserved'): ReactTestRenderer {
  const card = <BriefingCard report={briefingReport} />;
  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      layer === 'drawn' ? (
        <AdaptiveHomeCardFrame live={card} showBriefing={false} />
      ) : (
        <AdaptiveHomeCardFrame live={null} briefing={card} showBriefing={false} />
      )
    );
  });
  if (!ref.current) {
    throw new Error('BriefingCard did not mount in the frame');
  }
  return ref.current;
}

function pressablesIn(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('Pressable' as ElementType);
}

describe('BriefingCard in the Home card frame', () => {
  it('keeps every control pressable in the layer the frame draws', () => {
    const pressables = pressablesIn(renderCardInFrame('drawn'));
    expect(pressables).toHaveLength(3);
    for (const pressable of pressables) {
      expect(typeof pressable.props.onPress).toBe('function');
    }
  });

  it('renders no pressable at all in the layer that only reserves height', () => {
    expect(pressablesIn(renderCardInFrame('reserved'))).toHaveLength(0);
  });
});
