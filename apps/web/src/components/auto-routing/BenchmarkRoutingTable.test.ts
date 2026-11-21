import { describe, expect, it } from '@jest/globals';
import type { CustomRoutingTable, RankedCandidate } from '@kilocode/auto-routing-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BenchmarkRoutingTable } from './BenchmarkRoutingTable';

function candidate(overrides: Partial<RankedCandidate>): RankedCandidate {
  return {
    model: 'vendor/a',
    accuracy: 0.93,
    avgCostUsd: 0.002,
    meetsThreshold: true,
    ...overrides,
  };
}

const TABLE: CustomRoutingTable = {
  version: 'run-1',
  generatedAt: '2026-11-20T12:00:00.000Z',
  minAccuracy: 0.7,
  switchCostFactor: 2,
  bestAccuracySwitchThreshold: 0.05,
  source: 'benchmark',
  routes: {
    'implementation/feature_development': [
      candidate({ model: 'vendor/a', accuracy: 0.93 }),
      candidate({ model: 'vendor/b', accuracy: 0.9 }),
    ],
  },
};

function render(table: CustomRoutingTable | null, servingPins?: Record<string, string>): string {
  return renderToStaticMarkup(
    createElement(BenchmarkRoutingTable, {
      table,
      mode: 'best_accuracy',
      defaultEntryLabel: 'vendor/default',
      servingPins,
    })
  );
}

describe('BenchmarkRoutingTable', () => {
  it('explains the empty state with the default-model fallback', () => {
    const html = render(null);
    expect(html).toContain('No routing table yet');
    expect(html).toContain('vendor/default');
  });

  it('shows the mode, floor, and build time', () => {
    const html = render(TABLE);
    expect(html).toContain('Best accuracy');
    expect(html).toContain('70.0%');
    expect(html).toContain('2026-11-20T12:00:00.000Z');
  });

  it('shows the served model with the reason it won that route', () => {
    const html = render(TABLE);
    expect(html).toContain('Feature development');
    expect(html).toContain('Implementation');
    expect(html).toContain('vendor/a');
    expect(html).toContain('Highest accuracy (93.0%)');
    expect(html).toContain('+3.0 pts vs vendor/b');
    expect(html).toContain('Alternates:');
    expect(html).toContain('vendor/b (90.0%)');
  });

  it('shows a route the table omits as a default-model fallback', () => {
    const html = render(TABLE);
    expect(html).toContain('Default model');
    expect(html).toContain('No measured model for this route');
    expect(html).toContain('vendor/default');
  });

  it('names the alias targets the pool keeps serving', () => {
    const html = render(TABLE, { 'gateway:~vendor/model-latest': 'vendor/model-2' });
    expect(html).toContain('Pinned aliases');
    expect(html).toContain('~vendor/model-latest');
    expect(html).toContain('vendor/model-2');
    expect(html).toContain('keep dispatching the benchmarked model');
  });
});
