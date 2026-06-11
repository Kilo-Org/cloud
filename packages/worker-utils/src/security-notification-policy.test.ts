import { describe, expect, it } from 'vitest';
import { SecuritySeverity } from '@kilocode/db/schema-types';
import {
  DEFAULT_SECURITY_NOTIFICATION_POLICY,
  SecurityNotificationPolicySchema,
  classifySlaNotificationKind,
  getEligibleSlaNotificationKind,
  isOpenFindingEligibleForNewFindingNotification,
  meetsSecurityNotificationSeverityMinimum,
} from './security-notification-policy';

describe('security notification policy', () => {
  it('defaults notification policy fields when absent', () => {
    expect(SecurityNotificationPolicySchema.parse({})).toEqual(
      DEFAULT_SECURITY_NOTIFICATION_POLICY
    );
  });

  it.each([
    [SecuritySeverity.CRITICAL, SecuritySeverity.HIGH, true],
    [SecuritySeverity.HIGH, SecuritySeverity.HIGH, true],
    [SecuritySeverity.MEDIUM, SecuritySeverity.HIGH, false],
    [SecuritySeverity.LOW, SecuritySeverity.LOW, true],
    ['unknown', SecuritySeverity.LOW, false],
    [null, SecuritySeverity.LOW, false],
  ])('compares severity %s against minimum %s', (severity, minimum, expected) => {
    expect(meetsSecurityNotificationSeverityMinimum(severity, minimum)).toBe(expected);
  });

  it('requires first inserted open findings for new-finding notifications', () => {
    expect(
      isOpenFindingEligibleForNewFindingNotification({
        wasInserted: true,
        effectiveStatus: 'open',
        isAgentEnabled: true,
        severity: SecuritySeverity.HIGH,
        minimumSeverity: SecuritySeverity.HIGH,
      })
    ).toBe(true);

    expect(
      isOpenFindingEligibleForNewFindingNotification({
        wasInserted: false,
        effectiveStatus: 'open',
        isAgentEnabled: true,
        severity: SecuritySeverity.CRITICAL,
        minimumSeverity: SecuritySeverity.LOW,
      })
    ).toBe(false);
  });

  it('classifies breach before warning when first evaluation is after SLA deadline', () => {
    expect(
      classifySlaNotificationKind({
        now: '2026-06-11T12:00:00.000Z',
        slaDueAt: '2026-06-11T11:00:00.000Z',
        warningDays: 3,
      })
    ).toBe('sla_breach');
  });

  it('classifies warning only within warning window before deadline', () => {
    expect(
      classifySlaNotificationKind({
        now: '2026-06-09T12:00:00.000Z',
        slaDueAt: '2026-06-11T12:00:00.000Z',
        warningDays: 3,
      })
    ).toBe('sla_warning');

    expect(
      classifySlaNotificationKind({
        now: '2026-06-07T12:00:00.000Z',
        slaDueAt: '2026-06-11T12:00:00.000Z',
        warningDays: 3,
      })
    ).toBeNull();
  });

  it('rejects SLA notifications for disabled policy or non-open findings', () => {
    expect(
      getEligibleSlaNotificationKind({
        status: 'open',
        isAgentEnabled: true,
        slaNotificationsEnabled: false,
        severity: SecuritySeverity.CRITICAL,
        minimumSeverity: SecuritySeverity.HIGH,
        slaDueAt: '2026-06-11T12:00:00.000Z',
        warningDays: 3,
        now: '2026-06-10T12:00:00.000Z',
      })
    ).toBeNull();

    expect(
      getEligibleSlaNotificationKind({
        status: 'fixed',
        isAgentEnabled: true,
        slaNotificationsEnabled: true,
        severity: SecuritySeverity.CRITICAL,
        minimumSeverity: SecuritySeverity.HIGH,
        slaDueAt: '2026-06-11T12:00:00.000Z',
        warningDays: 3,
        now: '2026-06-10T12:00:00.000Z',
      })
    ).toBeNull();
  });
});
