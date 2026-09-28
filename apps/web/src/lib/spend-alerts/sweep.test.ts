import { describe, expect, it } from '@jest/globals';
import {
  LOOKBACK_HOURS,
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

function stubStore(value: SpendAlertScopeSnapshot | null): SpendAlertSweepStore {
  return { loadScopeSnapshot: async () => value };
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
    loadScopeSnapshot: async () =>
      snapshot({
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

describe('runSpendAlertSweep re-arm walk', () => {
  /**
   * A database whose only reads are the empty rollup and the firing-scope pages.
   * `makePage` builds each page from the limit the walk actually asked for, so
   * the test does not hard-code the walk's page size.
   */
  function pagedFiringDatabase(
    makePage: (size: number, call: number) => string[],
    delta: string[] = []
  ): {
    database: Parameters<typeof runSpendAlertSweep>[0];
    requestedLimits: number[];
    pages: string[][];
  } {
    const requestedLimits: number[] = [];
    const pages: string[][] = [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: (size: number) => {
        const call = requestedLimits.length;
        requestedLimits.push(size);
        const page = makePage(size, call);
        pages.push(page);
        return Promise.resolve(page.map(scopeKey => ({ scopeKey })));
      },
    };
    const database = {
      execute: async () => ({ rows: delta.map(scope_key => ({ scope_key })) }),
      selectDistinct: () => chain,
    } as unknown as Parameters<typeof runSpendAlertSweep>[0];
    return { database, requestedLimits, pages };
  }

  it('re-arms every firing scope across keyset pages, not only the first page', async () => {
    const evaluated: string[] = [];
    const store: SpendAlertSweepStore = {
      loadScopeSnapshot: async scopeKey => {
        evaluated.push(scopeKey);
        return null;
      },
    };
    const tail = ['user:zzz-1', 'user:zzz-2'];
    const { database, pages } = pagedFiringDatabase((size, call) =>
      call === 0
        ? Array.from({ length: size }, (_, i) => `user:p1-${String(i).padStart(4, '0')}`)
        : call === 1
          ? tail
          : []
    );

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    // The first page is full at the walk's own size, so a fixed single-page read
    // would stop here; the tail proves the walk continued past it.
    expect(pages[0].length).toBeGreaterThan(0);
    expect(pages[1]).toEqual(tail);
    expect(evaluated).toEqual([...pages[0], ...tail]);
    expect(result.candidateScopes).toBe(pages[0].length + tail.length);
  });

  it('decides a scope only once when the rollup delta and the firing set overlap', async () => {
    const evaluated: string[] = [];
    const store: SpendAlertSweepStore = {
      loadScopeSnapshot: async scopeKey => {
        evaluated.push(scopeKey);
        return null;
      },
    };
    // The same scope arrives once through the rollup delta and again through the
    // firing read; it must be decided once, not twice.
    const { database } = pagedFiringDatabase(
      (_size, call) => (call === 0 ? ['user:owner-1'] : []),
      ['user:owner-1']
    );

    const result = await runSpendAlertSweep(database, { store }, { now: NOW });

    expect(evaluated).toEqual(['user:owner-1']);
    expect(result.candidateScopes).toBe(1);
  });
});

describe('sweepHourlyBuckets window', () => {
  const HOUR_MS = 60 * 60 * 1000;

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
});
