import { describe, expect, it } from '@jest/globals';
import type {
  CustomRouterListEntry,
  PaidBenchmarkProgress,
} from '@kilocode/auto-routing-contracts';
import {
  entryRoutingStatus,
  hasUnsettledEntries,
  pausedRequestInfo,
} from './custom-router-display';

function entry(overrides: Partial<CustomRouterListEntry> = {}): CustomRouterListEntry {
  return {
    key: 'gateway:vendor/a',
    entry: { kind: 'gateway', model: 'vendor/a' },
    needsClientEval: false,
    variants: [{ variant: null, status: 'ready', failureReason: null, linked: false }],
    ...overrides,
  };
}

function aliasEntry(overrides: Partial<CustomRouterListEntry> = {}): CustomRouterListEntry {
  return entry({
    key: 'gateway:~vendor/model-latest',
    entry: { kind: 'gateway', model: '~vendor/model-latest' },
    ...overrides,
  });
}

const paused = { reason: 'No payer could be charged.', models: ['vendor/a'] };

function pausedProgress(
  models: string[] | undefined,
  nextCursor: string | null = null
): PaidBenchmarkProgress {
  return {
    status: 'paused',
    id: '00000000-0000-4000-8000-000000000004',
    estimateMicrodollars: 0,
    maximumMicrodollars: 0,
    chargedMicrodollars: 0,
    billedModelRequests: 0,
    kiloCoveredModelRequests: 0,
    kiloCoveredMicrodollars: 0,
    counts: { queued: 0, running: 0, reused: 0, done: 0, failed: 0, paused: models?.length ?? 1 },
    cases: [],
    nextCursor,
    reason: 'No current payer could be charged.',
    ...(models === undefined ? {} : { pausedModels: models }),
  };
}

describe('entryRoutingStatus', () => {
  it('shows a measured model as active in routing', () => {
    const status = entryRoutingStatus(entry());
    expect(status.kind).toBe('active');
    expect(status.active).toBe(true);
    expect(status.rebenchmarkNeeded).toBe(false);
  });

  it('shows a never-requested model as honestly inactive, not benchmarking', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [{ variant: null, status: 'missing', failureReason: null, linked: false }],
      })
    );
    expect(status.kind).toBe('not-benchmarked');
    expect(status.label).toBe('Not benchmarked yet');
    expect(status.active).toBe(false);
    expect(status.label).not.toContain('Benchmarking');
    expect(status.label).not.toContain('Paused');
  });

  it('does not present a missing row as paused without a paused request naming it', () => {
    const status = entryRoutingStatus(
      entry({
        key: 'gateway:vendor/b',
        entry: { kind: 'gateway', model: 'vendor/b' },
        variants: [{ variant: null, status: 'missing', failureReason: null, linked: false }],
      }),
      { paused }
    );
    expect(status.kind).toBe('not-benchmarked');
  });

  it('shows a first measurement as benchmarking but not serving', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [{ variant: null, status: 'running', failureReason: null, linked: false }],
      })
    );
    expect(status.kind).toBe('benchmarking');
    expect(status.active).toBe(false);
    expect(status.detail).toContain('cannot serve a route until this finishes');
  });

  it('keeps a measured model active while a newer measurement runs', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [
          { variant: null, status: 'ready', failureReason: null, linked: false },
          { variant: 'high', status: 'running', failureReason: null, linked: false },
        ],
      })
    );
    expect(status.kind).toBe('benchmarking');
    expect(status.active).toBe(true);
    expect(status.detail).toContain('keeps using its current measurement');
  });

  it('keeps an older measured model active while a newer measurement runs', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [
          { variant: null, status: 'stale', failureReason: null, linked: false },
          { variant: 'high', status: 'pending', failureReason: null, linked: false },
        ],
      })
    );
    expect(status.kind).toBe('benchmarking');
    expect(status.active).toBe(true);
  });

  it('shows a queued model that cannot serve yet as benchmarking but inactive', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [{ variant: null, status: 'pending', failureReason: null, linked: false }],
      })
    );
    expect(status.kind).toBe('benchmarking');
    expect(status.active).toBe(false);
  });

  it('shows the paused state and its reason for a model the paused request covers', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [{ variant: null, status: 'missing', failureReason: null, linked: false }],
      }),
      { paused }
    );
    expect(status.kind).toBe('paused');
    expect(status.detail).toBe('No payer could be charged.');
    expect(status.active).toBe(false);
    expect(status.rebenchmarkNeeded).toBe(true);
  });

  it('shows a permanent failure with the reason and keeps last measurement serving', () => {
    const status = entryRoutingStatus(
      entry({
        blocker: {
          kind: 'permanent',
          model: 'vendor/a',
          variant: null,
          failureClass: 'model_not_found',
          reason: 'the provider removed this model',
        },
      })
    );
    expect(status.kind).toBe('permanently-failed');
    expect(status.label).toBe('Permanently failed');
    expect(status.detail).toContain('the provider removed this model');
    expect(status.detail).toContain('last usable measurement');
    expect(status.active).toBe(true);
  });

  it('separates serving on an old pinned alias from being unavailable', () => {
    const pinned = entryRoutingStatus(
      aliasEntry({
        servingPin: { model: 'vendor/model-2', pinnedAt: '2026-11-19T00:00:00.000Z' },
        variants: [
          {
            variant: null,
            status: 'ready',
            failureReason: null,
            linked: false,
            servingModel: 'vendor/model-2',
          },
        ],
      }),
      { aliasTargets: new Map([['~vendor/model-latest', 'vendor/model-3']]) }
    );
    expect(pinned.kind).toBe('active-old-target');
    expect(pinned.active).toBe(true);
    expect(pinned.rebenchmarkNeeded).toBe(true);
    expect(pinned.detail).toContain('vendor/model-2');
    expect(pinned.detail).toContain('vendor/model-3');
  });

  it('shows a pinned target that is gone as unavailable', () => {
    const status = entryRoutingStatus(
      aliasEntry({
        servingPin: { model: 'vendor/model-2', pinnedAt: '2026-11-19T00:00:00.000Z' },
        variants: [
          {
            variant: null,
            status: 'stale',
            failureReason: null,
            linked: false,
            servingFallback: true,
            servingModel: 'vendor/model-3',
          },
        ],
      }),
      { aliasTargets: new Map([['~vendor/model-latest', 'vendor/model-3']]) }
    );
    expect(status.kind).toBe('unavailable');
    expect(status.active).toBe(false);
    expect(status.rebenchmarkNeeded).toBe(true);
    expect(status.detail).toContain('no longer served');
    expect(status.detail).toContain('vendor/model-3');
  });

  it('marks an older measurement active with a re-benchmark hint', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [{ variant: null, status: 'stale', failureReason: null, linked: false }],
      })
    );
    expect(status.kind).toBe('active-older-benchmark');
    expect(status.active).toBe(true);
    expect(status.rebenchmarkNeeded).toBe(true);
  });

  it('treats no status rows as unknown rather than ready', () => {
    const status = entryRoutingStatus(entry({ variants: [] }));
    expect(status.kind).toBe('unknown');
    expect(status.active).toBe(false);
  });
});

