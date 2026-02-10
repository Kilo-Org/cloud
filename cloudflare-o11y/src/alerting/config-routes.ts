import type { Hono } from 'hono';
import { zodJsonValidator } from '../util/validation';
import { requireAdmin } from '../admin-middleware';
import { AlertingConfigInputSchema, deleteAlertingConfig, listAlertingConfigs, upsertAlertingConfig } from './config-store';
import { queryErrorRateBaseline } from './query';

function errorRate(errors: number, total: number): number {
	if (total <= 0) return 0;
	return errors / total;
}

export function registerAlertingConfigRoutes(app: Hono<{ Bindings: Env }>): void {
	app.get('/alerting/config', requireAdmin, async (c) => {
		const configs = await listAlertingConfigs(c.env);
		return c.json({ success: true, configs });
	});

	app.put('/alerting/config', requireAdmin, zodJsonValidator(AlertingConfigInputSchema), async (c) => {
		const input = c.req.valid('json');
		const updatedAt = new Date().toISOString();
		const config = { ...input, updatedAt };
		await upsertAlertingConfig(c.env, config);

		return c.json({ success: true, config });
	});

	app.delete('/alerting/config', requireAdmin, async (c) => {
		const model = c.req.query('model');
		if (!model || model.trim().length === 0) {
			return c.json({ success: false, error: 'model is required' }, 400);
		}

		await deleteAlertingConfig(c.env, model);
		return c.json({ success: true });
	});

	app.get('/alerting/baseline', requireAdmin, async (c) => {
		const model = c.req.query('model');
		if (!model || model.trim().length === 0) {
			return c.json({ success: false, error: 'model is required' }, 400);
		}

		const baseline = await queryErrorRateBaseline(model, c.env);
		if (!baseline) {
			return c.json({ success: true, baseline: null });
		}

		const total1d = Number(baseline.weighted_total_1d || 0);
		const total3d = Number(baseline.weighted_total_3d || 0);
		const total7d = Number(baseline.weighted_total_7d || 0);
		const errors1d = Number(baseline.weighted_errors_1d || 0);
		const errors3d = Number(baseline.weighted_errors_3d || 0);
		const errors7d = Number(baseline.weighted_errors_7d || 0);

		const response = {
			model,
			errorRate1d: errorRate(errors1d, total1d),
			errorRate3d: errorRate(errors3d, total3d),
			errorRate7d: errorRate(errors7d, total7d),
			requests1d: total1d,
			requests3d: total3d,
			requests7d: total7d,
		};

		return c.json({ success: true, baseline: response });
	});
}
