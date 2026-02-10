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
		WHERE blob2 = '${modelValue}'
		FORMAT JSON
	`;

	const rows = await queryAnalyticsEngine<ErrorRateBaselineRow>(sql, env);
	return rows[0] ?? null;
}
