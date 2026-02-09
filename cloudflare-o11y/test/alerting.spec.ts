import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldSuppress, recordAlertFired } from '../src/alerting/dedup';
import { BURN_RATE_WINDOWS, DEFAULT_SLO_CONFIG } from '../src/alerting/slo-config';

function makeKvMock() {
	const store = new Map<string, { value: string; expiration?: number }>();
	const putSpy = vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
		store.set(key, { value, expiration: opts?.expirationTtl });
	});
	const kv = {
		get: vi.fn(async (key: string) => {
			const entry = store.get(key);
			if (!entry) return null;
			return entry.value;
		}),
		put: putSpy,
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
		getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
	} as unknown as KVNamespace;
	return { kv, putSpy };
}

describe('slo-config', () => {
	it('has three burn-rate windows configured', () => {
		expect(BURN_RATE_WINDOWS).toHaveLength(3);
	});

	it('windows are ordered: two pages then one ticket', () => {
		const pages = BURN_RATE_WINDOWS.filter((w) => w.severity === 'page');
		const tickets = BURN_RATE_WINDOWS.filter((w) => w.severity === 'ticket');
		expect(pages).toHaveLength(2);
		expect(tickets).toHaveLength(1);
	});

	it('page burn rates are higher than ticket burn rates', () => {
		const pages = BURN_RATE_WINDOWS.filter((w) => w.severity === 'page');
		const tickets = BURN_RATE_WINDOWS.filter((w) => w.severity === 'ticket');
		for (const p of pages) {
			for (const t of tickets) {
				expect(p.burnRate).toBeGreaterThan(t.burnRate);
			}
		}
	});

	it('short windows are shorter than long windows', () => {
		for (const w of BURN_RATE_WINDOWS) {
			expect(w.shortWindowMinutes).toBeLessThan(w.longWindowMinutes);
		}
	});

	it('default SLO config has sensible values', () => {
		expect(DEFAULT_SLO_CONFIG.errorRateSlo).toBeGreaterThan(0.99);
		expect(DEFAULT_SLO_CONFIG.errorRateSlo).toBeLessThan(1);
		expect(DEFAULT_SLO_CONFIG.latencyP50ThresholdMs).toBeLessThan(DEFAULT_SLO_CONFIG.latencyP90ThresholdMs);
		expect(DEFAULT_SLO_CONFIG.minRequestsPerWindow).toBeGreaterThan(0);
	});
});

describe('dedup', () => {
	let kv: KVNamespace;
	let putSpy: ReturnType<typeof makeKvMock>['putSpy'];

	beforeEach(() => {
		({ kv, putSpy } = makeKvMock());
	});

	it('does not suppress when no prior alert exists', async () => {
		const result = await shouldSuppress(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		expect(result).toBe(false);
	});

	it('suppresses when a prior alert exists', async () => {
		await recordAlertFired(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		const result = await shouldSuppress(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		expect(result).toBe(true);
	});

	it('does not suppress a different dimension', async () => {
		await recordAlertFired(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		const result = await shouldSuppress(kv, 'page', 'error_rate', 'anthropic', 'claude-sonnet-4.5', 'kilo-gateway');
		expect(result).toBe(false);
	});

	it('does not suppress a different client for the same provider:model', async () => {
		await recordAlertFired(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		const result = await shouldSuppress(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'other-client');
		expect(result).toBe(false);
	});

	it('page suppresses ticket for the same dimension', async () => {
		await recordAlertFired(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		const result = await shouldSuppress(kv, 'ticket', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		expect(result).toBe(true);
	});

	it('ticket does not suppress page', async () => {
		await recordAlertFired(kv, 'ticket', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		const result = await shouldSuppress(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		expect(result).toBe(false);
	});

	it('records alert with TTL', async () => {
		await recordAlertFired(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		expect(putSpy).toHaveBeenCalledWith('o11y:alert:page:error_rate:openai:gpt-4:kilo-gateway', expect.any(String), {
			expirationTtl: 15 * 60,
		});
	});

	it('ticket cooldown is 4 hours', async () => {
		await recordAlertFired(kv, 'ticket', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		expect(putSpy).toHaveBeenCalledWith('o11y:alert:ticket:error_rate:openai:gpt-4:kilo-gateway', expect.any(String), {
			expirationTtl: 4 * 60 * 60,
		});
	});

	it('different alert types are independent', async () => {
		await recordAlertFired(kv, 'page', 'error_rate', 'openai', 'gpt-4', 'kilo-gateway');
		const result = await shouldSuppress(kv, 'page', 'latency_p50', 'openai', 'gpt-4', 'kilo-gateway');
		expect(result).toBe(false);
	});
});
