import type { Hono } from 'hono';
import { zodJsonValidator } from '../util/validation';
import { requireAdmin } from '../admin-middleware';
import { AlertingConfigInputSchema, deleteAlertingConfig, listAlertingConfigs, upsertAlertingConfig } from './config-store';
import {
	TtfbAlertingConfigInputSchema,
	deleteTtfbAlertingConfig,
	listTtfbAlertingConfigs,
	upsertTtfbAlertingConfig,
} from './ttfb-config-store';
import { queryErrorRateBaseline, queryTtfbBaseline } from './query';

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
		const config = { ...input, model: input.model.trim(), updatedAt };
		await upsertAlertingConfig(c.env, config);

		return c.json({ success: true, config });
	});

	app.delete('/alerting/config', requireAdmin, async (c) => {
		const model = c.req.query('model')?.trim();
		if (!model || model.length === 0) {
			return c.json({ success: false, error: 'model is required' }, 400);
		}

		await deleteAlertingConfig(c.env, model);
		return c.json({ success: true });
	});

	app.get('/alerting/baseline', requireAdmin, async (c) => {
		const model = c.req.query('model')?.trim();
		if (!model || model.length === 0) {
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

	// --- TTFB alerting config routes ---

	app.get('/alerting/ttfb-config', requireAdmin, async (c) => {
		const configs = await listTtfbAlertingConfigs(c.env);
		return c.json({ success: true, configs });
	});

	app.put('/alerting/ttfb-config', requireAdmin, zodJsonValidator(TtfbAlertingConfigInputSchema), async (c) => {
		const input = c.req.valid('json');
		const updatedAt = new Date().toISOString();
		const config = { ...input, model: input.model.trim(), updatedAt };
		await upsertTtfbAlertingConfig(c.env, config);

		return c.json({ success: true, config });
	});

	app.delete('/alerting/ttfb-config', requireAdmin, async (c) => {
		const model = c.req.query('model')?.trim();
		if (!model || model.length === 0) {
			return c.json({ success: false, error: 'model is required' }, 400);
		}

		await deleteTtfbAlertingConfig(c.env, model);
		return c.json({ success: true });
	});

	app.get('/alerting/ttfb-baseline', requireAdmin, async (c) => {
		const model = c.req.query('model')?.trim();
		if (!model || model.length === 0) {
			return c.json({ success: false, error: 'model is required' }, 400);
		}

		const baseline = await queryTtfbBaseline(model, c.env);

		if (baseline.weighted_total_3d === 0) {
			return c.json({ success: true, baseline: null });
		}

		const response = {
			model,
			p50Ttfb3d: baseline.p50_ttfb_3d,
			p95Ttfb3d: baseline.p95_ttfb_3d,
			p99Ttfb3d: baseline.p99_ttfb_3d,
			requests3d: baseline.weighted_total_3d,
		};

		return c.json({ success: true, baseline: response });
	});
}
