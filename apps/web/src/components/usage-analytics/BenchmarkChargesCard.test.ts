/**
 * The benchmark charges card's row model. Rendering is a plain table, so the
 * behaviour worth pinning is the pool → concrete-model flattening: the pool row
 * must equal the server's pool total, and a truncated model list must fold into
 * one visible remainder row so the numbers still reconcile.
 *
 * `React.createElement` is used instead of JSX so this suite needs no JSX
 * transform; the global shim below mirrors `MetricCard.test.ts`, since the card
 * and its UI primitives are written for Next.js's automatic runtime.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { benchmarkProjectId } from '@kilocode/auto-routing-contracts';
import type { BenchmarkChargesOutput } from './types';
import { BenchmarkChargesCard, benchmarkChargeRows } from './BenchmarkChargesCard';

(globalThis as { React?: typeof React }).React = React;

const ROUTER_ID = '0f3c2b1a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const OTHER_ROUTER_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';

function pool(overrides: Partial<BenchmarkChargesOutput['pools'][number]> = {}) {
  const projectId = benchmarkProjectId({ scope: 'user', slug: 'my-pool', routerId: ROUTER_ID });
  return {
    projectId,
    poolSlug: 'my-pool',
    routerId: ROUTER_ID,
    poolScope: 'user' as const,
    costMicrodollars: 5_000_000,
    requestCount: 4,
    models: [
      { model: 'openai/gpt-5', costMicrodollars: 3_000_000, requestCount: 2 },
      { model: 'anthropic/claude', costMicrodollars: 1_500_000, requestCount: 1 },
    ],
    otherModelsCostMicrodollars: 500_000,
    otherModelsRequestCount: 1,
    ...overrides,
  };
}

function output(pools: BenchmarkChargesOutput['pools']): BenchmarkChargesOutput {
  return {
    status: 'ok',
    totalCostMicrodollars: pools.reduce((s, p) => s + p.costMicrodollars, 0),
    totalRequestCount: pools.reduce((s, p) => s + p.requestCount, 0),
    pools,
    hasMorePools: false,
  };
}

describe('benchmarkChargeRows', () => {
  it('renders nothing for an empty or missing result', () => {
    expect(benchmarkChargeRows(undefined)).toEqual([]);
    expect(
      benchmarkChargeRows({
        status: 'empty',
        totalCostMicrodollars: 0,
        totalRequestCount: 0,
        pools: [],
        hasMorePools: false,
      })
    ).toEqual([]);
  });

  it('lists the pool, then its models, then the folded remainder', () => {
    const rows = benchmarkChargeRows(output([pool()]));

    expect(rows.map(r => [r.kind, r.label])).toEqual([
      ['pool', 'my-pool'],
      ['model', 'openai/gpt-5'],
      ['model', 'anthropic/claude'],
      ['other', 'Other models'],
    ]);

    const poolRow = rows[0]!;
    const listed = rows.filter(r => r.kind !== 'pool');
    expect(listed.reduce((s, r) => s + r.costMicrodollars, 0)).toBe(poolRow.costMicrodollars);
    expect(listed.reduce((s, r) => s + r.requestCount, 0)).toBe(poolRow.requestCount);
  });

  it('omits the remainder row when the pool has no other models', () => {
    const rows = benchmarkChargeRows(
      output([pool({ otherModelsCostMicrodollars: 0, otherModelsRequestCount: 0 })])
    );
    expect(rows.some(r => r.kind === 'other')).toBe(false);
  });

  it('keeps pools that share a slug as separate keys', () => {
    const first = pool();
    const second = pool({
      projectId: benchmarkProjectId({ scope: 'org', slug: 'my-pool', routerId: OTHER_ROUTER_ID }),
      routerId: OTHER_ROUTER_ID,
      poolScope: 'org',
    });
    const rows = benchmarkChargeRows(output([first, second]));
    const poolKeys = rows.filter(r => r.kind === 'pool').map(r => r.key);

    expect(poolKeys).toHaveLength(2);
    expect(new Set(poolKeys).size).toBe(2);
  });

  it('keeps every row key unique across pools and models', () => {
    const second = pool({
      projectId: benchmarkProjectId({ scope: 'org', slug: 'my-pool', routerId: OTHER_ROUTER_ID }),
      routerId: OTHER_ROUTER_ID,
      poolScope: 'org',
    });
    const rows = benchmarkChargeRows(output([pool(), second]));
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
  });
});

describe('BenchmarkChargesCard markup', () => {
  it('shows the empty guidance instead of a table', () => {
    const html = renderToStaticMarkup(
      React.createElement(BenchmarkChargesCard, {
        data: undefined,
        loading: false,
        isError: false,
        onRetry: () => {},
      })
    );
    expect(html).toContain('No benchmark charges in this period');
    expect(html).not.toContain('<table');
  });

  it('names the loading operation and offers a retry on failure', () => {
    const loading = renderToStaticMarkup(
      React.createElement(BenchmarkChargesCard, {
        data: undefined,
        loading: true,
        isError: false,
        onRetry: () => {},
      })
    );
    expect(loading).toContain('Loading benchmark charges');

    const failed = renderToStaticMarkup(
      React.createElement(BenchmarkChargesCard, {
        data: undefined,
        loading: false,
        isError: true,
        onRetry: () => {},
      })
    );
    expect(failed).toContain('Benchmark charges could not load');
    expect(failed).toContain('Retry');
  });

  it('renders pool and model rows with the pool total intact', () => {
    const html = renderToStaticMarkup(
      React.createElement(BenchmarkChargesCard, {
        data: output([pool()]),
        loading: false,
        isError: false,
        onRetry: () => {},
      })
    );
    expect(html).toContain('my-pool');
    expect(html).toContain('openai/gpt-5');
    expect(html).toContain('Other models');
    // Ordinary amounts keep the familiar two decimals; only sub-cent values
    // reveal extra precision (covered in benchmark-charge-format.test.ts).
    expect(html).toContain('$5.00');
    expect(html).toContain('Pool');
  });
});
