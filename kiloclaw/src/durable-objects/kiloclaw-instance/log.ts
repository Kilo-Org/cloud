import type { InstanceStatus } from './types';
import {
  ALARM_INTERVAL_RUNNING_MS,
  ALARM_INTERVAL_DESTROYING_MS,
  ALARM_INTERVAL_IDLE_MS,
  ALARM_JITTER_MS,
} from '../../config';

/**
 * Structured reconciliation logging — emits a JSON line tagged for
 * log-based observability.
 */
export function reconcileLog(
  reason: string,
  action: string,
  details: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      tag: 'reconcile',
      reason,
      action,
      ...details,
    })
  );
}

/**
 * Alarm interval for a given instance status.
 */
export function alarmIntervalForStatus(status: InstanceStatus): number {
  switch (status) {
    case 'running':
      return ALARM_INTERVAL_RUNNING_MS;
    case 'destroying':
      return ALARM_INTERVAL_DESTROYING_MS;
    case 'provisioned':
    case 'stopped':
      return ALARM_INTERVAL_IDLE_MS;
  }
}

/**
 * Next alarm time with jitter.
 */
export function nextAlarmTime(status: InstanceStatus): number {
  return Date.now() + alarmIntervalForStatus(status) + Math.random() * ALARM_JITTER_MS;
}
