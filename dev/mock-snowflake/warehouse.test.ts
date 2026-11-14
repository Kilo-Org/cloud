import assert from 'node:assert/strict';
import test from 'node:test';

import { answerStatement, type UsageFixtureRow, type SnowflakeBinding } from './warehouse';

function row(overrides: Partial<UsageFixtureRow>): UsageFixtureRow {
  return {
    usage_date: '2026-11-10',
    kilo_user_id: 'user-1',
    organization_id: '',
    model: 'anthropic/claude-sonnet-4',
    feature: 'code-review',
    provider: 'openrouter',
    mode: '',
    project_id: '',
    request_count: 1,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_cache_write_tokens: 0,
    total_cache_hit_tokens: 0,
    error_count: 0,
    cancelled_count: 0,
    free_request_count: 0,
    user_byok_request_count: 0,
    total_latency_ms: 700,
    total_generation_time_ms: 500,
    latency_count: 1,
    total_tokens: 1500,
    total_cost_microdollars: 10_000,
    total_market_cost_microdollars: 12_000,
    ...overrides,
  };
}

const bindings = (...values: string[]): Record<string, SnowflakeBinding> =>
  Object.fromEntries(values.map((value, index) => [String(index + 1), { type: 'TEXT', value }]));

const SUMMARY = `
  SELECT
    COALESCE(SUM(total_cost_microdollars), 0),
    COALESCE(SUM(request_count), 0),
    COALESCE(SUM(total_input_tokens), 0),
    COALESCE(SUM(total_output_tokens), 0),
    COALESCE(SUM(total_cache_write_tokens), 0),
    COALESCE(SUM(total_cache_hit_tokens), 0),
    COALESCE(SUM(error_count), 0),
    COALESCE(SUM(cancelled_count), 0),
    COALESCE(SUM(free_request_count), 0),
    COALESCE(SUM(user_byok_request_count), 0),
    COALESCE(SUM(total_latency_ms), 0),
    COALESCE(SUM(total_generation_time_ms), 0),
    COALESCE(SUM(latency_count), 0),
    COALESCE(SUM(IFF(total_generation_time_ms IS NOT NULL AND usage_date >= DATEADD(day, -7, CURRENT_DATE), 1, 0)), 0),
    COALESCE(SUM(total_tokens), 0),
    COUNT(DISTINCT kilo_user_id)
  FROM MICRODOLLAR_USAGE_DAILY
  WHERE usage_date >= ? AND usage_date < ?
  AND kilo_user_id = ?
`;

const TIMESERIES = `
  SELECT
    TO_VARCHAR(usage_date, 'YYYY-MM-DD') AS bucket,
    COALESCE(SUM(total_cost_microdollars), 0) AS value
  FROM MICRODOLLAR_USAGE_DAILY
  WHERE usage_date >= ? AND usage_date < ?
  AND kilo_user_id = ?
  GROUP BY 1
  ORDER BY 1
`;

const BREAKDOWN = `
  SELECT
    model AS key,
    COALESCE(SUM(total_cost_microdollars), 0) AS value
  FROM MICRODOLLAR_USAGE_DAILY
  WHERE usage_date >= ? AND usage_date < ?
  AND organization_id = ?
  GROUP BY 1
  ORDER BY 2 DESC
  LIMIT 2
`;

const NOW = new Date('2026-11-12T12:00:00.000Z');

test('summary filters the window and the caller, and returns the router column order', () => {
  const rows = [
    row({ usage_date: '2026-11-10', total_cost_microdollars: 10_000 }),
    row({ usage_date: '2026-11-11', total_cost_microdollars: 5_000, error_count: 1 }),
    row({ usage_date: '2026-10-01', total_cost_microdollars: 999_999 }),
    row({ usage_date: '2026-11-10', kilo_user_id: 'user-2', total_cost_microdollars: 7_777 }),
  ];

  const [summary] = answerStatement(
    SUMMARY,
    bindings('2026-11-06', '2026-11-12', 'user-1'),
    rows,
    NOW
  );
  assert.ok(summary);
  assert.equal(summary[0], '15000');
  assert.equal(summary[1], '2');
  assert.equal(summary[6], '1');
  assert.equal(summary[13], '2');
  assert.equal(summary[15], '1');
});

test('summary is a single zero row when the window holds no usage', () => {
  const [summary] = answerStatement(
    SUMMARY,
    bindings('2026-11-06', '2026-11-12', 'user-1'),
    [],
    NOW
  );
  assert.ok(summary);
  assert.equal(summary[0], '0');
  assert.equal(summary[1], '0');
  assert.equal(summary[15], '0');
});

test('timeseries buckets one value per day, in date order', () => {
  const rows = [
    row({ usage_date: '2026-11-11', total_cost_microdollars: 3_000 }),
    row({ usage_date: '2026-11-10', total_cost_microdollars: 2_000 }),
    row({ usage_date: '2026-11-10', total_cost_microdollars: 1_000 }),
  ];

  const series = answerStatement(
    TIMESERIES,
    bindings('2026-11-06', '2026-11-12', 'user-1'),
    rows,
    NOW
  );
  assert.deepEqual(series, [
    ['2026-11-10', '3000'],
    ['2026-11-11', '3000'],
  ]);
});

test('breakdown groups an organization by model, largest first, up to the limit', () => {
  const rows = [
    row({ organization_id: 'org-1', model: 'openai/gpt-5', total_cost_microdollars: 5_000 }),
    row({
      organization_id: 'org-1',
      model: 'anthropic/claude-sonnet-4',
      total_cost_microdollars: 9_000,
    }),
    row({ organization_id: 'org-1', model: 'google/gemini-3-pro', total_cost_microdollars: 1_000 }),
    row({ organization_id: 'org-2', model: 'openai/gpt-5', total_cost_microdollars: 50_000 }),
  ];

  const breakdown = answerStatement(
    BREAKDOWN,
    bindings('2026-11-06', '2026-11-12', 'org-1'),
    rows,
    NOW
  );
  assert.deepEqual(breakdown, [
    ['anthropic/claude-sonnet-4', '9000'],
    ['openai/gpt-5', '5000'],
  ]);
});

test('an empty fixture directory answers the summary with zeros', () => {
  const [summary] = answerStatement(
    SUMMARY,
    bindings('2026-11-06', '2026-11-12', 'nobody'),
    [],
    NOW
  );
  assert.ok(summary);
  assert.equal(summary[1], '0');
});
