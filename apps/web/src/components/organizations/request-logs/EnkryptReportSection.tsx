import type { EnkryptDetectorId } from '@kilocode/db/schema-types';
import type {
  EnkryptFlaggedTool,
  EnkryptGuardrailReport,
  EnkryptInputScanReport,
  EnkryptOutputGuardrailReport,
  EnkryptOutputScanReport,
  EnkryptToolScanReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import type { ReactNode } from 'react';
import { PII_ENTITY_DETAILS } from '@/components/organizations/guardrails/EnkryptDetectorList';
import { DetailGrid, DetailSection, ToneBadge, yesNo, type DetailItem } from './detail-primitives';
import { detectorLabel } from './enkrypt-usage-labels';
import { ABSENT, formatCount, formatDurationMs } from './format';
import type { StepTone } from './routing-labels';

type Verdict = EnkryptGuardrailReport['verdict'];
type Scan = EnkryptInputScanReport | EnkryptOutputScanReport;
type Settings = NonNullable<EnkryptGuardrailReport['settings']>;
type DetectorSetting = Settings['detectors'][number];

const VERDICTS: Record<Verdict, { label: string; tone: StepTone }> = {
  skip: { label: 'Not gated', tone: 'skipped' },
  allow: { label: 'Allowed', tone: 'selected' },
  fail_open: { label: 'Enkrypt failed, allowed unscanned', tone: 'deferred' },
  block: { label: 'Blocked', tone: 'rejected' },
  unavailable: { label: 'Unavailable', tone: 'deferred' },
};

const DECISIONS: Record<Scan['decision'], { label: string; tone: StepTone }> = {
  allowed: { label: 'Allowed', tone: 'selected' },
  blocked: { label: 'Blocked', tone: 'rejected' },
  error_fail_closed: { label: 'Error, request blocked', tone: 'rejected' },
  error_fail_open: { label: 'Enkrypt failed, allowed unscanned', tone: 'deferred' },
  error_logged: { label: 'Error, logged only', tone: 'deferred' },
  client_aborted: { label: 'Client aborted', tone: 'skipped' },
};

const SKIPPED = { label: 'Not scanned, request blocked', tone: 'skipped' } as const;

const PART_LABELS: Record<Scan['part'], string | null> = {
  tools: 'Tool definitions',
  system: 'System prompt',
  conversation: 'Conversation',
  response: null,
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

function isPartialHit(scan: EnkryptInputScanReport): boolean {
  return (
    scan.verdict_cache === 'hit' &&
    scan.total_units !== undefined &&
    scan.cached_units !== undefined &&
    scan.cached_units < scan.total_units
  );
}

/**
 * Whether text that failed to scan was cached as allowed for a short while, so it is not rescanned
 * until then. `failed_calls_cached` counts calls eligible for that write, so it is `certain` only
 * when the scan wrote entries: a failed write may have been one of theirs, and a skipped one found
 * an existing entry, such as a longer allow or a block. A report without the count is `possible` when
 * a call failed and verdicts were stored. See `isFailedAllow` in the verdict cache.
 */
function storedDespiteError(scan: EnkryptInputScanReport): 'certain' | 'possible' | null {
  if (scan.failed_calls_cached !== undefined) {
    if (scan.failed_calls_cached === 0) return null;
    return scan.verdict_cache_write === 'written' ? 'certain' : 'possible';
  }
  const failed =
    scan.decision === 'error_fail_open' ||
    scan.decision === 'error_logged' ||
    (scan.decision === 'blocked' && scan.error !== null);
  return failed && scan.verdict_cache_write === 'written' ? 'possible' : null;
}

const STORED_DESPITE_ERROR_NOTES = {
  certain: 'Failed text counts as allowed for 5 minutes, then is rescanned.',
  possible: 'Failed text may be cached as allowed until its entry expires.',
};

function verdictCacheItem(scan: EnkryptInputScanReport): DetailItem {
  const lookup = isPartialHit(scan) ? 'Partial hit' : VERDICT_CACHE_LABELS[scan.verdict_cache];
  const stored = scan.verdict_cache_write === 'written';
  return {
    label: 'Verdict cache',
    hint:
      scan.total_units === undefined
        ? 'Hit: at least one unit cached. Stored: new verdicts cached.'
        : 'Hit: every unit cached. Partial hit: some. Stored: new verdicts cached.',
    value:
      storedDespiteError(scan) === 'certain' ? (
        <>
          {lookup},{' '}
          <span className="text-status-warning whitespace-nowrap">stored (failed, 5 min)</span>
        </>
      ) : (
        `${lookup}${stored ? ', stored' : ''}`
      ),
  };
}

function unitsCached(scan: EnkryptInputScanReport): DetailItem[] {
  if (scan.total_units === undefined || scan.cached_units === undefined) return [];
  return [
    {
      label: 'Units cached',
      hint: 'A segment, or a slice of one over 100k characters. Only uncached units are sent.',
      value: `${formatCount(scan.cached_units)} of ${formatCount(scan.total_units)}`,
    },
  ];
}

function flaggedToolName(tool: EnkryptFlaggedTool): string {
  if (tool.kind === 'response_format') return 'Response format';
  return tool.name ?? 'Unnamed tool';
}

function FlaggedTools({ scan }: { scan: EnkryptToolScanReport }) {
  if (scan.flagged_tools.length === 0) return null;
  const more = scan.tools_flagged - scan.flagged_tools.length;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">Flagged tools</span>
      <ul className="flex flex-col gap-1">
        {scan.flagged_tools.map((tool, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="font-mono">{flaggedToolName(tool)}</span>
            {tool.detectors_fired.length > 0 && (
              <span className="text-status-destructive">
                <DetectorList detectors={tool.detectors_fired} />
              </span>
            )}
            {tool.error && <span className="text-status-destructive">{tool.error}</span>}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <span className="text-muted-foreground text-xs">and {formatCount(more)} more</span>
      )}
    </div>
  );
}

function charactersSent(scan: Scan): DetailItem {
  if (scan.part === 'response') {
    return { label: 'Characters sent', value: formatCount(scan.scanned_characters) };
  }
  return {
    label: 'Characters sent',
    hint: 'Includes slice headers and overlaps, so it can exceed the total.',
    value: `${formatCount(scan.scanned_characters)} of ${formatCount(scan.total_characters)}`,
  };
}

function charactersCached(scan: EnkryptInputScanReport): DetailItem {
  const value = `${formatCount(scan.cached_characters)} of ${formatCount(scan.total_characters)}`;
  if (scan.total_units === undefined) {
    return {
      label: 'Characters cached',
      hint: 'Fully cached segments only (older report).',
      value,
    };
  }
  return {
    label: 'Characters cached',
    hint: 'Fully cached segments, plus cached slices of long ones.',
    value,
  };
}

function attempts(scan: Scan): DetailItem {
  return {
    label: 'Attempts',
    hint: 'Enkrypt calls made.',
    value: formatCount(scan.attempts),
  };
}

function callsSkipped(scan: EnkryptInputScanReport): DetailItem[] {
  if (!scan.calls_skipped) return [];
  return [
    {
      label: 'Calls skipped',
      hint: 'Not made, since the request was already blocked. Not cached.',
      value: formatCount(scan.calls_skipped),
    },
  ];
}

/** A part none of whose calls were made, since the request was already blocked. */
function isSkipped(scan: Scan): boolean {
  return (
    scan.part !== 'response' &&
    !!scan.calls_skipped &&
    scan.attempts === 0 &&
    scan.decision === 'allowed'
  );
}

function toolsSummary(scan: EnkryptToolScanReport): string {
  const skipped = scan.tools_total - scan.tools_cached - scan.tools_scanned;
  return [
    `${formatCount(scan.tools_total)} total`,
    `${formatCount(scan.tools_cached)} cached`,
    `${formatCount(scan.tools_scanned)} scanned`,
    ...(skipped > 0 ? [`${formatCount(skipped)} skipped`] : []),
  ].join(', ');
}

function scanItems(scan: Scan): DetailItem[] {
  switch (scan.part) {
    case 'tools':
      return [
        { label: 'Tools', value: toolsSummary(scan) },
        verdictCacheItem(scan),
        ...unitsCached(scan),
        charactersSent(scan),
        charactersCached(scan),
        attempts(scan),
        ...callsSkipped(scan),
      ];
    case 'system':
    case 'conversation':
      return [
        verdictCacheItem(scan),
        ...unitsCached(scan),
        charactersSent(scan),
        charactersCached(scan),
        ...(scan.part === 'conversation'
          ? [
              {
                label: 'Segments fully cached',
                hint: 'Segments with every unit cached. A segment is a message, tool call, or tool result.',
                value: `${formatCount(scan.cached_segments)} of ${formatCount(scan.total_segments)}`,
              },
              { label: 'Attachments omitted', value: formatCount(scan.omitted_attachments) },
            ]
          : []),
        {
          label: 'Calls needed',
          hint:
            scan.calls_skipped === undefined
              ? 'Uncached units, packed into calls of up to 100k characters (older report).'
              : 'One call per uncached unit.',
          value: formatCount(scan.chunks),
        },
        attempts(scan),
        ...callsSkipped(scan),
      ];
    case 'response':
      return [charactersSent(scan), attempts(scan)];
  }
}

/** `failedOpen` hides the scan's note on failed content, which the report's notice already gives. */
function ScanCard({ scan, failedOpen }: { scan: Scan; failedOpen: boolean }) {
  const decision = isSkipped(scan) ? SKIPPED : DECISIONS[scan.decision];
  const part = PART_LABELS[scan.part];
  const stored = scan.part === 'response' || failedOpen ? null : storedDespiteError(scan);
  const storedNote = stored && STORED_DESPITE_ERROR_NOTES[stored];
  return (
    <li className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {scan.scan === 'blocking' ? 'Blocking scan' : 'Log-only scan'}
          {part && <span className="text-muted-foreground font-normal"> · {part}</span>}
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
          ...scanItems(scan),
        ]}
      />
      {scan.part === 'tools' && <FlaggedTools scan={scan} />}
      {scan.error && <p className="text-status-destructive text-xs">{scan.error}</p>}
      {storedNote && <p className="text-status-warning text-xs">{storedNote}</p>}
    </li>
  );
}

