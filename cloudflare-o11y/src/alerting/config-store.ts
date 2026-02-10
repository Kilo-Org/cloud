import { z } from 'zod';

const CONFIG_PREFIX = 'o11y:alert-config:';

const alertingConfigInputSchema = z.object({
	model: z.string().trim().min(1),
	enabled: z.boolean(),
	errorRateSlo: z.number().gt(0).lt(1),
	minRequestsPerWindow: z.number().int().positive(),
});

export const AlertingConfigInputSchema = alertingConfigInputSchema;
export const AlertingConfigSchema = alertingConfigInputSchema.extend({
	updatedAt: z.string().min(1),
});

export type AlertingConfig = z.infer<typeof AlertingConfigSchema>;

type AlertingConfigEnv = {
	O11Y_ALERT_CONFIG: KVNamespace;
};

function configKey(model: string): string {
	return `${CONFIG_PREFIX}${encodeURIComponent(model)}`;
}

function parseConfig(raw: string): AlertingConfig | null {
	try {
		const parsed = AlertingConfigSchema.safeParse(JSON.parse(raw));
		if (parsed.success) return parsed.data;
	} catch {
		return null;
	}
	return null;
}

export async function getAlertingConfig(env: AlertingConfigEnv, model: string): Promise<AlertingConfig | null> {
	const raw = await env.O11Y_ALERT_CONFIG.get(configKey(model));
	if (!raw) return null;
	return parseConfig(raw);
}

export async function listAlertingConfigs(env: AlertingConfigEnv): Promise<AlertingConfig[]> {
	const result = await env.O11Y_ALERT_CONFIG.list({ prefix: CONFIG_PREFIX });
	if (result.keys.length === 0) return [];

	const values = await Promise.all(result.keys.map(async (key) => env.O11Y_ALERT_CONFIG.get(key.name)));

	const configs: AlertingConfig[] = [];
	for (const raw of values) {
		if (!raw) continue;
		const config = parseConfig(raw);
		if (config) configs.push(config);
	}

	return configs;
}

export async function upsertAlertingConfig(env: AlertingConfigEnv, config: AlertingConfig): Promise<void> {
	await env.O11Y_ALERT_CONFIG.put(configKey(config.model), JSON.stringify(config));
}

export async function deleteAlertingConfig(env: AlertingConfigEnv, model: string): Promise<void> {
	await env.O11Y_ALERT_CONFIG.delete(configKey(model));
}
