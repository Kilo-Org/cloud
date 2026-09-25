const mockSweepLog = jest.fn();
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => mockSweepLog) }));

import { describe, expect, it } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  MAX_SCOPE_DECISIONS_PER_RUN,
  SCOPE_BATCH_SIZE,
  LOOKBACK_HOURS,
  createSpendAlertSweepStore,
  evaluateScope,
  runSpendAlertSweep,
  sweepHourlyBuckets,
  type SpendAlertDeliveryDraft,
  type SpendAlertEvaluation,
  type SpendAlertRuleSnapshot,
  type SpendAlertScopeSnapshot,
  type SpendAlertSweepStore,
} from './sweep';

const SCOPE_KEY = 'user:owner-1';
const THRESHOLD_RULE_ID = 'rule-threshold';
const ANOMALY_RULE_ID = 'rule-anomaly';
const NOW = new Date('2026-09-16T16:32:00.000Z');
/** The hour bucket `NOW` falls in; the dedupe key is anchored to it. */
const NOW_HOUR = '2026-09-16T16:00:00.000Z';

const HOUR_MS = 60 * 60 * 1000;

function thresholdRule(overrides: Partial<SpendAlertRuleSnapshot> = {}): SpendAlertRuleSnapshot {
  return {
    ruleId: THRESHOLD_RULE_ID,
    kind: 'threshold',
    enabled: true,
    thresholdMicrodollars: 5_000_000,
    windowHours: 24,
    multiplierBasisPoints: null,
    emailEnabled: true,
    pushEnabled: false,
    firing: false,
    conditionStartedAt: null,
    lastValueMicrodollars: null,
    ...overrides,
  };
}

