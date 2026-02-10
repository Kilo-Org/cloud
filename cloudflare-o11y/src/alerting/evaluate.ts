/**
 * Main alert evaluation logic, invoked by the scheduled() cron handler.
 *
 * For each burn-rate window, queries Analytics Engine for error rates
 * and latency, then checks if the burn rate exceeds the threshold in
 * both the long and short windows (multiwindow approach).
 */

import { BURN_RATE_WINDOWS, type BurnRateWindow } from './slo-config';
import { queryErrorRates, queryTtfbExceedRates, type ErrorRateRow, type TtfbExceedRow } from './query';
import { shouldSuppress, recordAlertFired } from './dedup';
import { sendAlertNotification, type AlertPayload } from './notify';
import { listAlertingConfigs, type AlertingConfig } from './config-store';
import { listTtfbAlertingConfigs, type TtfbAlertingConfig } from './ttfb-config-store';

/**
 * Compute the burn rate from an observed bad-event fraction and the SLO.
 * burn_rate = (bad_fraction) / (1 - SLO)
 */
export function computeBurnRate(badFraction: number, slo: number): number {
	const errorBudget = 1 - slo;
	if (errorBudget <= 0) return Infinity;
	return badFraction / errorBudget;
}

export type DimensionKey = `${string}:${string}:${string}`; // provider:model:clientName

export function dimensionKey(provider: string, model: string, clientName: string): DimensionKey {
	return `${provider}:${model}:${clientName}`;
}

export function rowsToMap<T extends { provider: string; model: string; client_name: string }>(rows: T[]): Map<DimensionKey, T> {
	const map = new Map<DimensionKey, T>();
	for (const row of rows) {
		map.set(dimensionKey(row.provider, row.model, row.client_name), row);
	}
	return map;
}

type ConfigByModel = Map<string, AlertingConfig>;

