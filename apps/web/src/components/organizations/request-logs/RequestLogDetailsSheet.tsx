'use client';

import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';
import { apiKindLabel } from '@/lib/api-kind-labels';
import { DetailGrid, DetailSection, yesNo, type DetailItem } from './detail-primitives';
import { EnkryptOutputReportSection, EnkryptReportSection } from './EnkryptReportSection';
import {
  ABSENT,
  formatCount,
  formatDurationMs,
  formatMicrodollarsAsUsd,
  formatRequestTime,
} from './format';
import { RequestSheetFrame } from './RequestSheetFrame';
import { RoutingDecisionFlow } from './RoutingDecisionFlow';
import { gatewayName } from './routing-labels';

type RequestLogsOutputs = inferRouterOutputs<RootRouter>['organizations']['requestLogs'];
export type RequestLogRow = RequestLogsOutputs['list'][number];
export type RequestLogDetails = RequestLogsOutputs['getDetails'];

const METADATA_MESSAGES = {
  'not-found': 'No routing details were recorded for this request.',
  'not-configured': 'Routing details are not available in this environment.',
  unreadable: 'Routing details for this request could not be read.',
} as const;

export function userLabel(user: RequestLogRow['user']): string {
  return user.name || user.email || user.id;
}

export function RequestSummary({
  row,
  details,
}: {
  row: RequestLogRow;
  details?: RequestLogDetails;
}) {
  const request = details?.request;
  const requestedModel = request?.requested_model ?? row.model;
  return (
    <DetailSection title="Request">
      <DetailGrid
        items={[
          copyableItem('Requested model', requestedModel),
          copyableItem('Auto model', request?.auto_model),
          copyableItem('Served model', request?.model),
          { label: 'Provider', value: row.provider ?? ABSENT },
          {
            label: 'Gateway',
            value: (request?.provider ? gatewayName(request.provider) : null) ?? ABSENT,
          },
          { label: 'Cost', value: formatMicrodollarsAsUsd(row.cost_microdollars) },
          { label: 'BYOK', value: yesNo(row.is_user_byok) },
          { label: 'Input tokens', value: formatCount(row.input_tokens) },
          { label: 'Output tokens', value: formatCount(row.output_tokens) },
          { label: 'Cache read tokens', value: formatCount(row.cache_hit_tokens) },
          {
            label: 'Cache write tokens',
            value: request ? formatCount(request.cache_write_tokens) : ABSENT,
          },
          { label: 'Latency', value: formatDurationMs(row.latency_ms) },
          { label: 'Generation time', value: formatDurationMs(row.generation_time_ms) },
          { label: 'Status code', value: request?.status_code ?? ABSENT },
          { label: 'Finish reason', value: request?.finish_reason ?? ABSENT },
          { label: 'Error', value: row.has_error ? 'Yes' : 'No' },
          { label: 'API', value: request?.api_kind ? apiKindLabel(request.api_kind) : ABSENT },
          { label: 'Streamed', value: yesNo(request?.streamed ?? null) },
          { label: 'Requested region', value: request?.inference_region ?? 'Global' },
          { label: 'Feature', value: row.feature ?? ABSENT },
          { label: 'Project', value: row.project_id ?? ABSENT },
          { label: 'Editor', value: request?.editor_name ?? ABSENT },
          { label: 'Mode', value: request?.mode ?? ABSENT },
          copyableItem('Session', request?.session_id),
          copyableItem('Request ID', row.id),
        ]}
      />
    </DetailSection>
  );
}

export function copyableItem(label: string, value: string | null | undefined): DetailItem {
  return value ? { label, value, mono: true, copyValue: value } : { label, value: ABSENT };
}

export function RoutingSections({ metadata }: { metadata: RequestLogDetails['metadata'] }) {
  if (metadata.status !== 'available') {
    return (
      <DetailSection title="Provider selection">
        <p className="text-muted-foreground text-sm">{METADATA_MESSAGES[metadata.status]}</p>
      </DetailSection>
    );
  }
  const { routing } = metadata;
  return (
    <>
      <DetailSection
        title="Provider selection"
        description={
          <>
            The steps Kilo took to choose a provider for{' '}
            <span className="font-mono">{routing.requested_model ?? 'this request'}</span>, in
            order.
          </>
        }
      >
        <RoutingDecisionFlow routing={routing} />
      </DetailSection>
      {routing.enkrypt && <EnkryptReportSection report={routing.enkrypt} />}
      {routing.enkrypt_output && <EnkryptOutputReportSection report={routing.enkrypt_output} />}
    </>
  );
}

function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-label="Loading routing details">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

export function RequestLogDetailsSheet({
  organizationId,
  row,
  onOpenChange,
}: {
  organizationId: string;
  row: RequestLogRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const detailsQuery = useQuery({
    ...trpc.organizations.requestLogs.getDetails.queryOptions({
      organizationId,
      usageId: row?.id ?? '',
    }),
    enabled: row !== null,
    staleTime: Infinity,
  });

  return (
    <RequestSheetFrame
      onOpenChange={onOpenChange}
      content={
        row && {
          title: row.model ?? 'Request',
          description: (
            <>
              {formatRequestTime(row.created_at)} · {userLabel(row.user)}
            </>
          ),
          body: (
            <>
              <RequestSummary row={row} details={detailsQuery.data} />
              {detailsQuery.isPending && <DetailsSkeleton />}
              {detailsQuery.error && (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertDescription>
                    Could not load request details: {detailsQuery.error.message}
                  </AlertDescription>
                </Alert>
              )}
              {detailsQuery.data && <RoutingSections metadata={detailsQuery.data.metadata} />}
            </>
          ),
        }
      }
    />
  );
}
