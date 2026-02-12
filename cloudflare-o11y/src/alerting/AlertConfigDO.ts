import { DurableObject } from 'cloudflare:workers';
import type { AlertingConfig } from './config-store';
import type { TtfbAlertingConfig } from './ttfb-config-store';

type AlertConfigRow = {
	model: string;
	enabled: number;
	error_rate_slo: number;
	min_requests_per_window: number;
	updated_at: string;
};

function rowToConfig(row: AlertConfigRow): AlertingConfig {
	return {
		model: row.model,
		enabled: row.enabled === 1,
		errorRateSlo: row.error_rate_slo,
		minRequestsPerWindow: row.min_requests_per_window,
		updatedAt: row.updated_at,
	};
}

type TtfbAlertConfigRow = {
	model: string;
	enabled: number;
	ttfb_threshold_ms: number;
	ttfb_slo: number;
	min_requests_per_window: number;
	updated_at: string;
};

function rowToTtfbConfig(row: TtfbAlertConfigRow): TtfbAlertingConfig {
	return {
		model: row.model,
		enabled: row.enabled === 1,
		ttfbThresholdMs: row.ttfb_threshold_ms,
		ttfbSlo: row.ttfb_slo,
		minRequestsPerWindow: row.min_requests_per_window,
		updatedAt: row.updated_at,
	};
}

/**
 * Durable Object for alert config storage.
 *
 * Replaces KV-backed config to provide strong read-after-write consistency.
 * A single global instance (keyed by "global") holds all alert configs in SQLite.
 */
export class AlertConfigDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS alert_config (
					model TEXT PRIMARY KEY,
					enabled INTEGER NOT NULL,
					error_rate_slo REAL NOT NULL,
					min_requests_per_window INTEGER NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ttfb_alert_config (
					model TEXT PRIMARY KEY,
					enabled INTEGER NOT NULL,
					ttfb_threshold_ms INTEGER NOT NULL,
					ttfb_slo REAL NOT NULL,
					min_requests_per_window INTEGER NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
		});
	}

	// --- Error rate alert config ---

	list(): AlertingConfig[] {
		const rows = this.ctx.storage.sql.exec<AlertConfigRow>('SELECT * FROM alert_config ORDER BY model ASC').toArray();
		return rows.map(rowToConfig);
	}

	get(model: string): AlertingConfig | null {
		const rows = this.ctx.storage.sql.exec<AlertConfigRow>('SELECT * FROM alert_config WHERE model = ?', model).toArray();
		if (rows.length === 0) return null;
		return rowToConfig(rows[0]);
	}

	upsert(config: AlertingConfig): void {
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO alert_config (model, enabled, error_rate_slo, min_requests_per_window, updated_at)
			 VALUES (?, ?, ?, ?, ?)`,
			config.model,
			config.enabled ? 1 : 0,
			config.errorRateSlo,
			config.minRequestsPerWindow,
			config.updatedAt,
		);
	}

	remove(model: string): void {
		this.ctx.storage.sql.exec('DELETE FROM alert_config WHERE model = ?', model);
	}

	// --- TTFB alert config ---

	listTtfb(): TtfbAlertingConfig[] {
		const rows = this.ctx.storage.sql.exec<TtfbAlertConfigRow>('SELECT * FROM ttfb_alert_config ORDER BY model ASC').toArray();
		return rows.map(rowToTtfbConfig);
	}

	getTtfb(model: string): TtfbAlertingConfig | null {
		const rows = this.ctx.storage.sql.exec<TtfbAlertConfigRow>('SELECT * FROM ttfb_alert_config WHERE model = ?', model).toArray();
		if (rows.length === 0) return null;
		return rowToTtfbConfig(rows[0]);
	}

	upsertTtfb(config: TtfbAlertingConfig): void {
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO ttfb_alert_config (model, enabled, ttfb_threshold_ms, ttfb_slo, min_requests_per_window, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			config.model,
			config.enabled ? 1 : 0,
			config.ttfbThresholdMs,
			config.ttfbSlo,
			config.minRequestsPerWindow,
			config.updatedAt,
		);
	}

	removeTtfb(model: string): void {
		this.ctx.storage.sql.exec('DELETE FROM ttfb_alert_config WHERE model = ?', model);
	}
}

type AlertConfigDOEnv = {
	ALERT_CONFIG_DO: DurableObjectNamespace<AlertConfigDO>;
};

export function getAlertConfigDO(env: AlertConfigDOEnv): DurableObjectStub<AlertConfigDO> {
	const id = env.ALERT_CONFIG_DO.idFromName('global');
	return env.ALERT_CONFIG_DO.get(id);
}
