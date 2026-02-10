import { z } from 'zod';
import { getAlertConfigDO } from './AlertConfigDO';
import type { AlertConfigDO } from './AlertConfigDO';

const ttfbAlertingConfigInputSchema = z.object({
	model: z.string().trim().min(1),
	enabled: z.boolean(),
	ttfbThresholdMs: z.number().int().positive(),
	ttfbSlo: z.number().gt(0).lt(1),
	minRequestsPerWindow: z.number().int().positive(),
});

export const TtfbAlertingConfigInputSchema = ttfbAlertingConfigInputSchema;
export const TtfbAlertingConfigSchema = ttfbAlertingConfigInputSchema.extend({
	updatedAt: z.string().min(1),
});

export type TtfbAlertingConfig = z.infer<typeof TtfbAlertingConfigSchema>;

type TtfbAlertingConfigEnv = {
	ALERT_CONFIG_DO: DurableObjectNamespace<AlertConfigDO>;
};

export async function listTtfbAlertingConfigs(env: TtfbAlertingConfigEnv): Promise<TtfbAlertingConfig[]> {
	const stub = getAlertConfigDO(env);
	return stub.listTtfb();
}

export async function upsertTtfbAlertingConfig(env: TtfbAlertingConfigEnv, config: TtfbAlertingConfig): Promise<void> {
	const stub = getAlertConfigDO(env);
	await stub.upsertTtfb(config);
}

export async function deleteTtfbAlertingConfig(env: TtfbAlertingConfigEnv, model: string): Promise<void> {
	const stub = getAlertConfigDO(env);
	await stub.removeTtfb(model);
}
