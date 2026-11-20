import { describe, expect, it } from '@jest/globals';
import type { CustomRouterSummary } from '@kilocode/auto-routing-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PoolBenchmarkWarnings, poolBenchmarkWarnings } from './PoolBenchmarkWarnings';

function summary(overrides: Partial<CustomRouterSummary> = {}): CustomRouterSummary {
  return {
    id: '00000000-0000-4000-8000-000000000003',
    scope: 'user',
    slug: 'my-pool',
    name: 'My pool',
    modelId: 'kilo-auto/custom/user/my-pool',
    baseRouter: 'efficient',
    mode: 'cost_per_accuracy',
    defaultEntryKey: 'gateway:vendor/a',
    canEdit: true,
    entries: [
      {
        key: 'gateway:vendor/a',
        entry: { kind: 'gateway', model: 'vendor/a' },
        needsClientEval: false,
        variants: [{ variant: null, status: 'ready', failureReason: null, linked: false }],
      },
    ],
    ...overrides,
  };
}

describe('poolBenchmarkWarnings', () => {
  it('reports nothing for a measured concrete pool', () => {
    expect(poolBenchmarkWarnings(summary())).toEqual([]);
  });

  it('explains what benchmarking an alias pins', () => {
    const warnings = poolBenchmarkWarnings(
      summary({
        entries: [
          {
            key: 'gateway:~vendor/model-latest',
            entry: { kind: 'gateway', model: '~vendor/model-latest' },
            needsClientEval: false,
            variants: [{ variant: null, status: 'ready', failureReason: null, linked: false }],
          },
        ],
      })
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('~vendor/model-latest');
    expect(warnings[0]?.message).toContain('benchmarking pins the model this alias resolves to');
  });

  it('reports a failed benchmark with its recorded reason', () => {
    const warnings = poolBenchmarkWarnings(
      summary({
        entries: [
          {
            key: 'gateway:vendor/a',
            entry: { kind: 'gateway', model: 'vendor/a' },
            needsClientEval: false,
            variants: [
              {
                variant: 'high',
                status: 'failed',
                failureReason: 'provider returned 404',
                linked: false,
              },
            ],
          },
        ],
      })
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.tone).toBe('warning');
    expect(warnings[0]?.message).toContain('vendor/a (high)');
    expect(warnings[0]?.message).toContain('provider returned 404');
  });

  it('reports a permanent failure from the status row the API actually sends', () => {
    const warnings = poolBenchmarkWarnings(
      summary({
        entries: [
          {
            key: 'gateway:vendor/a',
            entry: { kind: 'gateway', model: 'vendor/a' },
            needsClientEval: false,
            variants: [
              {
                variant: null,
                status: 'failed',
                failureReason: 'not in the catalog',
                linked: false,
                resolvedModel: 'vendor/a',
                availability: 'permanent_failure',
                failure: {
                  kind: 'permanent',
                  failureClass: 'model_not_found',
                  reason: 'not in the catalog',
                  attempts: 6,
                  firstFailedAt: '2026-11-18T00:00:00.000Z',
                  lastFailedAt: '2026-11-20T00:00:00.000Z',
                  cause: 'terminal_class',
                },
              },
            ],
          },
        ],
      })
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.tone).toBe('destructive');
    expect(warnings[0]?.message).toContain('Benchmark permanently failed for vendor/a');
    expect(warnings[0]?.message).toContain('not in the catalog');
    expect(warnings[0]?.message).toContain('cannot be added to a pool');
  });

  it('treats a permanent availability row without a failure object as permanent', () => {
    const warnings = poolBenchmarkWarnings(
      summary({
        entries: [
          {
            key: 'gateway:vendor/a',
            entry: { kind: 'gateway', model: 'vendor/a' },
            needsClientEval: false,
            variants: [
              {
                variant: null,
                status: 'failed',
                failureReason: 'the provider removed this model',
                linked: false,
                availability: 'permanent_failure',
              },
            ],
          },
        ],
      })
    );
    expect(warnings[0]?.tone).toBe('destructive');
    expect(warnings[0]?.message).toContain('the provider removed this model');
  });

  it('reports a fallback when the pinned target is gone', () => {
    const warnings = poolBenchmarkWarnings(
      summary({
        entries: [
          {
            key: 'gateway:~vendor/model-latest',
            entry: {
              kind: 'gateway',
              model: '~vendor/model-latest',
              servingPin: { model: 'vendor/model-2', pinnedAt: '2026-11-19T00:00:00.000Z' },
            },
            needsClientEval: false,
            variants: [
              {
                variant: null,
                status: 'ready',
                failureReason: null,
                linked: false,
                servingFallback: true,
                servingModel: 'vendor/model-3',
              },
            ],
          },
        ],
      }),
      new Map([['~vendor/model-latest', 'vendor/model-3']])
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.tone).toBe('warning');
    expect(warnings[0]?.message).toContain('vendor/model-2 is no longer served');
    expect(warnings[0]?.message).toContain('go to vendor/model-3, which is measured in this pool');
  });

  it('reports a fallback target with no measurement as unmeasured', () => {
    const warnings = poolBenchmarkWarnings(
      summary({
        entries: [
          {
            key: 'gateway:~vendor/model-latest',
            entry: {
              kind: 'gateway',
              model: '~vendor/model-latest',
              servingPin: { model: 'vendor/model-2', pinnedAt: '2026-11-19T00:00:00.000Z' },
            },
            needsClientEval: false,
            variants: [
              {
                variant: null,
                status: 'missing',
                failureReason: null,
                linked: false,
                servingFallback: true,
              },
            ],
          },
        ],
      }),
      new Map([['~vendor/model-latest', 'vendor/model-3']])
    );
    expect(warnings[0]?.tone).toBe('destructive');
    expect(warnings[0]?.message).toContain('go to vendor/model-3, which has no measurement');
  });

  it('reports a moved alias while the pinned target still serves', () => {
    const warnings = poolBenchmarkWarnings(
      summary({
        entries: [
          {
            key: 'gateway:~vendor/model-latest',
            entry: {
              kind: 'gateway',
              model: '~vendor/model-latest',
              servingPin: { model: 'vendor/model-2', pinnedAt: '2026-11-19T00:00:00.000Z' },
            },
            needsClientEval: false,
            variants: [
              {
                variant: null,
                status: 'ready',
                failureReason: null,
                linked: false,
                servingModel: 'vendor/model-2',
              },
            ],
          },
        ],
      }),
      new Map([['~vendor/model-latest', 'vendor/model-3']])
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.tone).toBe('warning');
    expect(warnings[0]?.message).toContain('now resolves to vendor/model-3');
    expect(warnings[0]?.message).toContain('keeps using the benchmarked vendor/model-2');
  });

  it('renders nothing without warnings', () => {
    expect(renderToStaticMarkup(createElement(PoolBenchmarkWarnings, { router: summary() }))).toBe(
      ''
    );
  });
});
