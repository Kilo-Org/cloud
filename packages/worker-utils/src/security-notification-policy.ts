import { SecuritySeverity } from '@kilocode/db/schema-types';
import * as z from 'zod';
import {
  SECURITY_SEVERITIES,
  SECURITY_SEVERITY_RANKS,
  getSecuritySeverityRank,
  type SecuritySeverityRank,
} from './security-severity.js';

export const SECURITY_NOTIFICATION_SEVERITIES = SECURITY_SEVERITIES;

export const SecurityNotificationSeveritySchema = z.enum(SECURITY_NOTIFICATION_SEVERITIES);
export type SecurityNotificationSeverity = z.infer<typeof SecurityNotificationSeveritySchema>;

export const SecurityNotificationWarningDaysSchema = z.number().int().min(1).max(365);

export const DEFAULT_SECURITY_NOTIFICATION_POLICY = {
  sla_enabled: true,
  sla_notifications_enabled: false,
  sla_notification_min_severity: SecuritySeverity.HIGH,
  sla_notification_warning_days: 3,
  new_finding_notifications_enabled: false,
  new_finding_notification_min_severity: SecuritySeverity.HIGH,
} as const satisfies SecurityNotificationPolicy;

export const SecurityNotificationPolicySchema = z.object({
  sla_enabled: z.boolean().default(true),
  sla_notifications_enabled: z.boolean().default(false),
  sla_notification_min_severity: SecurityNotificationSeveritySchema.default(SecuritySeverity.HIGH),
  sla_notification_warning_days: SecurityNotificationWarningDaysSchema.default(3),
  new_finding_notifications_enabled: z.boolean().default(false),
  new_finding_notification_min_severity: SecurityNotificationSeveritySchema.default(
    SecuritySeverity.HIGH
  ),
});

export type SecurityNotificationPolicy = {
  sla_enabled: boolean;
  sla_notifications_enabled: boolean;
  sla_notification_min_severity: SecurityNotificationSeverity;
  sla_notification_warning_days: number;
  new_finding_notifications_enabled: boolean;
  new_finding_notification_min_severity: SecurityNotificationSeverity;
};

export type SlaNotificationKind = 'sla_warning' | 'sla_breach';

export type OpenFindingNotificationParams = {
  wasInserted: boolean;
  effectiveStatus: string;
  isAgentEnabled: boolean;
  newFindingNotificationsEnabled: boolean;
  severity: string | null;
  minimumSeverity: SecurityNotificationSeverity;
  isSuperseded?: boolean;
};

export type SlaNotificationEligibilityParams = {
  status: string;
  isAgentEnabled: boolean;
  slaEnabled: boolean;
  slaNotificationsEnabled: boolean;
  severity: string | null;
  minimumSeverity: SecurityNotificationSeverity;
  slaDueAt: string | Date | null;
  warningDays: number;
  now: string | Date;
  isSuperseded?: boolean;
};

export function getSecurityNotificationSeverityRank(
  severity: string | null
): SecuritySeverityRank | null {
  return getSecuritySeverityRank(severity);
}

export function meetsSecurityNotificationSeverityMinimum(
  severity: string | null,
  minimumSeverity: SecurityNotificationSeverity
): boolean {
  const severityRank = getSecuritySeverityRank(severity);
  if (severityRank === null) return false;
  return severityRank <= SECURITY_SEVERITY_RANKS[minimumSeverity];
}

export function calculateSlaWarningBoundary(slaDueAt: string | Date, warningDays: number): Date {
  const dueAt = slaDueAt instanceof Date ? slaDueAt : new Date(slaDueAt);
  const boundary = new Date(dueAt);
  boundary.setUTCDate(boundary.getUTCDate() - warningDays);
  return boundary;
}

export function classifySlaNotificationKind(params: {
  now: string | Date;
  slaDueAt: string | Date | null;
  warningDays: number;
}): SlaNotificationKind | null {
  if (!params.slaDueAt) return null;
  const now = params.now instanceof Date ? params.now : new Date(params.now);
  const dueAt = params.slaDueAt instanceof Date ? params.slaDueAt : new Date(params.slaDueAt);
  if (Number.isNaN(now.getTime()) || Number.isNaN(dueAt.getTime())) return null;
  if (now.getTime() >= dueAt.getTime()) return 'sla_breach';

  const warningBoundary = calculateSlaWarningBoundary(dueAt, params.warningDays);
  if (now.getTime() >= warningBoundary.getTime()) return 'sla_warning';
  return null;
}

export function isOpenFindingEligibleForNewFindingNotification(
  params: OpenFindingNotificationParams
): boolean {
  return (
    params.wasInserted &&
    params.isAgentEnabled &&
    params.newFindingNotificationsEnabled &&
    params.effectiveStatus === 'open' &&
    !params.isSuperseded &&
    meetsSecurityNotificationSeverityMinimum(params.severity, params.minimumSeverity)
  );
}

export function getEligibleSlaNotificationKind(
  params: SlaNotificationEligibilityParams
): SlaNotificationKind | null {
  if (
    !params.isAgentEnabled ||
    !params.slaEnabled ||
    !params.slaNotificationsEnabled ||
    params.status !== 'open' ||
    params.isSuperseded ||
    !meetsSecurityNotificationSeverityMinimum(params.severity, params.minimumSeverity)
  ) {
    return null;
  }

  return classifySlaNotificationKind({
    now: params.now,
    slaDueAt: params.slaDueAt,
    warningDays: params.warningDays,
  });
}
