import { describe, expect, it } from 'vitest';
import {
  estimateShadowMetrics,
  ShadowDecisionGroupSchema,
  shadowOutcomesQuery,
} from './production';
import { ProdMetricsSchema, ShadowMetricsSchema, ShadowOutcomesSchema } from './schema';

const window = {
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-02T00:00:00.000Z',
};
const group = {
  n: 1,
  sampled: true,
  differs: false,
  sessionId: 'fixture-session',
  decidedModel: 'fixture/model',
};

describe('estimateShadowMetrics', () => {
  it('weights sampled decisions without overweighting always-logged switches', () => {
    const metrics = estimateShadowMetrics(
      [group, { ...group, n: 2, sampled: false, differs: true }],
      0.1
    );
    expect(metrics.observedDecisions).toBe(3);
    expect(metrics.differsRate).toBeCloseTo(2 / 12);
    expect(metrics.outcomesByDecidedModel).toBeNull();
    expect(ShadowMetricsSchema.parse(metrics)).toEqual(metrics);
    expect(JSON.stringify(metrics)).not.toContain(group.sessionId);
  });

  it('reports unavailable divergence for no observations', () => {
    expect(estimateShadowMetrics([], 0.1)).toEqual({
      observedDecisions: 0,
      differsRate: null,
      outcomesByDecidedModel: null,
    });
  });

  it('supports complete and disabled success sampling without nonfinite rates', () => {
    const groups = [group, { ...group, sampled: false, differs: true }];
    expect(estimateShadowMetrics(groups, 1).differsRate).toBe(0.5);
    expect(estimateShadowMetrics(groups, 0).differsRate).toBeNull();
    expect(estimateShadowMetrics([group], 0).differsRate).toBeNull();
  });

  it('requires a boolean divergence so missing or failed shadow evaluations are not counted', () => {
    expect(ShadowDecisionGroupSchema.safeParse({ ...group, differs: null }).success).toBe(false);
    expect(ShadowDecisionGroupSchema.safeParse({ ...group, differs: undefined }).success).toBe(
      false
    );
  });
});

describe('shadowOutcomesQuery', () => {
  it('joins distinct sessions and decided models within both usage and metadata windows', () => {
    const sql = shadowOutcomesQuery(window, [group, group]);
    expect(sql).toContain('BEGIN READ ONLY;');
    expect(sql).toContain('SELECT DISTINCT "sessionId", "decidedModel"');
    expect(sql).toContain('meta.session_id = d."sessionId"');
    expect(sql).toContain('usage.id = meta.id AND usage.model = d."decidedModel"');
    expect(sql).toContain("am.auto_model IN ('kilo-auto/efficient', 'kilo-auto/balanced')");
    for (const table of ['meta', 'usage']) {
      expect(sql).toContain(`${table}.created_at >= '${window.start}'::timestamptz`);
      expect(sql).toContain(`${table}.created_at < '${window.end}'::timestamptz`);
    }
    expect(sql).toContain('avg((meta.status_code >= 400)::int)');
    expect(sql).toContain('avg(meta.cancelled::int)');
    expect(sql).toContain('avg(usage.input_tokens)');
    expect(sql).toContain('avg(usage.output_tokens)');
    expect(sql).toContain('avg(usage.cache_hit_tokens)');
    expect(sql).toContain('avg(usage.cost)::double precision / 1000000');
    expect(sql).toContain("jsonb_object_agg(model, to_jsonb(outcomes) - 'model')");
    expect(sql.trim()).toMatch(/ROLLBACK;$/);
    const resultSelect = sql.slice(sql.lastIndexOf('SELECT'));
    expect(resultSelect).not.toContain('sessionId');
  });

  it('excludes unjoinable sessions and safely quotes session/model input', () => {
    const sql = shadowOutcomesQuery(window, [
      { ...group, sessionId: null },
      { ...group, decidedModel: null },
      { ...group, sessionId: '' },
      { ...group, sessionId: "session'); DROP TABLE usage; --", decidedModel: "fixture/'quoted" },
    ]);
    expect(sql).toContain('SET LOCAL standard_conforming_strings=on;');
    expect(sql).toContain("session''); DROP TABLE usage; --");
    expect(sql).toContain("fixture/''quoted");
    expect(sql).not.toContain('"sessionId":null');
    expect(sql).not.toContain('"decidedModel":null');
    expect(sql).not.toContain('"sessionId":""');
  });

  it('exposes only model-level aggregate outcomes in the validated report', () => {
    const outcomes = ShadowOutcomesSchema.parse({
      'fixture/model': {
        requests: 4,
        errorRate: 0.25,
        abortRate: null,
        inputTokensPerRequest: 10,
        outputTokensPerRequest: 2,
        cacheReadTokensPerRequest: 5,
        costUsdPerRequest: 0.01,
        sessionId: 'must-not-escape',
      },
    });
    expect(JSON.stringify(outcomes)).not.toContain('must-not-escape');
    expect(
      ShadowOutcomesSchema.safeParse({
        'fixture/model': { ...outcomes['fixture/model'], errorRate: 2 },
      }).success
    ).toBe(false);
  });
});

it('reads an earlier production snapshot with shadow metrics unavailable', () => {
  const metrics = ProdMetricsSchema.parse({
    kind: 'prod',
    window,
    gatewayDecideMs: null,
    workerDecideMs: null,
    workerPhasesMs: null,
    cacheHitRate: null,
    classifierPerRequestUsd: null,
    switchRate: null,
    routeMix: {},
    modelTtftMs: null,
    prodPerRequestUsd: { mean: null, p50: null },
    prodCacheReadShare: null,
  });
  expect(metrics.shadow).toBeNull();
});
