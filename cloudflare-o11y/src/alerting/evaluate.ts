/**
 * Main alert evaluation logic, invoked by the scheduled() cron handler.
 *
 * For each burn-rate window, queries Analytics Engine for error rates
 * and latency, then checks if the burn rate exceeds the threshold in
 * both the long and short windows (multiwindow approach).
 */

import { BURN_RATE_WINDOWS, DEFAULT_SLO_CONFIG, type AlertSeverity, type BurnRateWindow } from './slo-config';
import { queryErrorRates, querySlowRequestRates, type ErrorRateRow, type LatencyRow } from './query';
import { shouldSuppress, recordAlertFired } from './dedup';
import { sendAlertNotification, type AlertPayload } from './notify';
import { getRecommendedModels } from './recommended-models';

/**
 * Compute the burn rate from an observed bad-event fraction and the SLO.
 * burn_rate = (bad_fraction) / (1 - SLO)
 */
function computeBurnRate(badFraction: number, slo: number): number {
	const errorBudget = 1 - slo;
	if (errorBudget <= 0) return Infinity;
	return badFraction / errorBudget;
}

type DimensionKey = `${string}:${string}:${string}`; // provider:model:clientName

function dimensionKey(provider: string, model: string, clientName: string): DimensionKey {
	return `${provider}:${model}:${clientName}`;
}

function rowsToMap<T extends { provider: string; model: string; client_name: string }>(rows: T[]): Map<DimensionKey, T> {
	const map = new Map<DimensionKey, T>();
	for (const row of rows) {
		map.set(dimensionKey(row.provider, row.model, row.client_name), row);
	}
	return map;
}

/**
 * Determine the effective severity for an alert based on whether
 * the model is a recommended model on the Kilo Gateway.
 *
 * Pages are only for recommended models on kilo-gateway.
 * Everything else is a ticket at most.
 */
function effectiveSeverity(baseSeverity: AlertSeverity, clientName: string, model: string, recommendedModels: Set<string>): AlertSeverity {
	if (baseSeverity === 'page') {
		if (clientName === 'kilo-gateway' && recommendedModels.has(model)) {
			return 'page';
		}
		// Downgrade to ticket for non-recommended / non-gateway
		return 'ticket';
	}
	return baseSeverity;
}

async function evaluateErrorRateWindow(window: BurnRateWindow, recommendedModels: Set<string>, env: Env): Promise<void> {
	const config = DEFAULT_SLO_CONFIG;

	// Query the long window first
	const longRows = await queryErrorRates(window.longWindowMinutes, config.minRequestsPerWindow, env);
	if (longRows.length === 0) return;

	// For each dimension that trips the long window, check the short window
	const trippedDimensions: ErrorRateRow[] = [];
	for (const row of longRows) {
		const errorRate = row.weighted_errors / row.weighted_total;
		const burnRate = computeBurnRate(errorRate, config.errorRateSlo);
		if (burnRate >= window.burnRate) {
			trippedDimensions.push(row);
		}
	}

	if (trippedDimensions.length === 0) return;

	// Query the short window
	const shortRows = await queryErrorRates(window.shortWindowMinutes, config.minRequestsPerWindow, env);
	const shortMap = rowsToMap(shortRows);

	for (const longRow of trippedDimensions) {
		const key = dimensionKey(longRow.provider, longRow.model, longRow.client_name);
		const shortRow = shortMap.get(key);
		if (!shortRow) continue;

		const shortErrorRate = shortRow.weighted_errors / shortRow.weighted_total;
		const shortBurnRate = computeBurnRate(shortErrorRate, config.errorRateSlo);
		if (shortBurnRate < window.burnRate) continue;

		// Both windows tripped — determine severity and fire
		const severity = effectiveSeverity(window.severity, longRow.client_name, longRow.model, recommendedModels);

		const suppressed = await shouldSuppress(
			env.O11Y_ALERT_STATE,
			severity,
			'error_rate',
			longRow.provider,
			longRow.model,
			longRow.client_name,
		);
		if (suppressed) continue;

		const longErrorRate = longRow.weighted_errors / longRow.weighted_total;
		const actualBurnRate = computeBurnRate(longErrorRate, config.errorRateSlo);

		const alert: AlertPayload = {
			severity,
			alertType: 'error_rate',
			provider: longRow.provider,
			model: longRow.model,
			clientName: longRow.client_name,
			burnRate: actualBurnRate,
			burnRateThreshold: window.burnRate,
			windowMinutes: window.longWindowMinutes,
			currentRate: longErrorRate,
			totalRequests: longRow.weighted_total,
			slo: config.errorRateSlo,
		};

		await sendAlertNotification(alert, env);
		await recordAlertFired(env.O11Y_ALERT_STATE, severity, 'error_rate', longRow.provider, longRow.model, longRow.client_name);
	}
}

