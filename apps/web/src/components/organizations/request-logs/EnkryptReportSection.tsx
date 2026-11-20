import type { EnkryptDetectorId } from '@kilocode/db/schema-types';
import {
  ENKRYPT_GUARDRAIL_TIMEOUT_MS,
  type EnkryptFlaggedTool,
  type EnkryptGuardrailReport,
  type EnkryptInputScanReport,
  type EnkryptOutputGuardrailReport,
  type EnkryptOutputScanReport,
  type EnkryptToolScanReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { Fragment, type ReactNode } from 'react';
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

/** For a scan some of whose calls finished and others failed or were never sent. */
const PARTLY_FAILED_DECISIONS: Partial<
  Record<Scan['decision'], { label: string; tone: StepTone }>
> = {
  error_fail_open: { label: 'Enkrypt partly failed, rest allowed unscanned', tone: 'deferred' },
  error_logged: { label: 'Partly failed, logged only', tone: 'deferred' },
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

function storedValue(scan: EnkryptInputScanReport): ReactNode {
  if (scan.verdict_cache_write !== 'written') return null;
  const failed = storedDespiteError(scan) === 'certain' ? (scan.failed_calls_cached ?? 0) : 0;
  if (scan.calls_cached === undefined) {
    return failed > 0 ? (
      <span className="text-status-warning whitespace-nowrap">stored (failed, 5 min)</span>
    ) : (
      'stored'
    );
  }
  const verdicts = scan.calls_cached > 0 && (
    <span className="whitespace-nowrap">
      {formatCount(scan.calls_cached)} {scan.calls_cached === 1 ? 'verdict' : 'verdicts'}
    </span>
  );
  const failures = failed > 0 && (
    <span className="text-status-warning whitespace-nowrap">
      {formatCount(failed)} failed (5 min)
    </span>
  );
  if (!verdicts && !failures) return 'stored';
  return (
    <>
      stored {verdicts}
      {verdicts && failures && ', '}
      {failures}
    </>
  );
}

function verdictCacheItem(scan: EnkryptInputScanReport): DetailItem {
  const lookup = isPartialHit(scan) ? 'Partial hit' : VERDICT_CACHE_LABELS[scan.verdict_cache];
  const stored = storedValue(scan);
  return {
    label: 'Verdict cache',
    hint:
      scan.total_units === undefined
        ? 'Hit: at least one unit cached. Stored: new verdicts cached.'
        : 'Hit: every unit cached. Partial hit: some. Stored: new verdicts cached, failed calls only for 5 minutes.',
    value: stored ? (
      <>
        {lookup}, {stored}
      </>
    ) : (
      lookup
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
    hint: 'Only calls that were sent. Includes slice headers and overlaps, so it can exceed the total.',
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

function callsMade(scan: Scan): DetailItem {
  return {
    label: 'Calls made',
    hint: 'Enkrypt calls sent.',
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

type CallOutcomes = NonNullable<EnkryptInputScanReport['call_outcomes']>;

function sentCalls(outcomes: CallOutcomes): number {
  return outcomes.allowed + outcomes.flagged + outcomes.blocked + outcomes.failed;
}

/** Whether some calls finished while others failed or were never sent. */
function isPartlyFailed(scan: Scan): boolean {
  if (scan.part === 'response' || !scan.call_outcomes) return false;
  const { allowed, flagged, blocked, failed, not_sent } = scan.call_outcomes;
  return allowed + flagged + blocked > 0 && failed + not_sent > 0;
}

/** Every uncached unit's call and how it ended, in one row. */
function callsBreakdown(scan: EnkryptInputScanReport, outcomes: CallOutcomes): DetailItem {
  const skipped = scan.calls_skipped ?? 0;
  const needed = sentCalls(outcomes) + outcomes.not_sent + skipped;
  const counts = [
    [outcomes.allowed, 'allowed'],
    [outcomes.flagged, 'flagged'],
    [outcomes.blocked, 'blocked'],
    [outcomes.failed, 'failed'],
    [outcomes.not_sent, 'not sent'],
    [skipped, 'skipped'],
  ] as const;
  return {
    label: 'Calls',
    hint: 'One per uncached unit. Failed: sent, but no result, for example cut off by the deadline. Not sent: no time was left, or the client disconnected. Skipped: the request was already blocked.',
    value:
      needed === 0 ? (
        'None needed'
      ) : (
        <>
          {[
            `${formatCount(needed)} needed`,
            ...counts.flatMap(([count, label]) =>
              count > 0 ? [`${formatCount(count)} ${label}`] : []
            ),
          ].map((text, index) => (
            <Fragment key={text}>
              {index > 0 && ' · '}
              <span className="whitespace-nowrap">{text}</span>
            </Fragment>
          ))}
        </>
      ),
  };
}

/** Older reports: what was needed and made, and, where derivable, what was never sent. */
function legacyCallItems(scan: EnkryptInputScanReport): DetailItem[] {
  const notSent =
    scan.part !== 'tools' && scan.calls_skipped !== undefined
      ? scan.chunks - scan.attempts - scan.calls_skipped
      : 0;
  return [
    ...(scan.part === 'tools'
      ? []
      : [
          {
            label: 'Calls needed',
            hint:
              scan.calls_skipped === undefined
                ? 'Uncached units, packed into calls of up to 100k characters (older report).'
                : 'One call per uncached unit.',
            value: formatCount(scan.chunks),
          },
        ]),
    callsMade(scan),
    ...(notSent > 0
      ? [
          {
            label: 'Calls not sent',
            hint: 'No time was left before the deadline, or the client disconnected.',
            value: formatCount(notSent),
          },
        ]
      : []),
    ...callsSkipped(scan),
  ];
}

function callItems(scan: EnkryptInputScanReport): DetailItem[] {
  return scan.call_outcomes ? [callsBreakdown(scan, scan.call_outcomes)] : legacyCallItems(scan);
}

function pluralCalls(count: number, singular: string, plural: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

/** What a timed-out input scan ran out of, and why its calls stopped. */
function timeoutMessage(scan: EnkryptInputScanReport, sharedWithBlocking: boolean): string {
  const deadline = `All of the request's calls share one ${ENKRYPT_GUARDRAIL_TIMEOUT_MS / 1_000} s deadline${
    sharedWithBlocking ? ', and the blocking scan runs first.' : '.'
  }`;
  const outcomes = scan.call_outcomes;
  if (!outcomes || outcomes.failed + outcomes.not_sent === 0) return `Timed out. ${deadline}`;
  const stopped = [
    ...(outcomes.failed > 0 ? [pluralCalls(outcomes.failed, 'call failed', 'calls failed')] : []),
    ...(outcomes.not_sent > 0
      ? [pluralCalls(outcomes.not_sent, 'call was not sent', 'calls were not sent')]
      : []),
  ].join(' and ');
  return `Timed out: ${stopped}. ${deadline}`;
}

function scanError(scan: Scan, sharedWithBlocking: boolean): string | null {
  if (scan.error !== 'timeout' || scan.part === 'response') return scan.error;
  return timeoutMessage(scan, sharedWithBlocking && scan.scan === 'log_only');
}

/** Hidden when no segment was split into slices, so it would repeat the units cached. */
function segmentsFullyCached(
  scan: Extract<EnkryptInputScanReport, { part: 'system' | 'conversation' }>
): DetailItem[] {
  if (scan.total_units === scan.total_segments && scan.cached_units === scan.cached_segments) {
    return [];
  }
  return [
    {
      label: 'Segments fully cached',
      hint: 'Segments with every unit cached. A segment is a message, tool call, or tool result.',
      value: `${formatCount(scan.cached_segments)} of ${formatCount(scan.total_segments)}`,
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
        ...callItems(scan),
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
              ...segmentsFullyCached(scan),
              { label: 'Attachments omitted', value: formatCount(scan.omitted_attachments) },
            ]
          : []),
        ...callItems(scan),
      ];
    case 'response':
      return [charactersSent(scan), callsMade(scan)];
  }
}

function scanDecision(scan: Scan): { label: string; tone: StepTone } {
  if (isSkipped(scan)) return SKIPPED;
  return (
    (isPartlyFailed(scan) && PARTLY_FAILED_DECISIONS[scan.decision]) || DECISIONS[scan.decision]
  );
}

/**
 * `failedOpen` hides the scan's note on failed content, which the report's notice already gives.
 * `sharedWithBlocking` says the request's blocking scan ran first, within the same deadline.
 */
function ScanCard({
  scan,
  failedOpen,
  sharedWithBlocking,
}: {
  scan: Scan;
  failedOpen: boolean;
  sharedWithBlocking: boolean;
}) {
  const decision = scanDecision(scan);
  const error = scanError(scan, sharedWithBlocking);
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
      {error && <p className="text-status-destructive text-xs">{error}</p>}
      {storedNote && <p className="text-status-warning text-xs">{storedNote}</p>}
    </li>
  );
}

/** Detectors that only log add no latency, so the report holds how long their scan ran instead. */
function addedLatency(report: EnkryptGuardrailReport | EnkryptOutputGuardrailReport): DetailItem {
  const value = formatDurationMs(report.added_latency_ms);
  const detectors = report.settings?.detectors ?? [];
  const logOnly = detectors.length > 0 && detectors.every(detector => detector.action === 'log');
  if (!logOnly) return { label: 'Added latency', value };
  return {
    label: 'Log-only scan time',
    hint: 'Log-only detectors add no latency. How long their scan ran after the point where a blocking scan would wait. Older reports show the actual wait instead: about 0 ms, or none.',
    value,
  };
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
          addedLatency(report),
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
              sharedWithBlocking={!!settings?.detectors.some(each => each.action === 'block')}
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
