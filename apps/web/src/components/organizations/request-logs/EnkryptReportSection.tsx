import type { EnkryptDetectorId } from '@kilocode/db/schema-types';
import type {
  EnkryptGuardrailReport,
  EnkryptOutputGuardrailReport,
  EnkryptScanReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import type { ReactNode } from 'react';
import {
  DETECTOR_DETAILS,
  PII_ENTITY_DETAILS,
} from '@/components/organizations/guardrails/EnkryptDetectorList';
import { DetailGrid, DetailSection, ToneBadge, yesNo, type DetailItem } from './detail-primitives';
import { ABSENT, formatCount, formatDurationMs } from './format';
import type { StepTone } from './routing-labels';

type Verdict = EnkryptGuardrailReport['verdict'];
type Scan = EnkryptScanReport & { verdict_cache_write?: 'written' | 'failed' | 'skipped' };
type Settings = NonNullable<EnkryptGuardrailReport['settings']>;
type DetectorSetting = Settings['detectors'][number];

const VERDICTS: Record<Verdict, { label: string; tone: StepTone }> = {
  skip: { label: 'Not gated', tone: 'skipped' },
  allow: { label: 'Allowed', tone: 'selected' },
  block: { label: 'Blocked', tone: 'rejected' },
  unavailable: { label: 'Unavailable', tone: 'deferred' },
};

const DECISIONS: Record<Scan['decision'], { label: string; tone: StepTone }> = {
  allowed: { label: 'Allowed', tone: 'selected' },
  blocked: { label: 'Blocked', tone: 'rejected' },
  error_fail_closed: { label: 'Error, request blocked', tone: 'rejected' },
  error_logged: { label: 'Error, logged only', tone: 'deferred' },
  client_aborted: { label: 'Client aborted', tone: 'skipped' },
};

const VERDICT_CACHE_LABELS: Record<Scan['verdict_cache'], string> = {
  off: 'Off',
  miss: 'Miss',
  hit: 'Hit',
  error: 'Error',
};

const UNAVAILABLE_REASON_LABELS: Record<
  NonNullable<EnkryptGuardrailReport['unavailable_reason']>,
  string
> = {
  transient: 'Transient error',
  timeout: 'Timed out',
  failed: 'Failed',
};

const NOT_SCANNED_REASON_LABELS: Record<
  NonNullable<EnkryptOutputGuardrailReport['not_scanned_reason']>,
  string
> = {
  invalid_config: 'Invalid configuration',
  output_too_large: 'Response too large',
  held_output_too_large: 'Held-back response too large',
};

function detectorLabel(detector: EnkryptDetectorId): string {
  return DETECTOR_DETAILS[detector].label;
}

function detectorNote(setting: DetectorSetting): string | null {
  if (setting.pii_entities) {
    return setting.pii_entities.map(entity => PII_ENTITY_DETAILS[entity].label).join(', ');
  }
  if (setting.banned_keyword_count !== undefined) {
    return `${setting.banned_keyword_count} keywords`;
  }
  if (setting.topic_count !== undefined) return `${setting.topic_count} topics`;
  if (setting.policy_format === 'rules') return `${setting.policy_rule_count ?? 0} rules`;
  if (setting.policy_format === 'text') return 'Policy text';
  return null;
}

function DetectorList({ detectors }: { detectors: EnkryptDetectorId[] }) {
  if (detectors.length === 0) return <span className="text-muted-foreground">None</span>;
  return <>{detectors.map(detectorLabel).join(', ')}</>;
}

function ScanCard({ scan }: { scan: Scan }) {
  const decision = DECISIONS[scan.decision];
  return (
    <li className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {scan.scan === 'blocking' ? 'Blocking scan' : 'Log-only scan'}
        </span>
        <ToneBadge tone={decision.tone}>{decision.label}</ToneBadge>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {formatDurationMs(scan.latency_ms)}
        </span>
      </div>
      <DetailGrid
        items={[
          { label: 'Detectors', value: <DetectorList detectors={scan.detectors_enabled} /> },
          {
            label: 'Fired',
            value:
              scan.detectors_fired.length > 0 ? (
                <span className="text-status-destructive">
                  <DetectorList detectors={scan.detectors_fired} />
                </span>
              ) : (
                'None'
              ),
          },
          {
            label: 'Verdict cache',
            value: `${VERDICT_CACHE_LABELS[scan.verdict_cache]}${scan.verdict_cache_write === 'written' ? ', stored' : ''}`,
          },
          {
            label: 'Characters scanned',
            value: `${formatCount(scan.scanned_characters)} of ${formatCount(scan.total_characters)}`,
          },
          {
            label: 'Segments cached',
            value: `${formatCount(scan.cached_segments)} of ${formatCount(scan.total_segments)}`,
          },
          {
            label: 'Enkrypt calls',
            value: formatCount(scan.attempts),
          },
        ]}
      />
      {scan.error && <p className="text-status-destructive text-xs">{scan.error}</p>}
    </li>
  );
}

type GuardrailReportBodyProps = {
  title: string;
  description: string;
  verdict: Verdict;
  unavailableReason: EnkryptGuardrailReport['unavailable_reason'];
  addedLatencyMs: number | null;
  settings: Settings | null;
  scans: Scan[];
  items?: DetailItem[];
  notice?: ReactNode;
};

function GuardrailReportBody({
  title,
  description,
  verdict,
  unavailableReason,
  addedLatencyMs,
  settings,
  scans,
  items = [],
  notice,
}: GuardrailReportBodyProps) {
  const verdictDetails = VERDICTS[verdict];
  return (
    <DetailSection title={title} description={description}>
      <DetailGrid
        items={[
          {
            label: 'Verdict',
            value: <ToneBadge tone={verdictDetails.tone}>{verdictDetails.label}</ToneBadge>,
          },
          { label: 'Added latency', value: formatDurationMs(addedLatencyMs) },
          {
            label: 'Scans tool results',
            value: settings ? yesNo(settings.scan_tool_results) : ABSENT,
          },
          ...(unavailableReason
            ? [
                {
                  label: 'Unavailable because',
                  value: UNAVAILABLE_REASON_LABELS[unavailableReason],
                },
              ]
            : []),
          ...(settings?.status === 'invalid' ? [{ label: 'Configuration', value: 'Invalid' }] : []),
          ...items,
        ]}
      />
      {notice}
      {settings && settings.detectors.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Configured detectors</span>
          <ul className="flex flex-col gap-1">
            {settings.detectors.map(setting => {
              const note = detectorNote(setting);
              return (
                <li key={setting.detector} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{detectorLabel(setting.detector)}</span>
                  <ToneBadge tone={setting.action === 'block' ? 'rejected' : 'info'}>
                    {setting.action === 'block' ? 'Blocks' : 'Logs'}
                  </ToneBadge>
                  {note && <span className="text-muted-foreground">{note}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {scans.length > 0 && (
        <ol className="flex flex-col gap-2" aria-label={`${title} scans`}>
          {scans.map((scan, index) => (
            <ScanCard key={`${scan.scan}-${index}`} scan={scan} />
          ))}
        </ol>
      )}
    </DetailSection>
  );
}

export function EnkryptReportSection({ report }: { report: EnkryptGuardrailReport }) {
  return (
    <GuardrailReportBody
      title="Enkrypt input guardrail"
      description="How the organization's Enkrypt guardrail scanned this request. Prompt text is never stored."
      verdict={report.verdict}
      unavailableReason={report.unavailable_reason}
      addedLatencyMs={report.added_latency_ms}
      settings={report.settings}
      scans={report.scans}
      notice={
        report.settings === null && (
          <p className="text-status-destructive text-xs">
            The guardrail could not be prepared, so the request was rejected.
          </p>
        )
      }
    />
  );
}

export function EnkryptOutputReportSection({ report }: { report: EnkryptOutputGuardrailReport }) {
  return (
    <GuardrailReportBody
      title="Enkrypt output guardrail"
      description="How the organization's Enkrypt guardrail scanned the response. Response text is never stored."
      verdict={report.verdict}
      unavailableReason={report.unavailable_reason}
      addedLatencyMs={report.added_latency_ms}
      settings={report.settings}
      scans={report.scans}
      items={[
        { label: 'Held back', value: yesNo(report.held_back) },
        { label: 'Held for', value: formatDurationMs(report.held_ms) },
        {
          label: 'Characters scanned',
          value: report.output_characters === null ? ABSENT : formatCount(report.output_characters),
        },
        ...(report.not_scanned_reason
          ? [
              {
                label: 'Not scanned because',
                value: NOT_SCANNED_REASON_LABELS[report.not_scanned_reason],
              },
            ]
          : []),
      ]}
      notice={
        report.upstream_read_failed && (
          <p className="text-status-destructive text-xs">
            The upstream response could not be read completely.
          </p>
        )
      }
    />
  );
}
