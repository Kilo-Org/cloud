import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDuration } from '@/lib/format';
import { type SessionComputeCharges, type SessionComputeRate } from '@/lib/session-compute-total';

import { SessionComputeSection } from './session-compute-section';

const holder = vi.hoisted(() => ({ rates: [] as SessionComputeRate[] }));

vi.mock('@/lib/hooks/use-session-compute', () => ({
  useSessionComputeCharges: () => ({ data: undefined, isError: false, refetch: vi.fn() }),
  useComputeRates: () => ({ data: holder.rates }),
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => i18n.t(key) }),
  };
});
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});

const RATE_CENTS_PER_SECOND = 0.2;
const RATE = i18n.t('cloudAgent.compute.perHour', { rate: '$7.20' });

function chargesFor(seconds: number): SessionComputeCharges {
  return {
    amountMicrodollars: 720_000,
    seconds,
    scope: 'session',
    earlierRuns: null,
    runs: [
      {
        startedAt: '2026-11-12T10:00:00.000Z',
        stoppedAt: null,
        running: true,
        instance: 'standard-3',
        rateCentsPerSecond: RATE_CENTS_PER_SECOND,
        seconds,
        amountMicrodollars: 720_000,
      },
    ],
  };
}

function renderSection(seconds: number): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionComputeSection, {
        charges: chargesFor(seconds),
        isError: false,
        onRetry: vi.fn<() => void>(),
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function measureLine(renderer: TestRenderer.ReactTestRenderer): string {
  const line = renderer.root
    .findAll(node => node.type === Text)
    .map(node => node.props.children)
    .filter((value): value is string => typeof value === 'string')
    .find(value => value === RATE || value.includes('×'));
  if (line === undefined) {
    throw new Error('the run row painted no measure line');
  }
  return line;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => node.type === Text)
    .map(node => node.props.children)
    .filter((value): value is string => typeof value === 'string');
}

beforeEach(() => {
  holder.rates = [];
});

describe('SessionComputeSection run rows', () => {
  it('omits the duration of a run that has recorded no time, so no bare separator is painted', () => {
    const renderer = renderSection(0);

    expect(measureLine(renderer)).toBe(RATE);
    expect(measureLine(renderer)).not.toContain('×');

    renderer.unmount();
  });

  it('paints the measured time beside the rate once the run has recorded one', () => {
    const renderer = renderSection(120);

    expect(measureLine(renderer)).toBe(`${formatDuration(120, i18n.language)} × ${RATE}`);

    renderer.unmount();
  });
});

describe('SessionComputeSection current rates', () => {
  it('names only the sandbox sizes the catalogue still sells', () => {
    holder.rates = [
      {
        instance: 'standard-3',
        skuId: 'cloud-agent-containers-standard-3-2026-09',
        hourlyUsd: 7.2,
        available: false,
      },
      {
        instance: 'standard-4',
        skuId: 'cloud-agent-containers-standard-4-2026-09',
        hourlyUsd: 14.4,
        available: true,
      },
    ];
    const renderer = renderSection(60);

    expect(texts(renderer)).toContain(i18n.t('cloudAgent.compute.largeSandbox'));
    expect(texts(renderer)).not.toContain(i18n.t('cloudAgent.compute.mediumSandbox'));

    renderer.unmount();
  });
});
