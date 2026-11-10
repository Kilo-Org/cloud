import type { inferRouterOutputs } from '@trpc/server';
import type { EnkryptUsageOutcome } from '@/lib/request-logs/filters';
import type { RootRouter } from '@/routers/root-router';
import { detectorLabel } from './EnkryptReportSection';
import type { StepTone } from './routing-labels';

type RequestLogsOutputs = inferRouterOutputs<RootRouter>['organizations']['requestLogs'];
export type EnkryptUsageRow = RequestLogsOutputs['listEnkryptUsage'][number];
export type EnkryptRequestDetails = RequestLogsOutputs['getEnkryptRequestDetails'];
export type EnkryptGuardrail = EnkryptUsageRow['guardrail'];

export const OUTCOMES: Record<EnkryptUsageOutcome, { label: string; tone: StepTone }> = {
  allowed: { label: 'Allowed', tone: 'selected' },
  flagged: { label: 'Flagged', tone: 'info' },
  blocked: { label: 'Blocked', tone: 'rejected' },
  error: { label: 'Error', tone: 'deferred' },
};

export const GUARDRAIL_LABELS: Record<EnkryptGuardrail, string> = {
  input: 'Input',
  output: 'Output',
};

export function firedDetectorsLabel(call: EnkryptUsageRow): string | null {
  return call.fired_detectors.length > 0
    ? call.fired_detectors.map(detectorLabel).join(', ')
    : null;
}
