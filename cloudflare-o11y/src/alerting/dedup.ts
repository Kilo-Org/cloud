/**
 * KV-based alert deduplication.
 *
 * Prevents the same alert from firing repeatedly by storing a cooldown
 * marker in KV with a TTL. Higher-severity alerts suppress lower-severity
 * ones for the same dimension.
 */

import type { AlertSeverity } from './slo-config';
import { PAGE_COOLDOWN_SECONDS, TICKET_COOLDOWN_SECONDS } from './slo-config';

function alertKey(severity: AlertSeverity, alertType: string, provider: string, model: string, clientName: string): string {
	return `o11y:alert:${severity}:${alertType}:${provider}:${model}:${clientName}`;
}

function cooldownForSeverity(severity: AlertSeverity): number {
	return severity === 'page' ? PAGE_COOLDOWN_SECONDS : TICKET_COOLDOWN_SECONDS;
}

/**
 * Check whether an alert should be suppressed.
 *
 * Returns true if the alert should be suppressed (i.e. we already fired
 * recently for this or a higher severity).
 */
export async function shouldSuppress(
	kv: KVNamespace,
	severity: AlertSeverity,
	alertType: string,
	provider: string,
	model: string,
	clientName: string,
): Promise<boolean> {
	const key = alertKey(severity, alertType, provider, model, clientName);
	const existing = await kv.get(key);
	if (existing) return true;

	// If this is a ticket, also check if a page-level alert is active
	// (page suppresses ticket for the same dimension).
	if (severity === 'ticket') {
		const pageKey = alertKey('page', alertType, provider, model, clientName);
		const pageExisting = await kv.get(pageKey);
		if (pageExisting) return true;
	}

	return false;
}

/**
 * Record that an alert was fired, setting the cooldown TTL.
 */
export async function recordAlertFired(
	kv: KVNamespace,
	severity: AlertSeverity,
	alertType: string,
	provider: string,
	model: string,
	clientName: string,
): Promise<void> {
	const key = alertKey(severity, alertType, provider, model, clientName);
	await kv.put(key, new Date().toISOString(), { expirationTtl: cooldownForSeverity(severity) });
}
