import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const alertConfig = sqliteTable('alert_config', {
	model: text('model').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull(),
	error_rate_slo: real('error_rate_slo').notNull(),
	min_requests_per_window: integer('min_requests_per_window').notNull(),
	updated_at: text('updated_at').notNull(),
});

export const ttfbAlertConfig = sqliteTable('ttfb_alert_config', {
	model: text('model').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull(),
	ttfb_threshold_ms: integer('ttfb_threshold_ms').notNull(),
	ttfb_slo: real('ttfb_slo').notNull(),
	min_requests_per_window: integer('min_requests_per_window').notNull(),
	updated_at: text('updated_at').notNull(),
});
