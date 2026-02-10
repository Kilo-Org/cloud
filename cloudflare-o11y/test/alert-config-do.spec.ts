import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { getAlertingConfig, listAlertingConfigs, upsertAlertingConfig, deleteAlertingConfig } from '../src/alerting/config-store';
import type { AlertingConfig } from '../src/alerting/config-store';
import { listTtfbAlertingConfigs, upsertTtfbAlertingConfig, deleteTtfbAlertingConfig } from '../src/alerting/ttfb-config-store';
import type { TtfbAlertingConfig } from '../src/alerting/ttfb-config-store';

function makeConfig(model: string, overrides?: Partial<AlertingConfig>): AlertingConfig {
	return {
		model,
		enabled: true,
		errorRateSlo: 0.05,
		minRequestsPerWindow: 100,
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

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

describe('AlertConfigDO via config-store', () => {
	beforeEach(async () => {
		// Clean up all configs before each test
		const configs = await listAlertingConfigs(env);
		for (const config of configs) {
			await deleteAlertingConfig(env, config.model);
		}
	});

	it('list returns empty array when no configs exist', async () => {
		const configs = await listAlertingConfigs(env);
		expect(configs).toEqual([]);
	});

	it('upsert then get returns the config', async () => {
		const config = makeConfig('openai/gpt-4');
		await upsertAlertingConfig(env, config);

		const result = await getAlertingConfig(env, 'openai/gpt-4');
		expect(result).toEqual(config);
	});

	it('get returns null for non-existent model', async () => {
		const result = await getAlertingConfig(env, 'does-not-exist');
		expect(result).toBeNull();
	});

	it('upsert then list returns the config', async () => {
		const config = makeConfig('anthropic/claude-sonnet-4');
		await upsertAlertingConfig(env, config);

		const configs = await listAlertingConfigs(env);
		expect(configs).toEqual([config]);
	});

	it('list returns configs sorted by model', async () => {
		await upsertAlertingConfig(env, makeConfig('openai/gpt-4'));
		await upsertAlertingConfig(env, makeConfig('anthropic/claude-sonnet-4'));
		await upsertAlertingConfig(env, makeConfig('deepseek/deepseek-r1'));

		const configs = await listAlertingConfigs(env);
		const models = configs.map((c) => c.model);
		expect(models).toEqual(['anthropic/claude-sonnet-4', 'deepseek/deepseek-r1', 'openai/gpt-4']);
	});

	it('upsert replaces existing config for same model', async () => {
		await upsertAlertingConfig(env, makeConfig('openai/gpt-4', { errorRateSlo: 0.05 }));
		await upsertAlertingConfig(env, makeConfig('openai/gpt-4', { errorRateSlo: 0.1 }));

		const result = await getAlertingConfig(env, 'openai/gpt-4');
		expect(result?.errorRateSlo).toBe(0.1);

		const configs = await listAlertingConfigs(env);
		expect(configs).toHaveLength(1);
	});

	it('remove deletes a config', async () => {
		await upsertAlertingConfig(env, makeConfig('openai/gpt-4'));
		await deleteAlertingConfig(env, 'openai/gpt-4');

		const result = await getAlertingConfig(env, 'openai/gpt-4');
		expect(result).toBeNull();

		const configs = await listAlertingConfigs(env);
		expect(configs).toEqual([]);
	});

	it('remove is a no-op for non-existent model', async () => {
		await deleteAlertingConfig(env, 'does-not-exist');
		const configs = await listAlertingConfigs(env);
		expect(configs).toEqual([]);
	});

	it('correctly serializes enabled=false', async () => {
		await upsertAlertingConfig(env, makeConfig('openai/gpt-4', { enabled: false }));

		const result = await getAlertingConfig(env, 'openai/gpt-4');
		expect(result?.enabled).toBe(false);
	});
});

describe('AlertConfigDO TTFB via ttfb-config-store', () => {
	beforeEach(async () => {
		const configs = await listTtfbAlertingConfigs(env);
		for (const config of configs) {
			await deleteTtfbAlertingConfig(env, config.model);
		}
	});

	it('list returns empty array when no configs exist', async () => {
		const configs = await listTtfbAlertingConfigs(env);
		expect(configs).toEqual([]);
	});

	it('upsert then list returns the config', async () => {
		const config = makeTtfbConfig('openai/gpt-4');
		await upsertTtfbAlertingConfig(env, config);

		const configs = await listTtfbAlertingConfigs(env);
		expect(configs).toEqual([config]);
	});

	it('list returns configs sorted by model', async () => {
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('openai/gpt-4'));
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('anthropic/claude-sonnet-4'));
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('deepseek/deepseek-r1'));

		const configs = await listTtfbAlertingConfigs(env);
		const models = configs.map((c) => c.model);
		expect(models).toEqual(['anthropic/claude-sonnet-4', 'deepseek/deepseek-r1', 'openai/gpt-4']);
	});

	it('upsert replaces existing config for same model', async () => {
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('openai/gpt-4', { ttfbThresholdMs: 2000 }));
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('openai/gpt-4', { ttfbThresholdMs: 3000 }));

		const configs = await listTtfbAlertingConfigs(env);
		expect(configs).toHaveLength(1);
		expect(configs[0].ttfbThresholdMs).toBe(3000);
	});

	it('remove deletes a config', async () => {
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('openai/gpt-4'));
		await deleteTtfbAlertingConfig(env, 'openai/gpt-4');

		const configs = await listTtfbAlertingConfigs(env);
		expect(configs).toEqual([]);
	});

	it('remove is a no-op for non-existent model', async () => {
		await deleteTtfbAlertingConfig(env, 'does-not-exist');
		const configs = await listTtfbAlertingConfigs(env);
		expect(configs).toEqual([]);
	});

	it('correctly serializes enabled=false', async () => {
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('openai/gpt-4', { enabled: false }));

		const configs = await listTtfbAlertingConfigs(env);
		expect(configs[0].enabled).toBe(false);
	});

	it('stores ttfbSlo correctly', async () => {
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('openai/gpt-4', { ttfbSlo: 0.99 }));

		const configs = await listTtfbAlertingConfigs(env);
		expect(configs[0].ttfbSlo).toBe(0.99);
	});

	it('TTFB configs are independent from error rate configs', async () => {
		await upsertAlertingConfig(env, makeConfig('openai/gpt-4'));
		await upsertTtfbAlertingConfig(env, makeTtfbConfig('openai/gpt-4'));

		const errorRateConfigs = await listAlertingConfigs(env);
		const ttfbConfigs = await listTtfbAlertingConfigs(env);

		expect(errorRateConfigs).toHaveLength(1);
		expect(ttfbConfigs).toHaveLength(1);

		await deleteTtfbAlertingConfig(env, 'openai/gpt-4');
		expect(await listAlertingConfigs(env)).toHaveLength(1);
		expect(await listTtfbAlertingConfigs(env)).toHaveLength(0);
	});
});
