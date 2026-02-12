/**
 * Query helpers for Analytics Engine SQL API.
 *
 * All queries target the `o11y_api_metrics` dataset and use
 * `_sample_interval` weighting for correct results under AE sampling.
 */

import { z } from 'zod';

type AeQueryEnv = {
	O11Y_CF_ACCOUNT_ID: string;
	O11Y_CF_AE_API_TOKEN: SecretsStoreSecret;
};

export type ErrorRateRow = {
	provider: string;
	model: string;
	client_name: string;
	weighted_errors: number;
	weighted_total: number;
};

export type ErrorRateBaselineRow = {
	weighted_total_1d: number;
	weighted_errors_1d: number;
	weighted_total_3d: number;
	weighted_errors_3d: number;
	weighted_total_7d: number;
	weighted_errors_7d: number;
};

// _sample_interval scales rows back to full volume when AE sampling is enabled.
// https://developers.cloudflare.com/analytics/analytics-engine/sql-api/#sampling

async function queryAnalyticsEngine<T>(sql: string, env: AeQueryEnv): Promise<T[]> {
	const apiToken = await env.O11Y_CF_AE_API_TOKEN.get();
	const url = `https://api.cloudflare.com/client/v4/accounts/${env.O11Y_CF_ACCOUNT_ID}/analytics_engine/sql`;

	const response = await fetch(url, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiToken}` },
		body: sql,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Analytics Engine query failed (${response.status}): ${text}`);
	}

	const { data } = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).parse(await response.json());
	return data as T[];
}

/**
 * Query error rates grouped by provider, model, and client for a given time window.
 */
export function queryErrorRates(windowMinutes: number, minRequests: number, env: AeQueryEnv): Promise<ErrorRateRow[]> {
	const sql = `
		SELECT
			blob1 AS provider,
			blob2 AS model,
			blob3 AS client_name,
			SUM(_sample_interval * IF(blob4 = '1', 1, 0)) AS weighted_errors,
			SUM(_sample_interval) AS weighted_total
		FROM o11y_api_metrics
		WHERE timestamp > NOW() - INTERVAL '${windowMinutes}' MINUTE
		GROUP BY provider, model, client_name
		HAVING weighted_total >= ${minRequests}
		FORMAT JSON
	`;
	return queryAnalyticsEngine<ErrorRateRow>(sql, env);
}

function escapeSqlString(value: string): string {
	return value.replaceAll("'", "''");
}

export async function queryErrorRateBaseline(model: string, env: AeQueryEnv): Promise<ErrorRateBaselineRow | null> {
	const modelValue = escapeSqlString(model);
	const sql = `
		SELECT
			SUM(IF(timestamp > NOW() - INTERVAL '1' DAY, _sample_interval, 0)) AS weighted_total_1d,
			SUM(IF(timestamp > NOW() - INTERVAL '1' DAY AND blob4 = '1', _sample_interval, 0)) AS weighted_errors_1d,
			SUM(IF(timestamp > NOW() - INTERVAL '3' DAY, _sample_interval, 0)) AS weighted_total_3d,
			SUM(IF(timestamp > NOW() - INTERVAL '3' DAY AND blob4 = '1', _sample_interval, 0)) AS weighted_errors_3d,
			SUM(IF(timestamp > NOW() - INTERVAL '7' DAY, _sample_interval, 0)) AS weighted_total_7d,
			SUM(IF(timestamp > NOW() - INTERVAL '7' DAY AND blob4 = '1', _sample_interval, 0)) AS weighted_errors_7d
		FROM o11y_api_metrics
		WHERE blob2 = '${modelValue}' AND timestamp > NOW() - INTERVAL '7' DAY
		FORMAT JSON
	`;

	const rows = await queryAnalyticsEngine<ErrorRateBaselineRow>(sql, env);
	return rows[0] ?? null;
}

// --- TTFB queries ---

export type TtfbExceedRow = {
	provider: string;
	model: string;
	client_name: string;
	weighted_slow: number;
	weighted_total: number;
};

/**
 * Query the fraction of successful requests where TTFB exceeds a threshold,
 * grouped by provider, model, and client for a given time window.
 *
 * Only considers successful requests (blob4 = '0') so errored requests
 * with meaningless TTFB values don't pollute the latency signal.
 */
export function queryTtfbExceedRates(
	windowMinutes: number,
	minRequests: number,
	thresholdMs: number,
	env: AeQueryEnv,
): Promise<TtfbExceedRow[]> {
	const sql = `
		SELECT
			blob1 AS provider,
			blob2 AS model,
			blob3 AS client_name,
			SUM(_sample_interval * IF(double1 > ${thresholdMs}, 1, 0)) AS weighted_slow,
			SUM(_sample_interval) AS weighted_total
		FROM o11y_api_metrics
		WHERE timestamp > NOW() - INTERVAL '${windowMinutes}' MINUTE
			AND blob4 = '0'
		GROUP BY provider, model, client_name
		HAVING weighted_total >= ${minRequests}
		FORMAT JSON
	`;
	return queryAnalyticsEngine<TtfbExceedRow>(sql, env);
}

export type TtfbBaselineRow = {
	p50_ttfb_3d: number;
	p95_ttfb_3d: number;
	p99_ttfb_3d: number;
	weighted_total_3d: number;
};

type TtfbBaseline3dRow = {
	p50_ttfb: number;
	p95_ttfb: number;
	p99_ttfb: number;
	weighted_total: number;
};

/**
 * Query p50/p95/p99 TTFB baselines and request count for a model over the last 3 days.
 * Uses quantileExactWeighted for correct results under AE sampling.
 * Only considers successful requests (blob4 = '0').
 */
export async function queryTtfbBaseline(model: string, env: AeQueryEnv): Promise<TtfbBaselineRow> {
	const modelValue = escapeSqlString(model);
	const sql = `
		SELECT
			quantileExactWeighted(0.50)(double1, _sample_interval) AS p50_ttfb,
			quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ttfb,
			quantileExactWeighted(0.99)(double1, _sample_interval) AS p99_ttfb,
			SUM(_sample_interval) AS weighted_total
		FROM o11y_api_metrics
		WHERE blob2 = '${modelValue}' AND blob4 = '0'
			AND timestamp > NOW() - INTERVAL '3' DAY
		FORMAT JSON
	`;

	const rows = await queryAnalyticsEngine<TtfbBaseline3dRow>(sql, env);
	const row = rows[0];

	return {
		p50_ttfb_3d: Number(row?.p50_ttfb || 0),
		p95_ttfb_3d: Number(row?.p95_ttfb || 0),
		p99_ttfb_3d: Number(row?.p99_ttfb || 0),
		weighted_total_3d: Number(row?.weighted_total || 0),
	};
}
