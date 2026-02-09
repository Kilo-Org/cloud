import { describe, it, expect } from 'vitest';
import { computeBurnRate, dimensionKey, effectiveSeverity, rowsToMap } from '../src/alerting/evaluate';

describe('computeBurnRate', () => {
	it('computes burn rate from bad fraction and SLO', () => {
		// 1% bad with 99.9% SLO => 0.01 / 0.001 = 10
		expect(computeBurnRate(0.01, 0.999)).toBeCloseTo(10);
	});

	it('returns 0 when bad fraction is 0', () => {
		expect(computeBurnRate(0, 0.999)).toBe(0);
	});

	it('returns Infinity when SLO is 1.0 (zero error budget)', () => {
		expect(computeBurnRate(0.01, 1.0)).toBe(Infinity);
	});

	it('returns Infinity when SLO exceeds 1.0', () => {
		expect(computeBurnRate(0.01, 1.1)).toBe(Infinity);
	});

	it('handles typical page-level burn rate threshold', () => {
		// 14.4x burn rate means bad_fraction = 14.4 * (1 - 0.999) = 0.0144
		expect(computeBurnRate(0.0144, 0.999)).toBeCloseTo(14.4);
	});
});

describe('dimensionKey', () => {
	it('constructs provider:model:clientName key', () => {
		expect(dimensionKey('openai', 'gpt-4', 'kilo-gateway')).toBe('openai:gpt-4:kilo-gateway');
	});

	it('handles empty strings', () => {
		expect(dimensionKey('', '', '')).toBe('::');
	});

	it('preserves colons in values', () => {
		expect(dimensionKey('a:b', 'c', 'd')).toBe('a:b:c:d');
	});
});

describe('rowsToMap', () => {
	it('converts rows to a map keyed by dimension', () => {
		const rows = [
			{ provider: 'openai', model: 'gpt-4', client_name: 'kilo-gateway', value: 1 },
			{ provider: 'anthropic', model: 'claude-sonnet-4.5', client_name: 'cli', value: 2 },
		];
		const map = rowsToMap(rows);
		expect(map.size).toBe(2);
		expect(map.get('openai:gpt-4:kilo-gateway')?.value).toBe(1);
		expect(map.get('anthropic:claude-sonnet-4.5:cli')?.value).toBe(2);
	});

	it('returns empty map for empty input', () => {
		expect(rowsToMap([]).size).toBe(0);
	});

	it('last row wins for duplicate dimensions', () => {
		const rows = [
			{ provider: 'openai', model: 'gpt-4', client_name: 'cli', value: 1 },
			{ provider: 'openai', model: 'gpt-4', client_name: 'cli', value: 2 },
		];
		const map = rowsToMap(rows);
		expect(map.size).toBe(1);
		expect(map.get('openai:gpt-4:cli')?.value).toBe(2);
	});
});

describe('effectiveSeverity', () => {
	const recommended = new Set(['gpt-4', 'claude-sonnet-4.5']);

	it('keeps page for recommended model on kilo-gateway', () => {
		expect(effectiveSeverity('page', 'kilo-gateway', 'gpt-4', recommended)).toBe('page');
	});

	it('downgrades page to ticket for non-recommended model on kilo-gateway', () => {
		expect(effectiveSeverity('page', 'kilo-gateway', 'gpt-3.5-turbo', recommended)).toBe('ticket');
	});

	it('downgrades page to ticket for recommended model on non-gateway client', () => {
		expect(effectiveSeverity('page', 'cli', 'gpt-4', recommended)).toBe('ticket');
	});

	it('downgrades page to ticket for non-recommended model on non-gateway client', () => {
		expect(effectiveSeverity('page', 'cli', 'gpt-3.5-turbo', recommended)).toBe('ticket');
	});

	it('keeps ticket severity unchanged regardless of model/client', () => {
		expect(effectiveSeverity('ticket', 'kilo-gateway', 'gpt-4', recommended)).toBe('ticket');
		expect(effectiveSeverity('ticket', 'cli', 'gpt-3.5-turbo', recommended)).toBe('ticket');
	});

	it('handles empty recommended models set', () => {
		expect(effectiveSeverity('page', 'kilo-gateway', 'gpt-4', new Set())).toBe('ticket');
	});
});