describe('pausedRequestInfo', () => {
  it('takes every affected model from the summary, not from loaded case pages', () => {
    const models = Array.from({ length: 40 }, (_unused, index) => `vendor/model-${index}`);
    const info = pausedRequestInfo(pausedProgress(models));
    expect(info?.models).toEqual(models);
    expect(info?.reason).toBe('No current payer could be charged.');
  });

  it('stays neutral when an older Worker omits the summary', () => {
    const info = pausedRequestInfo(pausedProgress(undefined));
    expect(info).not.toBeNull();
    expect(info?.models).toBeUndefined();
  });

  it('reports nothing for a request that is not paused', () => {
    expect(pausedRequestInfo({ status: 'empty' })).toBeNull();
  });
});

describe('entryRoutingStatus paused scope', () => {
  it('marks only the affected model paused and leaves a ready model active', () => {
    const pausedInfo = {
      reason: 'No current payer could be charged.',
      models: ['vendor/b'],
    };
    const measured = entry();
    const missing = entry({
      key: 'gateway:vendor/b',
      entry: { kind: 'gateway', model: 'vendor/b' },
      variants: [{ variant: null, status: 'missing', failureReason: null, linked: false }],
    });
    expect(entryRoutingStatus(measured, { paused: pausedInfo }).kind).toBe('active');
    expect(entryRoutingStatus(missing, { paused: pausedInfo }).kind).toBe('paused');
  });

  it('does not mark a missing row paused when the summary omits its model', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [{ variant: null, status: 'missing', failureReason: null, linked: false }],
      }),
      { paused: { reason: 'No payer.', models: ['vendor/other'] } }
    );
    expect(status.kind).toBe('not-benchmarked');
  });

  it('marks a named model paused even when it has no status rows', () => {
    const status = entryRoutingStatus(entry({ variants: [] }), {
      paused: { reason: 'No payer.', models: ['vendor/a'] },
    });
    expect(status.kind).toBe('paused');
    expect(status.active).toBe(false);
  });

  it('keeps an unnamed model with no status rows unknown', () => {
    const status = entryRoutingStatus(entry({ variants: [] }), {
      paused: { reason: 'No payer.', models: ['vendor/other'] },
    });
    expect(status.kind).toBe('unknown');
  });

  it('keeps rows neutral when an older Worker omits paused models', () => {
    const status = entryRoutingStatus(
      entry({
        variants: [{ variant: null, status: 'missing', failureReason: null, linked: false }],
      }),
      { paused: { reason: 'No payer.', models: undefined } }
    );
    expect(status.kind).toBe('not-benchmarked');
    expect(status.label).not.toContain('Paused');
  });

  it('covers a large paused pool without loading its case pages', () => {
    const models = Array.from({ length: 40 }, (_unused, index) => `vendor/model-${index}`);
    const info = pausedRequestInfo(pausedProgress(models, 'more-cases'));
    const rows = models.map(model =>
      entry({
        key: `gateway:${model}`,
        entry: { kind: 'gateway', model },
        variants: [{ variant: null, status: 'missing', failureReason: null, linked: false }],
      })
    );
    expect(
      rows.filter(row => entryRoutingStatus(row, { paused: info }).kind === 'paused')
    ).toHaveLength(models.length);
  });
});

describe('hasUnsettledEntries', () => {
  it('polls while a row can flip after another pool publishes', () => {
    const router = {
      entries: [
        entry({
          variants: [{ variant: null, status: 'missing', failureReason: null, linked: false }],
        }),
      ],
    } as Parameters<typeof hasUnsettledEntries>[0][number];
    expect(hasUnsettledEntries([router])).toBe(true);
  });

  it('stops polling once every row has settled', () => {
    const router = {
      entries: [entry()],
    } as Parameters<typeof hasUnsettledEntries>[0][number];
    expect(hasUnsettledEntries([router])).toBe(false);
  });
});
