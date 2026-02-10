import { z } from 'zod';
import { getAlertConfigDO } from './AlertConfigDO';
import type { AlertConfigDO } from './AlertConfigDO';

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
	ALERT_CONFIG_DO: DurableObjectNamespace<AlertConfigDO>;
};

export async function getAlertingConfig(env: AlertingConfigEnv, model: string): Promise<AlertingConfig | null> {
	const stub = getAlertConfigDO(env);
	return stub.get(model);
}

export async function listAlertingConfigs(env: AlertingConfigEnv): Promise<AlertingConfig[]> {
	const stub = getAlertConfigDO(env);
	return stub.list();
}

export async function upsertAlertingConfig(env: AlertingConfigEnv, config: AlertingConfig): Promise<void> {
	const stub = getAlertConfigDO(env);
	await stub.upsert(config);
}

export async function deleteAlertingConfig(env: AlertingConfigEnv, model: string): Promise<void> {
	const stub = getAlertConfigDO(env);
	await stub.remove(model);
}