async function evaluateLatencyWindow(
	window: BurnRateWindow,
	thresholdMs: number,
	alertType: 'latency_p50' | 'latency_p90',
	recommendedModels: Set<string>,
	env: Env,
): Promise<void> {
	const config = DEFAULT_SLO_CONFIG;

	// Query the long window
	const longRows = await querySlowRequestRates(window.longWindowMinutes, thresholdMs, config.minRequestsPerWindow, env);
	if (longRows.length === 0) return;

	// Find dimensions that trip the long window
	const trippedDimensions: LatencyRow[] = [];
	for (const row of longRows) {
		const slowFraction = row.weighted_slow / row.weighted_total;
		const burnRate = computeBurnRate(slowFraction, config.latencySlo);
		if (burnRate >= window.burnRate) {
			trippedDimensions.push(row);
		}
	}

	if (trippedDimensions.length === 0) return;

	// Query the short window
	const shortRows = await querySlowRequestRates(window.shortWindowMinutes, thresholdMs, config.minRequestsPerWindow, env);
	const shortMap = rowsToMap(shortRows);

	for (const longRow of trippedDimensions) {
		const key = dimensionKey(longRow.provider, longRow.model, longRow.client_name);
		const shortRow = shortMap.get(key);
		if (!shortRow) continue;

		const shortSlowFraction = shortRow.weighted_slow / shortRow.weighted_total;
		const shortBurnRate = computeBurnRate(shortSlowFraction, config.latencySlo);
		if (shortBurnRate < window.burnRate) continue;

		const severity = effectiveSeverity(window.severity, longRow.client_name, longRow.model, recommendedModels);

		const suppressed = await shouldSuppress(
			env.O11Y_ALERT_STATE,
			severity,
			alertType,
			longRow.provider,
			longRow.model,
			longRow.client_name,
		);
		if (suppressed) continue;

		const longSlowFraction = longRow.weighted_slow / longRow.weighted_total;
		const actualBurnRate = computeBurnRate(longSlowFraction, config.latencySlo);

		const alert: AlertPayload = {
			severity,
			alertType,
			provider: longRow.provider,
			model: longRow.model,
			clientName: longRow.client_name,
			burnRate: actualBurnRate,
			burnRateThreshold: window.burnRate,
			windowMinutes: window.longWindowMinutes,
			thresholdMs,
			totalRequests: longRow.weighted_total,
			slo: config.latencySlo,
		};

		await sendAlertNotification(alert, env);
		await recordAlertFired(env.O11Y_ALERT_STATE, severity, alertType, longRow.provider, longRow.model, longRow.client_name);
	}
}

/**
 * Top-level alert evaluation, called once per cron tick (every minute).
 *
 * Evaluates burn-rate windows from highest severity to lowest.
 * Higher-severity windows are checked first so that their dedup markers
 * can suppress lower-severity alerts for the same dimension.
 */
export async function evaluateAlerts(env: Env): Promise<void> {
	const recommendedModels = await getRecommendedModels(env);
	const config = DEFAULT_SLO_CONFIG;

	// Sort windows by severity: pages first, then tickets.
	// Within the same severity, higher burn rate first.
	const sortedWindows = [...BURN_RATE_WINDOWS].sort((a, b) => {
		if (a.severity !== b.severity) return a.severity === 'page' ? -1 : 1;
		return b.burnRate - a.burnRate;
	});

	for (const window of sortedWindows) {
		try {
			await evaluateErrorRateWindow(window, recommendedModels, env);
		} catch (err) {
			console.error(`Error evaluating error rate window (${window.longWindowMinutes}m):`, err);
		}

		try {
			await evaluateLatencyWindow(window, config.latencyP50ThresholdMs, 'latency_p50', recommendedModels, env);
		} catch (err) {
			console.error(`Error evaluating latency p50 window (${window.longWindowMinutes}m):`, err);
		}

		try {
			await evaluateLatencyWindow(window, config.latencyP90ThresholdMs, 'latency_p90', recommendedModels, env);
		} catch (err) {
			console.error(`Error evaluating latency p90 window (${window.longWindowMinutes}m):`, err);
		}
	}
}
