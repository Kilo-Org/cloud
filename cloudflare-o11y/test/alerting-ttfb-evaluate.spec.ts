import { describe, it, expect } from 'vitest';
import { computeBurnRate, groupByThreshold } from '../src/alerting/evaluate';
import type { TtfbAlertingConfig } from '../src/alerting/ttfb-config-store';

function makeTtfbConfig(model: string, overrides?: Partial<TtfbAlertingConfig>): TtfbAlertingConfig {
	return {
		model,
		enabled: true,
		ttfbThresholdMs: 2000,
		ttfbSlo: 0.95,
		minRequestsPerWindow: 100,
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('TTFB burn-rate computation', () => {
	it('computes correct burn rate for TTFB SLO of 0.95', () => {
		// 10% of requests exceed threshold with 95% SLO => 0.10 / 0.05 = 2.0
		expect(computeBurnRate(0.1, 0.95)).toBeCloseTo(2.0);
	});

	it('trips page-level burn rate (14.4x) when slow fraction is high', () => {
		// Need burn rate >= 14.4 with SLO 0.95: slowFraction >= 14.4 * 0.05 = 0.72
		const slowFraction = 0.72;
		const burnRate = computeBurnRate(slowFraction, 0.95);
		expect(burnRate).toBeCloseTo(14.4);
	});

	it('trips ticket-level burn rate (1x) at the SLO boundary', () => {
		// 1x burn rate with SLO 0.95: slowFraction = 1 * 0.05 = 0.05
		const slowFraction = 0.05;
		const burnRate = computeBurnRate(slowFraction, 0.95);
		expect(burnRate).toBeCloseTo(1.0);
	});

	it('does not trip when slow fraction is within budget', () => {
		// 3% slow with 95% SLO => 0.03 / 0.05 = 0.6 (below 1.0 threshold)
		const burnRate = computeBurnRate(0.03, 0.95);
		expect(burnRate).toBeLessThan(1.0);
	});
});

describe('groupByThreshold', () => {
	it('groups models with same threshold', () => {
		const configs = new Map<string, TtfbAlertingConfig>([
			['openai/gpt-4', makeTtfbConfig('openai/gpt-4', { ttfbThresholdMs: 2000 })],
			['openai/gpt-4o-mini', makeTtfbConfig('openai/gpt-4o-mini', { ttfbThresholdMs: 2000 })],
			['anthropic/claude-sonnet-4', makeTtfbConfig('anthropic/claude-sonnet-4', { ttfbThresholdMs: 3000 })],
		]);

		const groups = groupByThreshold(configs);
		expect(groups.size).toBe(2);
		expect(groups.get(2000)).toEqual(new Set(['openai/gpt-4', 'openai/gpt-4o-mini']));
		expect(groups.get(3000)).toEqual(new Set(['anthropic/claude-sonnet-4']));
	});

	it('returns empty map for empty configs', () => {
		const groups = groupByThreshold(new Map());
		expect(groups.size).toBe(0);
	});

	it('groups all models under single threshold', () => {
		const configs = new Map<string, TtfbAlertingConfig>([
			['model-a', makeTtfbConfig('model-a', { ttfbThresholdMs: 2000 })],
			['model-b', makeTtfbConfig('model-b', { ttfbThresholdMs: 2000 })],
			['model-c', makeTtfbConfig('model-c', { ttfbThresholdMs: 2000 })],
		]);

		const groups = groupByThreshold(configs);
		expect(groups.size).toBe(1);
		expect(groups.get(2000)?.size).toBe(3);
	});
});