function anomalyRule(overrides: Partial<SpendAlertRuleSnapshot> = {}): SpendAlertRuleSnapshot {
  return {
    ruleId: ANOMALY_RULE_ID,
    kind: 'anomaly',
    enabled: true,
    thresholdMicrodollars: null,
    windowHours: null,
    multiplierBasisPoints: 300,
    emailEnabled: true,
    pushEnabled: false,
    firing: false,
    conditionStartedAt: null,
    lastValueMicrodollars: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SpendAlertScopeSnapshot> = {}): SpendAlertScopeSnapshot {
  return {
    scopeKey: SCOPE_KEY,
    enabled: true,
    rules: [],
    windowMicrodollars: {},
    currentHourMicrodollars: 0,
    baselineHourlyMicrodollars: null,
    ...overrides,
  };
}

/** A store that answers one fixed snapshot for every scope it is asked about. */
function stubStore(value: SpendAlertScopeSnapshot | null): SpendAlertSweepStore {
  return {
    loadScopeSnapshots: async scopeKeys =>
      value === null ? new Map() : new Map(scopeKeys.map(scopeKey => [scopeKey, value])),
  };
}

/** A store whose snapshot follows the rule state a sweep would have written. */
function lifecycleStore(options: {
  rule: SpendAlertRuleSnapshot;
  windowMicrodollars: Record<number, number>;
}) {
  const state = {
    firing: options.rule.firing,
    conditionStartedAt: options.rule.conditionStartedAt,
    lastValueMicrodollars: options.rule.lastValueMicrodollars,
  };
  const value = { windowMicrodollars: options.windowMicrodollars };

  const store: SpendAlertSweepStore = {
    loadScopeSnapshots: async scopeKeys =>
      new Map(
        scopeKeys.map(scopeKey => [
          scopeKey,
          snapshot({
            scopeKey,
            rules: [
              {
                ...options.rule,
                firing: state.firing,
                conditionStartedAt: state.conditionStartedAt,
                lastValueMicrodollars: state.lastValueMicrodollars,
              },
            ],
            windowMicrodollars: value.windowMicrodollars,
          }),
        ])
      ),
  };

  return {
    store,
    setWindowMicrodollars(next: Record<number, number>) {
      value.windowMicrodollars = next;
    },
    apply(evaluation: SpendAlertEvaluation) {
      for (const transition of evaluation.transitions) {
        state.firing = transition.action === 'fire';
        state.conditionStartedAt = transition.conditionStartedAt;
        state.lastValueMicrodollars = transition.lastValueMicrodollars;
      }
    },
  };
}

describe('evaluateScope decisions', () => {
  type DecisionCase = {
    name: string;
    snapshot: SpendAlertScopeSnapshot;
    expected: { action: 'fire' | 'clear' | 'none'; deliveries: number };
  };

  const cases: DecisionCase[] = [
    {
      name: 'fires when the rolling spend reaches the threshold',
      snapshot: snapshot({
        rules: [thresholdRule()],
        windowMicrodollars: { 24: 5_000_000 },
      }),
      expected: { action: 'fire', deliveries: 1 },
    },
    {
      name: 'stays quiet below the threshold',
      snapshot: snapshot({
        rules: [thresholdRule()],
        windowMicrodollars: { 24: 4_999_999 },
      }),
      expected: { action: 'none', deliveries: 0 },
    },
    {
      name: 'does not fire again while the rule is firing',
      snapshot: snapshot({
        rules: [thresholdRule({ firing: true, conditionStartedAt: '2026-09-16T12:00:00.000Z' })],
        windowMicrodollars: { 24: 9_000_000 },
      }),
      expected: { action: 'none', deliveries: 0 },
    },
    {
      name: 'keeps firing just above the hysteresis band',
      snapshot: snapshot({
        rules: [thresholdRule({ firing: true, conditionStartedAt: '2026-09-16T12:00:00.000Z' })],
        windowMicrodollars: { 24: Math.ceil(5_000_000 * 0.95) },
      }),
      expected: { action: 'none', deliveries: 0 },
    },
    {
      name: 'clears below the hysteresis band',
      snapshot: snapshot({
        rules: [thresholdRule({ firing: true, conditionStartedAt: '2026-09-16T12:00:00.000Z' })],
        windowMicrodollars: { 24: Math.ceil(5_000_000 * 0.95) - 1 },
      }),
      expected: { action: 'clear', deliveries: 0 },
    },
    {
      name: 'clears a firing rule when the feature is off',
      snapshot: snapshot({
        enabled: false,
        rules: [thresholdRule({ firing: true, conditionStartedAt: '2026-09-16T12:00:00.000Z' })],
        windowMicrodollars: { 24: 9_000_000 },
      }),
      expected: { action: 'clear', deliveries: 0 },
    },
    {
      name: 'clears a firing rule that was turned off',
      snapshot: snapshot({
        rules: [
          thresholdRule({
            enabled: false,
            firing: true,
            conditionStartedAt: '2026-09-16T12:00:00.000Z',
          }),
        ],
        windowMicrodollars: { 24: 9_000_000 },
      }),
      expected: { action: 'clear', deliveries: 0 },
    },
    {
      name: 'clears a firing rule that lost its threshold',
      snapshot: snapshot({
        rules: [
          thresholdRule({
            thresholdMicrodollars: null,
            firing: true,
            conditionStartedAt: '2026-09-16T12:00:00.000Z',
          }),
        ],
        windowMicrodollars: { 24: 9_000_000 },
      }),
      expected: { action: 'clear', deliveries: 0 },
    },
    {
      name: 'keeps the anomaly quiet below the 24-bucket baseline floor',
      snapshot: snapshot({
        rules: [anomalyRule()],
        currentHourMicrodollars: 9_000_000,
        baselineHourlyMicrodollars: null,
      }),
      expected: { action: 'none', deliveries: 0 },
    },
    {
      name: 'clears a firing anomaly whose baseline is no longer available',
      snapshot: snapshot({
        rules: [anomalyRule({ firing: true, conditionStartedAt: '2026-09-16T12:00:00.000Z' })],
        currentHourMicrodollars: 9_000_000,
        baselineHourlyMicrodollars: null,
      }),
      expected: { action: 'clear', deliveries: 0 },
    },
    {
      name: 'fires the anomaly when the hour exceeds the baseline times the multiplier',
      snapshot: snapshot({
        rules: [anomalyRule()],
        currentHourMicrodollars: 3_000_001,
        baselineHourlyMicrodollars: 1_000_000,
      }),
      expected: { action: 'fire', deliveries: 1 },
    },
    {
      name: 'keeps the anomaly quiet at exactly the multiplier',
      snapshot: snapshot({
        rules: [anomalyRule()],
        currentHourMicrodollars: 3_000_000,
        baselineHourlyMicrodollars: 1_000_000,
      }),
      expected: { action: 'none', deliveries: 0 },
    },
    {
      name: 'clears a firing anomaly below the hysteresis band',
      snapshot: snapshot({
        rules: [anomalyRule({ firing: true, conditionStartedAt: '2026-09-16T12:00:00.000Z' })],
        currentHourMicrodollars: Math.ceil(3_000_000 * 0.95) - 1,
        baselineHourlyMicrodollars: 1_000_000,
      }),
      expected: { action: 'clear', deliveries: 0 },
    },
  ];

  it.each(cases)('$name', async testCase => {
    const evaluation = await evaluateScope(stubStore(testCase.snapshot), SCOPE_KEY, NOW);

    expect(evaluation.deliveries).toHaveLength(testCase.expected.deliveries);
    if (testCase.expected.action === 'none') {
      expect(evaluation.transitions).toEqual([]);
      return;
    }
    expect(evaluation.transitions).toHaveLength(1);
    expect(evaluation.transitions[0].action).toBe(testCase.expected.action);
  });

  it('returns nothing for a scope that never saved settings', async () => {
    const evaluation = await evaluateScope(stubStore(null), SCOPE_KEY, NOW);
    expect(evaluation).toEqual({ scopeKey: SCOPE_KEY, transitions: [], deliveries: [] });
  });

  it('decides both rules of a scope independently', async () => {
    const evaluation = await evaluateScope(
      stubStore(
        snapshot({
          rules: [thresholdRule({ pushEnabled: true }), anomalyRule({ emailEnabled: false })],
          windowMicrodollars: { 24: 5_000_000 },
          currentHourMicrodollars: 4_000_000,
          baselineHourlyMicrodollars: 1_000_000,
        })
      ),
      SCOPE_KEY,
      NOW
    );

    expect(evaluation.transitions.map(transition => transition.kind)).toEqual([
      'threshold',
      'anomaly',
    ]);
    expect(evaluation.deliveries.map(delivery => delivery.channel)).toEqual(['email', 'push']);
  });
});

describe('delivery rows', () => {
  it('enqueues one row per enabled channel, named by scope, kind, channel and hour', async () => {
    const evaluation = await evaluateScope(
      stubStore(
        snapshot({
          rules: [thresholdRule({ pushEnabled: true, windowHours: 168 })],
          windowMicrodollars: { 168: 5_000_000 },
        })
      ),
      SCOPE_KEY,
      NOW
    );

    expect(evaluation.deliveries).toHaveLength(2);
    expect(evaluation.deliveries.map(delivery => delivery.channel)).toEqual(['email', 'push']);
    for (const delivery of evaluation.deliveries) {
      expect(delivery.scopeKey).toBe(SCOPE_KEY);
      expect(delivery.ruleId).toBe(THRESHOLD_RULE_ID);
      expect(delivery.kind).toBe('threshold');
      expect(delivery.firedAt).toBe(NOW.toISOString());
      expect(delivery.dedupeKey).toContain(
        `${SCOPE_KEY}:threshold:${delivery.channel}:${NOW_HOUR}`
      );
      expect(delivery.payload).toEqual({
        valueMicrodollars: 5_000_000,
        thresholdMicrodollars: 5_000_000,
        windowHours: 168,
        multiplierBasisPoints: null,
        baselineHourlyMicrodollars: null,
      });
    }
    expect(evaluation.deliveries[0].dedupeKey).not.toBe(evaluation.deliveries[1].dedupeKey);
  });

  it('enqueues nothing when neither channel is enabled', async () => {
    const evaluation = await evaluateScope(
      stubStore(
        snapshot({
          rules: [thresholdRule({ emailEnabled: false, pushEnabled: false })],
          windowMicrodollars: { 24: 5_000_000 },
        })
      ),
      SCOPE_KEY,
      NOW
    );

    expect(evaluation.transitions).toHaveLength(1);
    expect(evaluation.transitions[0].action).toBe('fire');
    expect(evaluation.deliveries).toEqual([]);
  });

  it('enqueues one delivery per channel when two concurrent sweeps decide the same hour', async () => {
    const store = stubStore(
      snapshot({
        rules: [thresholdRule({ pushEnabled: true })],
        windowMicrodollars: { 24: 9_000_000 },
      })
    );

    const [first, second] = await Promise.all([
      evaluateScope(store, SCOPE_KEY, NOW),
      evaluateScope(store, SCOPE_KEY, NOW),
    ]);

    // The unique index on `dedupe_key` collapses the two sweeps onto one row
    // per channel; the sink below is that index.
    const sink = new Map<string, SpendAlertDeliveryDraft>();
    for (const delivery of [...first.deliveries, ...second.deliveries]) {
      sink.set(delivery.dedupeKey, delivery);
    }

    expect(first.deliveries).toHaveLength(2);
    expect(second.deliveries).toHaveLength(2);
    expect(sink.size).toBe(2);
    expect(first.deliveries.map(delivery => delivery.dedupeKey)).toEqual(
      second.deliveries.map(delivery => delivery.dedupeKey)
    );
  });
});

describe('one alert per crossing', () => {
  it('fires once, stays quiet while firing, then fires again with a new dedupe key', async () => {
    const lifecycle = lifecycleStore({
      rule: thresholdRule(),
      windowMicrodollars: { 24: 6_000_000 },
    });

    const crossing = await evaluateScope(lifecycle.store, SCOPE_KEY, NOW);
    expect(crossing.transitions.map(transition => transition.action)).toEqual(['fire']);
    expect(crossing.transitions[0].conditionStartedAt).toBe(NOW.toISOString());
    const firstKeys = crossing.deliveries.map(delivery => delivery.dedupeKey);
    expect(firstKeys).toHaveLength(1);
    lifecycle.apply(crossing);

    // Still over the threshold, still firing: nothing fires again.
    const repeated = await evaluateScope(lifecycle.store, SCOPE_KEY, NOW);
    expect(repeated).toEqual({ scopeKey: SCOPE_KEY, transitions: [], deliveries: [] });
    lifecycle.apply(repeated);

    // The window decays below the hysteresis band: the rule goes back to armed.
    lifecycle.setWindowMicrodollars({ 24: 3_000_000 });
    const cleared = await evaluateScope(lifecycle.store, SCOPE_KEY, NOW);
    expect(cleared.transitions.map(transition => transition.action)).toEqual(['clear']);
    expect(cleared.deliveries).toEqual([]);
    expect(cleared.transitions[0].conditionStartedAt).toBe(NOW.toISOString());
    lifecycle.apply(cleared);

    // Crossing again in the same hour is a new episode, so a new key.
    lifecycle.setWindowMicrodollars({ 24: 6_000_000 });
    const recrossed = await evaluateScope(lifecycle.store, SCOPE_KEY, NOW);
    expect(recrossed.transitions.map(transition => transition.action)).toEqual(['fire']);
    expect(recrossed.deliveries).toHaveLength(1);
    expect(recrossed.deliveries[0].dedupeKey).not.toBe(firstKeys[0]);
  });

  it('clears a scope that went quiet: the re-arm pass sees the decayed window', async () => {
    const lifecycle = lifecycleStore({
      rule: anomalyRule({ firing: true, conditionStartedAt: '2026-09-16T12:00:00.000Z' }),
      windowMicrodollars: {},
    });

    const evaluation = await evaluateScope(
      lifecycle.store,
      SCOPE_KEY,
      new Date('2026-09-16T20:00:00.000Z')
    );
    expect(evaluation.transitions).toEqual([
      {
        action: 'clear',
        ruleId: ANOMALY_RULE_ID,
        kind: 'anomaly',
        conditionStartedAt: '2026-09-16T12:00:00.000Z',
        lastValueMicrodollars: null,
      },
    ]);
    expect(evaluation.deliveries).toEqual([]);
  });
});

describe('runSpendAlertSweep candidate set and batching', () => {
  type SweepDb = Parameters<typeof runSpendAlertSweep>[0];
  type FiringRuleRow = { ruleId: string; scopeKey: string };
  type RollupRow = { scope_key: string; changed: boolean };

  /** A store that records the batch of keys each decision read asked for. */
  function recordingStore(): { store: SpendAlertSweepStore; requestedBatches: string[][] } {
    const requestedBatches: string[][] = [];
    const store: SpendAlertSweepStore = {
      loadScopeSnapshots: async scopeKeys => {
        requestedBatches.push([...scopeKeys]);
        return new Map();
      },
    };
    return { store, requestedBatches };
  }

  /** The keys a store's batches asked to decide, in order. */
  function decidedKeys(requestedBatches: string[][]): string[] {
    return requestedBatches.flat();
  }

  /**
   * A database whose reads are the rollup (`rollupRows`), the firing-rule pages
   * and nothing else. `makePage` builds each page from the limit the walk
   * actually asked for, so the test does not hard-code the walk's page size.
   */
  function pagedFiringDatabase(
    makePage: (size: number, call: number) => FiringRuleRow[],
    rollupRows: RollupRow[] = []
  ): { database: SweepDb; requestedLimits: number[] } {
    const requestedLimits: number[] = [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: (size: number) => {
        const call = requestedLimits.length;
        requestedLimits.push(size);
        return Promise.resolve(makePage(size, call));
      },
    };
    const database = {
      execute: async () => ({ rows: rollupRows }),
      select: () => chain,
    } as unknown as SweepDb;
    return { database, requestedLimits };
  }

  function scopeKeys(count: number, prefix: string): string[] {
    return Array.from(
      { length: count },
      (_, index) => `${prefix}-${String(index).padStart(5, '0')}`
    );
  }

  /**
   * The rollup's rows for a set of scopes: every one of them re-derived, and —
   * unless `rewritten` says otherwise — every one of them rewritten by the
   * guarded upsert.
   */
  function rollupRows(
    keys: string[],
    rewritten: (key: string) => boolean = () => true
  ): RollupRow[] {
    return keys.map(scope_key => ({ scope_key, changed: rewritten(scope_key) }));
  }

  it('re-arms every firing scope across keyset pages, not only the first page', async () => {
    let firstPage: FiringRuleRow[] = [];
    const tail: FiringRuleRow[] = [
      { ruleId: 'rule-z1', scopeKey: 'user:zzz-1' },
      { ruleId: 'rule-z2', scopeKey: 'user:zzz-2' },
    ];
    const { database, requestedLimits } = pagedFiringDatabase((size, call) => {
      if (call === 0) {
        firstPage = Array.from({ length: size }, (_, index) => ({
          ruleId: `rule-p1-${String(index).padStart(4, '0')}`,
          scopeKey: `user:p1-${String(index).padStart(4, '0')}`,
        }));
        return firstPage;
      }
      if (call === 1) return tail;
      return [];
    });
    const { store, requestedBatches } = recordingStore();

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    // The first page is full at the walk's own size, so a fixed single-page read
    // would stop here; the tail proves the walk continued past it.
    expect(requestedLimits.length).toBeGreaterThan(1);
    expect(firstPage.length).toBe(requestedLimits[0]);
    const decided = decidedKeys(requestedBatches);
    expect(decided).toHaveLength(firstPage.length + tail.length);
    expect(new Set(decided)).toEqual(
      new Set([...firstPage.map(rule => rule.scopeKey), ...tail.map(rule => rule.scopeKey)])
    );
    expect(result.candidateScopes).toBe(firstPage.length + tail.length);
  });

  it("collapses a scope's two firing rules and the rollup delta into one decision", async () => {
    // The same scope arrives once through the rollup delta and again twice
    // through the firing read; it must be decided once, not three times.
    const sameScope: FiringRuleRow[] = [
      { ruleId: 'rule-a', scopeKey: 'user:owner-1' },
      { ruleId: 'rule-b', scopeKey: 'user:owner-1' },
    ];
    const { database } = pagedFiringDatabase(
      (_size, call) => (call === 0 ? sameScope : []),
      rollupRows(['user:owner-1'])
    );
    const { store, requestedBatches } = recordingStore();

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    expect(decidedKeys(requestedBatches)).toEqual(['user:owner-1']);
    expect(result.candidateScopes).toBe(1);
  });

  it('decides a batch per chunk of scope keys, not a round trip per scope', async () => {
    const deltaCount = SCOPE_BATCH_SIZE * 2 + 17;
    const delta = scopeKeys(deltaCount, 'user:batch');
    const { database } = pagedFiringDatabase(() => [], rollupRows(delta));
    const { store, requestedBatches } = recordingStore();

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    expect(result.candidateScopes).toBe(deltaCount);
    expect(requestedBatches).toHaveLength(3);
    expect(requestedBatches.map(batch => batch.length)).toEqual([
      SCOPE_BATCH_SIZE,
      SCOPE_BATCH_SIZE,
      17,
    ]);
    // Ranges are disjoint: no scope is decided twice.
    expect(new Set(decidedKeys(requestedBatches)).size).toBe(deltaCount);
  });

  it('caps the run, reports the deferred remainder and keeps the delta first', async () => {
    const delta = scopeKeys(MAX_SCOPE_DECISIONS_PER_RUN + 25, 'user:cap');
    const { database } = pagedFiringDatabase(() => [], rollupRows(delta));
    const { store, requestedBatches } = recordingStore();

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    expect(result.candidateScopes).toBe(MAX_SCOPE_DECISIONS_PER_RUN);
    expect(result.timings?.deferredScopes).toBe(25);
    expect(requestedBatches).toHaveLength(MAX_SCOPE_DECISIONS_PER_RUN / SCOPE_BATCH_SIZE);
    const decided = decidedKeys(requestedBatches);
    const deltaSet = new Set(delta);
    // Every decided scope is one whose bucket moved, decided once: the cap may
    // not spend a slot on a re-derived scope while a delta scope is waiting, and
    // the rotation must not repeat a scope inside one tick.
    expect(decided).toHaveLength(MAX_SCOPE_DECISIONS_PER_RUN);
    expect(new Set(decided).size).toBe(MAX_SCOPE_DECISIONS_PER_RUN);
    expect(decided.every(key => deltaSet.has(key))).toBe(true);
  });

  it('decides every rewritten scope before it defers a re-derived one', async () => {
    // The rollup re-derived 6,000 scopes but rewrote only the last 3,820 of them
    // — the delta is deliberately behind the re-derived set in scope-key order.
    mockSweepLog.mockClear();
    const all = scopeKeys(6000, 'user:mix');
    const rewritten = new Set(all.slice(-3820));
    const { database } = pagedFiringDatabase(
      () => [],
      rollupRows(all, key => rewritten.has(key))
    );
    const { store, requestedBatches } = recordingStore();

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    const decided = decidedKeys(requestedBatches);
    expect(decided).toHaveLength(MAX_SCOPE_DECISIONS_PER_RUN);
    // Every scope whose bucket moved has something new to decide, so the cap
    // must not be what defers one of them.
    expect(decided.filter(key => rewritten.has(key))).toHaveLength(rewritten.size);
    // What the cap deferred is only re-derived scopes with nothing new to decide.
    expect(result.timings?.deferredScopes).toBe(all.length - decided.length);
    expect(result.sweptScopes).toBe(rewritten.size);
    expect(mockSweepLog).toHaveBeenCalledWith(
      'Spend alert sweep phases completed',
      expect.objectContaining({ rederivedScopes: all.length })
    );
  });

  it('still decides the delta when the re-derived remainder would consume the cap', async () => {
    // ceil(89_983 / 18) = 5000, the whole cap. Without a remainder-floor bound
    // the 100 scopes whose buckets moved would get zero slots every tick.
    const remainder = scopeKeys(89_983, 'user:rest');
    const delta = scopeKeys(100, 'user:delta');
    const all = [...remainder, ...delta];
    const rewritten = new Set(delta);
    const { database } = pagedFiringDatabase(
      () => [],
      rollupRows(all, key => rewritten.has(key))
    );
    const { store, requestedBatches } = recordingStore();

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    const decided = decidedKeys(requestedBatches);
    expect(decided.filter(key => rewritten.has(key))).toEqual(delta);
    expect(result.candidateScopes).toBe(MAX_SCOPE_DECISIONS_PER_RUN);
    expect(result.sweptScopes).toBe(delta.length);
    expect(result.timings?.deferredScopes).toBe(all.length - MAX_SCOPE_DECISIONS_PER_RUN);
  });

  it('warns when the remainder cannot be rotated inside the rollup window', async () => {
    // The floor is capped at MAX_REMAINDER_FLOOR while the required set has
    // work, so a remainder larger than that cap times the window's ticks cannot
    // be walked before its scopes stop being re-derived. The run must report the
    // shortfall rather than defer those scopes silently.
    const delta = scopeKeys(2_500, 'user:delta');
    const rewritten = new Set(delta);

    mockSweepLog.mockClear();
    const fits = pagedFiringDatabase(
      () => [],
      rollupRows([...scopeKeys(90_000, 'user:rest'), ...delta], key => rewritten.has(key))
    );
    await runSpendAlertSweep(fits.database, { store: recordingStore().store }, { now: NOW });
    expect(mockSweepLog).not.toHaveBeenCalledWith(
      'Spend alert sweep remainder outgrew the rollup window',
      expect.anything()
    );

    mockSweepLog.mockClear();
    const overflows = pagedFiringDatabase(
      () => [],
      rollupRows([...scopeKeys(92_500, 'user:rest'), ...delta], key => rewritten.has(key))
    );
    await runSpendAlertSweep(overflows.database, { store: recordingStore().store }, { now: NOW });
    expect(mockSweepLog).toHaveBeenCalledWith(
      'Spend alert sweep remainder outgrew the rollup window',
      expect.objectContaining({
        rederivedScopes: 92_500,
        remainderSlots: 2_500,
        remainderTicks: 37,
        rollupWindowTicks: 36,
      })
    );
  });

  it('still re-arms a firing scope when the re-derived remainder would consume the cap', async () => {
    const remainder = scopeKeys(89_983, 'user:rest');
    const firing: FiringRuleRow[] = [{ ruleId: 'rule-fire', scopeKey: 'user:firing' }];
    const { database } = pagedFiringDatabase(
      (_size, call) => (call === 0 ? firing : []),
      rollupRows(remainder, () => false)
    );
    const { store, requestedBatches } = recordingStore();

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    const decided = decidedKeys(requestedBatches);
    expect(decided[0]).toBe('user:firing');
    expect(result.candidateScopes).toBe(MAX_SCOPE_DECISIONS_PER_RUN);
  });

  it('re-decides the scopes the cap deferred without their bucket changing again', async () => {
    // Tick one rewrites every one of 5,025 scopes: the cap defers 25 of them.
    const all = scopeKeys(MAX_SCOPE_DECISIONS_PER_RUN + 25, 'user:defer');
    const { store, requestedBatches } = recordingStore();

    const first = pagedFiringDatabase(() => [], rollupRows(all));
    await runSpendAlertSweep(first.database, { store }, { now: NOW });

    const decided = new Set(decidedKeys(requestedBatches));
    expect(decided.size).toBe(MAX_SCOPE_DECISIONS_PER_RUN);
    const deferred = all.filter(key => !decided.has(key));
    expect(deferred).toHaveLength(25);

    // Those buckets were rewritten, so no later tick names them as the delta
    // again — the rollup only re-derives them. They must still be decided, or a
    // scope that stops spending is silently dropped.
    for (const minutes of [5, 10, 15]) {
      const next = pagedFiringDatabase(
        () => [],
        rollupRows(all, () => false)
      );
      await runSpendAlertSweep(
        next.database,
        { store },
        {
          now: new Date(NOW.getTime() + minutes * 60 * 1000),
        }
      );
      for (const key of decidedKeys(requestedBatches)) decided.add(key);
    }

    for (const key of deferred) expect(decided.has(key)).toBe(true);
    expect(decided.size).toBe(all.length);
  });

  it('reaches every re-derived scope within a bounded number of ticks when the delta fills the cap', async () => {
    // The delta alone is at the cap, so the run can spend only the rotation slots
    // it reserves on the rest of the re-derived set. That reserved window has to
    // advance every tick, or a scope the cap deferred from the delta would starve
    // while its usage stays inside the rollup window.
    const all = scopeKeys(MAX_SCOPE_DECISIONS_PER_RUN * 2, 'user:rotate');
    const changed = new Set(all.slice(0, MAX_SCOPE_DECISIONS_PER_RUN));
    const { store, requestedBatches } = recordingStore();
    const decided = new Set<string>();

    for (let tick = 0; tick < 40; tick += 1) {
      const { database } = pagedFiringDatabase(
        () => [],
        rollupRows(all, key => changed.has(key))
      );
      await runSpendAlertSweep(
        database,
        { store },
        {
          now: new Date(NOW.getTime() + tick * 5 * 60 * 1000),
        }
      );
      for (const key of decidedKeys(requestedBatches)) decided.add(key);
      requestedBatches.length = 0;
    }

    expect(decided.size).toBe(all.length);
  });

  it('rotates the required set so a scope whose bucket keeps changing is not starved', async () => {
    // An actively spending scope's current-hour bucket grows on every rollup, so
    // it is in the delta on every tick. A run that always decided the head of the
    // delta would never reach its tail while the delta outgrows the cap.
    const all = scopeKeys(MAX_SCOPE_DECISIONS_PER_RUN + 400, 'user:busy');
    const { store, requestedBatches } = recordingStore();
    const decided = new Set<string>();

    for (let tick = 0; tick < 40; tick += 1) {
      const { database } = pagedFiringDatabase(() => [], rollupRows(all));
      await runSpendAlertSweep(
        database,
        { store },
        {
          now: new Date(NOW.getTime() + tick * 5 * 60 * 1000),
        }
      );
      for (const key of decidedKeys(requestedBatches)) decided.add(key);
      requestedBatches.length = 0;
    }

    expect(decided.size).toBe(all.length);
  });

  it('reports phase timings and logs them from inside the sweep', async () => {
    mockSweepLog.mockClear();
    const { database } = pagedFiringDatabase(() => []);
    const { store } = recordingStore();

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    expect(result.timings).toEqual({
      rollupMs: expect.any(Number),
      decisionMs: expect.any(Number),
      rearmMs: expect.any(Number),
      deferredScopes: 0,
    });
    expect(mockSweepLog).toHaveBeenCalledWith(
      'Spend alert sweep phases completed',
      expect.objectContaining({
        sweptScopes: 0,
        rederivedScopes: 0,
        candidateScopes: 0,
        timings: expect.objectContaining({ deferredScopes: 0 }),
      })
    );
  });
});

describe('sweepHourlyBuckets window', () => {
  type SweepDb = Parameters<typeof sweepHourlyBuckets>[0];

  /** Captures the one statement the rollup executes, so its window can be asserted without a database. */
  function captureRollup(): { database: SweepDb; statements: unknown[] } {
    const statements: unknown[] = [];
    const database = {
      execute: async (statement: unknown) => {
        statements.push(statement);
        return { rows: [] };
      },
    } as unknown as SweepDb;
    return { database, statements };
  }

  /** The SQL text and ordered parameters drizzle would send for a captured statement. */
  function rendered(statement: unknown): { sql: string; params: unknown[] } {
    return new PgDialect().sqlToQuery(statement as SQL);
  }

  /** Every `Date` interpolated into a drizzle statement, in chunk order. */
  function dateParams(statement: unknown): Date[] {
    const found: Date[] = [];
    const visit = (chunk: unknown): void => {
      if (chunk instanceof Date) {
        found.push(chunk);
        return;
      }
      if (chunk === null || typeof chunk !== 'object') return;
      if (Array.isArray(chunk)) {
        for (const item of chunk) visit(item);
        return;
      }
      const container = chunk as { queryChunks?: unknown; value?: unknown };
      if (container.queryChunks !== undefined) visit(container.queryChunks);
      if (container.value !== undefined) visit(container.value);
    };
    visit(statement);
    return found;
  }

  type WindowCase = {
    name: string;
    now: string;
    lookbackHours?: number;
    /** Start of the hour the range scan must begin at. */
    expectedFrom: string;
  };

  const cases: WindowCase[] = [
    {
      name: 'starts the scan on the hour boundary that contains now minus the default lookback',
      now: '2026-09-16T16:32:00.000Z',
      expectedFrom: '2026-09-16T13:00:00.000Z',
    },
    {
      name: 'starts at the boundary itself when now sits exactly on it',
      now: '2026-09-16T16:00:00.000Z',
      expectedFrom: '2026-09-16T13:00:00.000Z',
    },
    {
      name: 'floors one minute past the boundary down to the same hour',
      now: '2026-09-16T16:01:00.000Z',
      expectedFrom: '2026-09-16T13:00:00.000Z',
    },
    {
      name: 'floors one minute before the boundary down to the earlier hour',
      now: '2026-09-16T15:59:00.000Z',
      expectedFrom: '2026-09-16T12:00:00.000Z',
    },
    {
      name: 'floors across midnight UTC',
      now: '2026-09-17T01:05:00.000Z',
      expectedFrom: '2026-09-16T22:00:00.000Z',
    },
    {
      name: 'floors an explicit multi-day lookback',
      now: '2026-09-16T16:32:00.000Z',
      lookbackHours: 24,
      expectedFrom: '2026-09-15T16:00:00.000Z',
    },
  ];

  it.each(cases)('$name', async testCase => {
    const now = new Date(testCase.now);
    const lookbackHours = testCase.lookbackHours ?? LOOKBACK_HOURS;
    const { database, statements } = captureRollup();

    await sweepHourlyBuckets(database, {
      now,
      ...(testCase.lookbackHours === undefined ? {} : { lookbackHours: testCase.lookbackHours }),
    });

    expect(statements).toHaveLength(1);
    const [from] = dateParams(statements[0]);
    expect(from).toBeInstanceOf(Date);

    // The oldest bucket in range is the one that contains `now - lookbackHours`,
    // and the scan starts at that bucket's start. The rollup writes each bucket
    // back wholesale, so this is what keeps that bucket's stored cost the sum of
    // every row in its own hour instead of the tail of the hour.
    expect(from.getTime()).toBe(new Date(testCase.expectedFrom).getTime());
    expect(from.getTime() % HOUR_MS).toBe(0);
    expect(now.getTime() - from.getTime()).toBeGreaterThanOrEqual(lookbackHours * HOUR_MS);
    expect(now.getTime() - from.getTime()).toBeLessThan((lookbackHours + 1) * HOUR_MS);
  });

  it('starts the scan at the start of the hour, not at the raw lookback instant', async () => {
    const now = new Date('2026-09-16T16:32:00.000Z');
    const { database, statements } = captureRollup();

    await sweepHourlyBuckets(database, { now });

    const [from] = dateParams(statements[0]);
    const rawInstant = new Date(now.getTime() - LOOKBACK_HOURS * HOUR_MS);
    expect(rawInstant.toISOString()).toBe('2026-09-16T13:32:00.000Z');
    expect(from.toISOString()).not.toBe(rawInstant.toISOString());
    expect(from.toISOString()).toBe('2026-09-16T13:00:00.000Z');
  });

  it('stops the scan at now and rewrites only a bucket whose sum changed', async () => {
    const now = new Date('2026-09-16T16:32:00.000Z');
    const { database, statements } = captureRollup();

    await sweepHourlyBuckets(database, { now });

    const { sql: text, params } = rendered(statements[0]);
    // A sender-supplied `created_at` can sit ahead of our clock; a future-dated
    // row must not create a bucket for an hour that has not started. The scan is
    // bounded above by the run's own `now`, the last bound parameter.
    expect(text).toContain('"microdollar_usage"."created_at" <= $2');
    expect(params.at(-1)).toBe(now);

    // The guard keeps a bucket whose sum did not move from being rewritten. It
    // narrows the write only: the re-derived set the run decides from comes from
    // the aggregate, so a scope the guard skipped is still a candidate.
    expect(text).toContain('IS DISTINCT FROM EXCLUDED.cost_microdollars');
  });

  it('returns every re-derived scope, with whether its bucket was rewritten', async () => {
    const rows = [
      { scope_key: 'user:changed', changed: true },
      { scope_key: 'user:unchanged', changed: false },
    ];
    const database = {
      execute: async () => ({ rows }),
    } as unknown as SweepDb;

    const rollup = await sweepHourlyBuckets(database, {
      now: new Date('2026-09-16T16:32:00.000Z'),
    });

    // The unchanged scope stays in the candidate reservoir — that is what lets
    // the run defer it and still decide it on a later tick.
    expect(rollup.scopeKeys).toEqual(['user:changed', 'user:unchanged']);
    expect(rollup.changedScopeKeys).toEqual(['user:changed']);
  });
});

describe('createSpendAlertSweepStore batched reads', () => {
  type StoreDb = Parameters<typeof createSpendAlertSweepStore>[0];

  /** The shape the settings+rules+state select maps one rule row from. */
  function ruleRow(scopeKey: string, overrides: Record<string, unknown> = {}) {
    return {
      scopeKey,
      enabled: true,
      ruleId: `${scopeKey}-threshold`,
      kind: 'threshold',
      ruleEnabled: true,
      thresholdMicrodollars: 1_000_000,
      windowHours: 24,
      multiplierBasisPoints: null,
      emailEnabled: true,
      pushEnabled: false,
      firing: false,
      conditionStartedAt: null,
      lastValueMicrodollars: null,
      ...overrides,
    };
  }

  /** The shape the batched aggregate returns one row per scope from. */
  function totalsRow(scopeKey: string, overrides: Record<string, unknown> = {}) {
    return {
      scope_key: scopeKey,
      current_hour: 0,
      baseline_buckets: 0,
      baseline: null,
      window_24: 0,
      window_168: 0,
      window_720: 0,
      ...overrides,
    };
  }

  /**
   * A database whose only reads are the settings+rules+state select (answered
   * with `settingsRows`) and the aggregate `execute` (answered with
   * `totalsRows`). Both are recorded, so the test can assert the batch's read
   * count and the statements themselves.
   */
  function storeDatabase(
    settingsRows: Record<string, unknown>[],
    totalsRows: Record<string, unknown>[]
  ) {
    const statements: unknown[] = [];
    let selectCalls = 0;
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => Promise.resolve(settingsRows),
    };
    const database = {
      select: () => {
        selectCalls += 1;
        return chain;
      },
      execute: async (statement: unknown) => {
        statements.push(statement);
        return { rows: totalsRows };
      },
    } as unknown as StoreDb;
    return { database, statements, selectCalls: () => selectCalls };
  }

  it('serves a whole batch with two statements and picks the configured window', async () => {
    const database = storeDatabase(
      [
        ruleRow('user:a', { windowHours: 168 }),
        // A later rule row for the same scope shares the snapshot.
        ruleRow('user:a', {
          ruleId: 'user:a-state',
          windowHours: null,
          thresholdMicrodollars: null,
        }),
      ],
      [totalsRow('user:a', { window_24: 11, window_168: 42, window_720: 99 })]
    );
    const store = createSpendAlertSweepStore(database.database);

    const snapshots = await store.loadScopeSnapshots(['user:a', 'user:b', 'team:ignored'], NOW);

    expect(database.selectCalls()).toBe(1);
    expect(database.statements).toHaveLength(1);

    // A key with no settings row is absent; a key that names no scope is dropped
    // before it reaches the database.
    expect([...snapshots.keys()]).toEqual(['user:a']);
    const scope = snapshots.get('user:a');
    expect(scope?.windowMicrodollars).toEqual({ 168: 42 });
    expect(scope?.rules).toHaveLength(2);

    const { sql: text, params } = new PgDialect().sqlToQuery(database.statements[0] as SQL);
    // `scope_key` predicate, the precomputed per-window sums, and a lower bound
    // that is the longest window (720 h). The WHERE clause is rendered last, so
    // its `scope_key` array and `hour_start` bound are the last two parameters.
    expect(text).toContain('GROUP BY');
    expect(text).toContain('= ANY(');
    const lowerBound = params.at(-1);
    expect(params.at(-2)).toEqual(['user:a']);
    expect(lowerBound).toBeInstanceOf(Date);
    expect(NOW.getTime() - (lowerBound as Date).getTime()).toBe(720 * HOUR_MS);
    expect(text).toContain('"spend_alert_hourly"."hour_start" >= $');
  });

  it('issues no aggregate for a batch where no scope has settings', async () => {
    const database = storeDatabase([], []);
    const store = createSpendAlertSweepStore(database.database);

    const snapshots = await store.loadScopeSnapshots(['user:a', 'user:b'], NOW);

    expect(snapshots.size).toBe(0);
    expect(database.statements).toHaveLength(0);
  });

  it('does not read at all for a batch whose keys name no scope', async () => {
    const database = storeDatabase([ruleRow('user:a')], []);
    const store = createSpendAlertSweepStore(database.database);

    const snapshots = await store.loadScopeSnapshots(['team:1', 'nonsense'], NOW);

    expect(snapshots.size).toBe(0);
    expect(database.selectCalls()).toBe(0);
    expect(database.statements).toHaveLength(0);
  });

  it('trusts the p95 baseline only at the bucket floor and rounds it', async () => {
    const database = storeDatabase(
      [
        ruleRow('user:anomaly', {
          ruleId: 'user:anomaly-anomaly',
          kind: 'anomaly',
          windowHours: null,
          thresholdMicrodollars: null,
          multiplierBasisPoints: 300,
        }),
      ],
      [totalsRow('user:anomaly', { baseline_buckets: 30, baseline: '1234.6', current_hour: '17' })]
    );
    const store = createSpendAlertSweepStore(database.database);

    const snapshots = await store.loadScopeSnapshots(['user:anomaly'], NOW);
    const scope = snapshots.get('user:anomaly');

    expect(scope?.baselineHourlyMicrodollars).toBe(1235);
    expect(scope?.currentHourMicrodollars).toBe(17);
    // An anomaly rule configures no rolling window.
    expect(scope?.windowMicrodollars).toEqual({});
  });

  it('keeps the baseline null below the bucket floor', async () => {
    const database = storeDatabase(
      [
        ruleRow('user:anomaly', {
          ruleId: 'user:anomaly-anomaly',
          kind: 'anomaly',
          windowHours: null,
          thresholdMicrodollars: null,
          multiplierBasisPoints: 300,
        }),
      ],
      [totalsRow('user:anomaly', { baseline_buckets: 23, baseline: '1234.6' })]
    );
    const store = createSpendAlertSweepStore(database.database);

    const snapshots = await store.loadScopeSnapshots(['user:anomaly'], NOW);

    expect(snapshots.get('user:anomaly')?.baselineHourlyMicrodollars).toBeNull();
  });

  it('decides a settings row that has no rules instead of skipping it', async () => {
    const database = storeDatabase(
      [ruleRow('user:empty', { ruleId: null, kind: null })],
      [totalsRow('user:empty', { current_hour: 5 })]
    );
    const store = createSpendAlertSweepStore(database.database);

    const snapshots = await store.loadScopeSnapshots(['user:empty'], NOW);

    expect(snapshots.get('user:empty')).toMatchObject({
      scopeKey: 'user:empty',
      enabled: true,
      rules: [],
      currentHourMicrodollars: 5,
    });
  });
});
