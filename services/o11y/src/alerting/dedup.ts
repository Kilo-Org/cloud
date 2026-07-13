/**
 * KV-based alert deduplication.
 *
 * Prevents the same alert from firing repeatedly by storing a cooldown
 * marker in KV with a TTL. Higher-severity alerts suppress lower-severity
 * ones for the same dimension.
 */

import type { AlertSeverity } from './slo-config';
import {
  PAGE_COOLDOWN_SECONDS,
  TICKET_COOLDOWN_SECONDS,
  INFO_COOLDOWN_SECONDS,
} from './slo-config';

function alertKey(
  severity: AlertSeverity,
  alertType: string,
  provider: string,
  model: string,
  clientName: string
): string {
  return `o11y:alert:${severity}:${alertType}:${provider}:${model}:${clientName}`;
}

const COOLDOWN_SECONDS: Record<AlertSeverity, number> = {
  page: PAGE_COOLDOWN_SECONDS,
  ticket: TICKET_COOLDOWN_SECONDS,
  info: INFO_COOLDOWN_SECONDS,
};

function cooldownForSeverity(severity: AlertSeverity): number {
  return COOLDOWN_SECONDS[severity];
}

// Higher severities that suppress a given severity for the same dimension.
// Lower severities never suppress higher ones, so an early warning does not
// block escalation (e.g. an info alert at 60% does not suppress a ticket at 80%).
const HIGHER_SEVERITIES: Record<AlertSeverity, AlertSeverity[]> = {
  page: [],
  ticket: ['page'],
  info: ['page', 'ticket'],
};

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
  clientName: string
): Promise<boolean> {
  const key = alertKey(severity, alertType, provider, model, clientName);
  const existing = await kv.get(key);
  if (existing) return true;

  // A higher-severity marker for the same dimension suppresses this alert.
  for (const higher of HIGHER_SEVERITIES[severity]) {
    const higherExisting = await kv.get(alertKey(higher, alertType, provider, model, clientName));
    if (higherExisting) return true;
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
  clientName: string
): Promise<void> {
  const key = alertKey(severity, alertType, provider, model, clientName);
  await kv.put(key, new Date().toISOString(), { expirationTtl: cooldownForSeverity(severity) });
}
