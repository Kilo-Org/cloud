import { type TFunction } from 'i18next';
import { z } from 'zod';

import { DISMISSAL_REASON_LABEL_KEYS } from '@/components/security-agent/dismissal-reason-keys';
import { i18n } from '@/i18n';

// The report keeps only the evidence fields a reader can act on
// (ACTION_EVIDENCE_FIELDS in the API), so each action is described by the
// fields it records.
type AuditReportEventEvidence = {
  action: string;
  afterState: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

// The evidence is JSON the server assembled; decode the two fields this screen
// renders and drop anything else it carries.
const EVIDENCE_SCHEMA = z.object({
  reason_code: z.string().optional(),
  confidence: z.string().optional(),
});

// Only the two actions whose reason is a dismissal reason. A status change or
// a supersession records a code too, but neither explains a dismissal.
const DISMISSAL_EVENT_ACTIONS = {
  'security.finding.dismissed': true,
  'security.finding.auto_dismissed': true,
} satisfies Record<string, true>;

// The triage confidence words; the audit row records the same three codes.
const CONFIDENCE_LABEL_KEYS = {
  high: 'securityAgent.sla.high',
  medium: 'securityAgent.sla.medium',
  low: 'securityAgent.sla.low',
} as const;

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

// Literal keys, never a template: the catalog check scans the source for the
// keys a lookup passes on, and a computed key is invisible to it.
export const SEVERITY_LABEL_KEYS = {
  critical: 'common.critical',
  high: 'securityAgent.sla.high',
  medium: 'securityAgent.sla.medium',
  low: 'securityAgent.sla.low',
  // A finding whose severity the scanner never reported. The SLA policy has no
  // row for it, so reuse the finding-details word.
  unknown: 'common.unknown',
} as const;

function confidenceLine(confidence: string | undefined, t: TFunction): string | null {
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    return null;
  }
  return t('securityAgent.auditReport.eventConfidence', {
    confidence: t(CONFIDENCE_LABEL_KEYS[confidence]),
  });
}

/**
 * The evidence lines an audit event adds under its action label: the
 * dismissal reason for a dismissal, the confidence for an auto-dismiss that
 * met the threshold or for a finished analysis. Every other action has none.
 */
export function eventEvidenceLines(event: AuditReportEventEvidence, t: TFunction): string[] {
  const afterState = EVIDENCE_SCHEMA.safeParse(event.afterState ?? {}).data;
  const metadata = EVIDENCE_SCHEMA.safeParse(event.metadata ?? {}).data;

  if (Object.hasOwn(DISMISSAL_EVENT_ACTIONS, event.action)) {
    const lines: string[] = [];
    const recorded = afterState?.reason_code ?? metadata?.reason_code;
    if (recorded) {
      // A code the app does not know yet still reads as a reason; the recorded
      // code itself stays in the API response, not in translated copy.
      const reasonKey = Object.hasOwn(DISMISSAL_REASON_LABEL_KEYS, recorded)
        ? DISMISSAL_REASON_LABEL_KEYS[recorded as keyof typeof DISMISSAL_REASON_LABEL_KEYS]
        : undefined;
      lines.push(
        t('securityAgent.auditReport.eventReason', {
          reason:
            reasonKey === undefined ? t('securityAgent.auditReport.reasonUnknown') : t(reasonKey),
        })
      );
    }
    // A triage auto-dismiss records the confidence that met the threshold; the
    // sandbox policy path records none.
    const confidence = confidenceLine(metadata?.confidence, t);
    if (confidence !== null) {
      lines.push(confidence);
    }
    return lines;
  }

  if (event.action !== 'security.finding.analysis_completed') {
    return [];
  }
  const confidence = confidenceLine(afterState?.confidence, t);
  return confidence === null ? [] : [confidence];
}

export type SummaryFigureKind = 'findings' | 'events' | 'severity';

type SummaryFigure = {
  kind: SummaryFigureKind;
  value: number;
  displayCount: string;
  label: string;
};

/**
 * The one accessible label a summary figure exposes, so a screen reader hears
 * the count with what it counts. Findings and events inflect with the count; a
 * severity figure is an adjective and takes the interpolated label.
 */
export function summaryCountLabel(figure: SummaryFigure): string {
  if (figure.kind === 'severity') {
    return i18n.t('securityAgent.auditReport.severityCount', {
      displayCount: figure.displayCount,
      label: figure.label,
    });
  }
  if (figure.kind === 'findings') {
    return i18n.t('securityAgent.dashboard.findingsCount', {
      count: figure.value,
      displayCount: figure.displayCount,
    });
  }
  return i18n.t('securityAgent.auditReport.eventsCount', {
    count: figure.value,
    displayCount: figure.displayCount,
  });
}