type GuardrailReportBodyProps = {
  title: string;
  description: string;
  report: EnkryptGuardrailReport | EnkryptOutputGuardrailReport;
  items?: DetailItem[];
  notice?: ReactNode;
  /** Shown when Enkrypt failed and the guardrail let the content through unscanned. */
  failOpenNotice: string;
};

function GuardrailReportBody({
  title,
  description,
  report,
  items = [],
  notice,
  failOpenNotice,
}: GuardrailReportBodyProps) {
  const { settings, scans } = report;
  const verdictDetails = VERDICTS[report.verdict];
  return (
    <DetailSection title={title} description={description}>
      <DetailGrid
        items={[
          {
            label: 'Verdict',
            value: <ToneBadge tone={verdictDetails.tone}>{verdictDetails.label}</ToneBadge>,
          },
          { label: 'Added latency', value: formatDurationMs(report.added_latency_ms) },
          ...(report.unavailable_reason
            ? [
                {
                  label: 'Unavailable because',
                  value: UNAVAILABLE_REASON_LABELS[report.unavailable_reason],
                },
              ]
            : []),
          ...(settings?.status === 'invalid' ? [{ label: 'Configuration', value: 'Invalid' }] : []),
          ...items,
        ]}
      />
      {report.verdict === 'fail_open' && report.added_latency_ms !== null && (
        <p className="text-status-warning text-xs">{failOpenNotice}</p>
      )}
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
            <ScanCard
              key={`${scan.scan}-${index}`}
              scan={scan}
              failedOpen={report.verdict === 'fail_open'}
            />
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
      description="How the organization's Enkrypt guardrail scanned this request."
      report={report}
      failOpenNotice="Enkrypt failed, so the guardrail failed open: the request was sent without a complete scan. The content that failed is treated as allowed for 5 minutes, then scanned again."
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
      description="How the organization's Enkrypt guardrail scanned the response."
      report={report}
      failOpenNotice="Enkrypt failed, so the guardrail failed open: the response was released without being scanned."
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
