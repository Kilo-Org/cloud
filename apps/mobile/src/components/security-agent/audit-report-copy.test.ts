import { type TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { eventEvidenceLines } from './audit-report-copy';

const t = i18n.t as TFunction;

function auditEvent(overrides: {
  action: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}) {
  return { beforeState: null, afterState: null, metadata: null, ...overrides };
}

describe('eventEvidenceLines', () => {
  it('names the reason a dismissal recorded in its after-state', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.dismissed',
          afterState: { status: 'ignored', reason_code: 'not_used' },
        }),
        t
      )
    ).toEqual(['Reason: Vulnerable code is not used']);
  });

  it('reads the reason from the metadata when the after-state omits it', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.dismissed',
          afterState: { status: 'ignored' },
          metadata: { reason_code: 'inaccurate' },
        }),
        t
      )
    ).toEqual(['Reason: The finding is inaccurate']);
  });

  it('keeps the after-state reason when both record one', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.auto_dismissed',
          afterState: { status: 'ignored', reason_code: 'not_used' },
          metadata: { reason_code: 'inaccurate' },
        }),
        t
      )
    ).toEqual(['Reason: Vulnerable code is not used']);
  });

  it('labels a reason code this app has no copy for', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.auto_dismissed',
          metadata: { reason_code: 'compensating_control' },
        }),
        t
      )
    ).toEqual(['Reason: Unrecognized reason']);
  });

  it('adds the confidence an auto-dismissal recorded', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.auto_dismissed',
          afterState: { status: 'ignored', reason_code: 'not_used' },
          metadata: { reason_code: 'not_used', confidence: 'high' },
        }),
        t
      )
    ).toEqual(['Reason: Vulnerable code is not used', 'Confidence: High']);
  });

  it('ignores a confidence that is not a triage word', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.auto_dismissed',
          afterState: { status: 'ignored', reason_code: 'not_used' },
          metadata: { reason_code: 'not_used', confidence: 'certain' },
        }),
        t
      )
    ).toEqual(['Reason: Vulnerable code is not used']);
  });

  it('names the confidence a finished analysis recorded', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.analysis_completed',
          afterState: { analysis_status: 'completed', confidence: 'medium' },
        }),
        t
      )
    ).toEqual(['Confidence: Medium']);
  });

  it.each([
    ['an analysis without a recorded confidence', 'security.finding.analysis_completed', null],
    ['an action that records no dismissal evidence', 'security.finding.created', null],
  ])('adds no line for %s', (_label, action, metadata) => {
    expect(eventEvidenceLines(auditEvent({ action, metadata }), t)).toEqual([]);
  });

  it('does not describe a status change as a dismissal', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.status_change',
          beforeState: { status: 'open' },
          afterState: { status: 'fixed', reason_code: 'fixed_upstream' },
          metadata: { reason_code: 'fixed_upstream' },
        }),
        t
      )
    ).toEqual(['Status: Open → Fixed']);
  });

  it('names the previous and new status of a status change', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.status_change',
          beforeState: { status: 'open' },
          afterState: { status: 'ignored' },
        }),
        t
      )
    ).toEqual(['Status: Open → Dismissed']);
  });

  it('names the previous and new severity of a severity change', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.severity_changed',
          beforeState: { severity: 'critical' },
          afterState: { severity: 'high' },
        }),
        t
      )
    ).toEqual(['Severity: Critical → High']);
  });

  it.each([
    ['a status change without a recorded previous status', 'security.finding.status_change'],
    ['a status change without a recorded new status', 'security.finding.status_change'],
    ['a severity change without a recorded previous severity', 'security.finding.severity_changed'],
    ['a severity change without a recorded new severity', 'security.finding.severity_changed'],
  ])('leaves the row unchanged for %s', (_label, action) => {
    const valueKey = action === 'security.finding.status_change' ? 'status' : 'severity';
    const known = action === 'security.finding.status_change' ? 'open' : 'critical';

    expect(
      eventEvidenceLines(auditEvent({ action, afterState: { [valueKey]: known } }), t)
    ).toEqual([]);
    expect(
      eventEvidenceLines(auditEvent({ action, beforeState: { [valueKey]: known } }), t)
    ).toEqual([]);
  });

  it('leaves a change the app has no words for unchanged, without the raw code', () => {
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.status_change',
          beforeState: { status: 'open' },
          afterState: { status: 'reopened_by_provider' },
        }),
        t
      )
    ).toEqual([]);
    expect(
      eventEvidenceLines(
        auditEvent({
          action: 'security.finding.severity_changed',
          beforeState: { severity: 'critical' },
          afterState: { severity: 'blocker' },
        }),
        t
      )
    ).toEqual([]);
  });
});