async function evaluateErrorRateWindow(window: BurnRateWindow, configByModel: ConfigByModel, env: Env): Promise<void> {
	if (configByModel.size === 0) return;

	// Query the long window first
	const longRows = await queryErrorRates(window.longWindowMinutes, 1, env);
	if (longRows.length === 0) return;

	// For each dimension that trips the long window, check the short window
	const trippedDimensions: Array<{ row: ErrorRateRow; config: AlertingConfig }> = [];
	for (const row of longRows) {
		const config = configByModel.get(row.model);
		if (!config || !config.enabled) continue;
		if (row.weighted_total <= 0) continue;
		if (row.weighted_total < config.minRequestsPerWindow) continue;
		const errorRate = row.weighted_errors / row.weighted_total;
		const burnRate = computeBurnRate(errorRate, config.errorRateSlo);
		if (burnRate >= window.burnRate) {
			trippedDimensions.push({ row, config });
		}
	}

	if (trippedDimensions.length === 0) return;

	// Query the short window
	const shortRows = await queryErrorRates(window.shortWindowMinutes, 1, env);
	const shortMap = rowsToMap(shortRows);

	for (const { row: longRow, config } of trippedDimensions) {
		const key = dimensionKey(longRow.provider, longRow.model, longRow.client_name);
		const shortRow = shortMap.get(key);
		if (!shortRow) continue;
		if (shortRow.weighted_total <= 0) continue;
		if (shortRow.weighted_total < config.minRequestsPerWindow) continue;

		const shortErrorRate = shortRow.weighted_errors / shortRow.weighted_total;
		const shortBurnRate = computeBurnRate(shortErrorRate, config.errorRateSlo);
		if (shortBurnRate < window.burnRate) continue;

		// Both windows tripped — determine severity and fire
		const severity = window.severity;

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

type TtfbConfigByModel = Map<string, TtfbAlertingConfig>;

/**
 * Group TTFB configs by their threshold value so we can batch AE queries.
 * Returns a map of thresholdMs -> set of model IDs.
 */
export function groupByThreshold(configs: TtfbConfigByModel): Map<number, Set<string>> {
	const groups = new Map<number, Set<string>>();
	for (const [model, config] of configs) {
		const existing = groups.get(config.ttfbThresholdMs);
		if (existing) {
			existing.add(model);
		} else {
			groups.set(config.ttfbThresholdMs, new Set([model]));
		}
	}
	return groups;
}

async function evaluateTtfbWindow(window: BurnRateWindow, configByModel: TtfbConfigByModel, env: Env): Promise<void> {
	if (configByModel.size === 0) return;

	const thresholdGroups = groupByThreshold(configByModel);

	// Collect tripped dimensions across all threshold groups from the long window
	const trippedDimensions: Array<{ row: TtfbExceedRow; config: TtfbAlertingConfig; slowFraction: number }> = [];

	for (const [thresholdMs, modelSet] of thresholdGroups) {
		const longRows = await queryTtfbExceedRates(window.longWindowMinutes, 1, thresholdMs, env);
		if (longRows.length === 0) continue;

		for (const row of longRows) {
			if (!modelSet.has(row.model)) continue;
			const config = configByModel.get(row.model);
			if (!config) continue;
			if (row.weighted_total <= 0) continue;
			if (row.weighted_total < config.minRequestsPerWindow) continue;

			const slowFraction = row.weighted_slow / row.weighted_total;
			const burnRate = computeBurnRate(slowFraction, config.ttfbSlo);
			if (burnRate >= window.burnRate) {
				trippedDimensions.push({ row, config, slowFraction });
			}
		}
	}

	if (trippedDimensions.length === 0) return;

	// Re-group tripped dimensions by threshold for the short window queries
	const trippedByThreshold = new Map<number, Array<{ row: TtfbExceedRow; config: TtfbAlertingConfig; slowFraction: number }>>();
	for (const tripped of trippedDimensions) {
		const threshold = tripped.config.ttfbThresholdMs;
		const existing = trippedByThreshold.get(threshold);
		if (existing) {
			existing.push(tripped);
		} else {
			trippedByThreshold.set(threshold, [tripped]);
		}
	}

	for (const [thresholdMs, trippedGroup] of trippedByThreshold) {
		const shortRows = await queryTtfbExceedRates(window.shortWindowMinutes, 1, thresholdMs, env);
		const shortMap = rowsToMap(shortRows);

		for (const { row: longRow, config, slowFraction: longSlowFraction } of trippedGroup) {
			const key = dimensionKey(longRow.provider, longRow.model, longRow.client_name);
			const shortRow = shortMap.get(key);
			if (!shortRow) continue;
			if (shortRow.weighted_total <= 0) continue;
			if (shortRow.weighted_total < config.minRequestsPerWindow) continue;

			const shortSlowFraction = shortRow.weighted_slow / shortRow.weighted_total;
			const shortBurnRate = computeBurnRate(shortSlowFraction, config.ttfbSlo);
			if (shortBurnRate < window.burnRate) continue;

			const suppressed = await shouldSuppress(
				env.O11Y_ALERT_STATE,
				window.severity,
				'ttfb',
				longRow.provider,
				longRow.model,
				longRow.client_name,
			);
			if (suppressed) continue;

			const actualBurnRate = computeBurnRate(longSlowFraction, config.ttfbSlo);

			const alert: AlertPayload = {
				severity: window.severity,
				alertType: 'ttfb',
				provider: longRow.provider,
				model: longRow.model,
				clientName: longRow.client_name,
				burnRate: actualBurnRate,
				burnRateThreshold: window.burnRate,
				windowMinutes: window.longWindowMinutes,
				totalRequests: longRow.weighted_total,
				slo: config.ttfbSlo,
				currentTtfbFraction: longSlowFraction,
				ttfbThresholdMs: config.ttfbThresholdMs,
			};

			await sendAlertNotification(alert, env);
			await recordAlertFired(env.O11Y_ALERT_STATE, window.severity, 'ttfb', longRow.provider, longRow.model, longRow.client_name);
		}
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
	const configs = await listAlertingConfigs(env);
	const enabledConfigs = configs.filter((config) => config.enabled);
	const configByModel: ConfigByModel = new Map(enabledConfigs.map((config) => [config.model, config]));

	const ttfbConfigs = await listTtfbAlertingConfigs(env);
	const enabledTtfbConfigs = ttfbConfigs.filter((config) => config.enabled);
	const ttfbConfigByModel: TtfbConfigByModel = new Map(enabledTtfbConfigs.map((config) => [config.model, config]));

	// Sort windows by severity: pages first, then tickets.
	// Within the same severity, higher burn rate first.
	const sortedWindows = [...BURN_RATE_WINDOWS].sort((a, b) => {
		if (a.severity !== b.severity) return a.severity === 'page' ? -1 : 1;
		return b.burnRate - a.burnRate;
	});

	const errors: unknown[] = [];

	for (const window of sortedWindows) {
		try {
			await evaluateErrorRateWindow(window, configByModel, env);
		} catch (err) {
			errors.push(new Error(`error_rate window (${window.longWindowMinutes}m)`, { cause: err }));
		}

		try {
			await evaluateTtfbWindow(window, ttfbConfigByModel, env);
		} catch (err) {
			errors.push(new Error(`ttfb window (${window.longWindowMinutes}m)`, { cause: err }));
		}
	}

	if (errors.length > 0) {
		throw new AggregateError(errors, `Alert evaluation failed with ${errors.length} error(s)`);
	}
}
