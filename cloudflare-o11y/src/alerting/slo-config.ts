/**
 * SLO thresholds and multi-window burn-rate alerting parameters.
 *
 * Based on the Google SRE Workbook approach #6 (multiwindow, multi-burn-rate):
 * https://sre.google/workbook/alerting-on-slos/
 *
 * An alert fires only when BOTH the long window AND the short window
 * exceed the burn rate threshold for a given provider:model.
 */

export type AlertSeverity = 'page' | 'ticket';

export type BurnRateWindow = {
	severity: AlertSeverity;
	longWindowMinutes: number;
	shortWindowMinutes: number;
	burnRate: number;
};

// Multi-window burn-rate windows per the architecture doc
export const BURN_RATE_WINDOWS: BurnRateWindow[] = [
	{ severity: 'page', longWindowMinutes: 5, shortWindowMinutes: 1, burnRate: 14.4 },
	{ severity: 'page', longWindowMinutes: 30, shortWindowMinutes: 3, burnRate: 6 },
	{ severity: 'ticket', longWindowMinutes: 360, shortWindowMinutes: 30, burnRate: 1 },
];

export type O11ySloConfig = {
	// 0.999 means 99.9% of requests should succeed
	errorRateSlo: number;
	// Latency: the threshold in ms below which a request is "good"
	latencyP50ThresholdMs: number;
	latencyP90ThresholdMs: number;
	// 0.999 means 99.9% of requests should be under the threshold
	latencySlo: number;
	// Suppress alerts if the window has fewer than this many requests
	minRequestsPerWindow: number;
};

export const DEFAULT_SLO_CONFIG: O11ySloConfig = {
	errorRateSlo: 0.999,
	latencyP50ThresholdMs: 5_000,
	latencyP90ThresholdMs: 15_000,
	latencySlo: 0.999,
	minRequestsPerWindow: 10,
};

// Alert dedup cooldowns
export const PAGE_COOLDOWN_SECONDS = 15 * 60; // 15 minutes
export const TICKET_COOLDOWN_SECONDS = 4 * 60 * 60; // 4 hours
