'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiKindLabel } from '@/lib/api-kind-labels';
import { useTRPC } from '@/lib/trpc/utils';
import { ABSENT_CELL, DetailGrid, DetailSection, ToneBadge } from './detail-primitives';
import {
  GUARDRAIL_LABELS,
  OUTCOMES,
  firedDetectorsLabel,
  type EnkryptRequestDetails,
  type EnkryptUsageRow,
} from './enkrypt-usage-labels';
import { ABSENT, formatDurationMs, formatMicrodollarsAsUsd, formatRequestTime } from './format';
import { RoutingSections, copyableItem, userLabel } from './RequestLogDetailsSheet';

function requestedModel(call: EnkryptUsageRow, details: EnkryptRequestDetails | undefined) {
  const routing = details?.metadata.status === 'available' ? details.metadata.routing : null;
  return call.model ?? routing?.requested_model ?? null;
}

function RequestSection({
  call,
  details,
}: {
  call: EnkryptUsageRow;
  details: EnkryptRequestDetails | undefined;
}) {
  const inference = details?.inference;
  return (
    <DetailSection
      title="Request"
      description={
        inference === null
          ? 'No inference was recorded for this request, for example because the guardrail blocked it.'
          : undefined
      }
    >
      <DetailGrid
        items={[
          copyableItem('Requested model', requestedModel(call, details)),
          copyableItem('Served model', inference?.model),
          { label: 'Provider', value: inference?.provider ?? ABSENT },
          {
            label: 'Inference cost',
            value: inference ? formatMicrodollarsAsUsd(inference.cost_microdollars) : ABSENT,
          },
          { label: 'API', value: apiKindLabel(call.api_kind) },
          copyableItem('Session', call.session_id),
          copyableItem('Request ID', call.request_id),
        ]}
      />
    </DetailSection>
  );
}

const CALL_COLUMNS = [
  { label: 'Time' },
  { label: 'Guardrail' },
  { label: 'Decision' },
  { label: 'Detectors fired' },
  { label: 'Charged', numeric: true },
  { label: 'Added latency', numeric: true },
] as const;

function CallsSection({ calls, selectedId }: { calls: EnkryptUsageRow[]; selectedId: string }) {
  return (
    <DetailSection
      title="Enkrypt calls"
      description="Every Enkrypt call recorded for this request, oldest first."
    >
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {CALL_COLUMNS.map(column => (
                <TableHead
                  key={column.label}
                  className={
                    'numeric' in column ? 'text-right whitespace-nowrap' : 'whitespace-nowrap'
                  }
                >
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map(call => {
              const outcome = OUTCOMES[call.outcome];
              return (
                <TableRow
                  key={call.id}
                  data-state={call.id === selectedId ? 'selected' : undefined}
                  aria-current={call.id === selectedId ? 'true' : undefined}
                >
                  <TableCell className="whitespace-nowrap tabular-nums" title={call.created_at}>
                    {formatRequestTime(call.created_at)}
                  </TableCell>
                  <TableCell>{GUARDRAIL_LABELS[call.guardrail]}</TableCell>
                  <TableCell>
                    <ToneBadge tone={outcome.tone}>{outcome.label}</ToneBadge>
                  </TableCell>
                  <TableCell>{firedDetectorsLabel(call) ?? ABSENT_CELL}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatMicrodollarsAsUsd(call.charged_microdollars)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatDurationMs(call.added_latency_ms)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </DetailSection>
  );
}

function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-label="Loading request details">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

export function EnkryptRequestSheet({
  organizationId,
  call,
  onOpenChange,
}: {
  organizationId: string;
  call: EnkryptUsageRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const detailsQuery = useQuery({
    ...trpc.organizations.requestLogs.getEnkryptRequestDetails.queryOptions({
      organizationId,
      requestId: call?.request_id ?? '',
    }),
    enabled: call?.request_id != null,
    staleTime: Infinity,
  });
  const details = detailsQuery.data;

  return (
    <Sheet open={call !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        {call && (
          <>
            <SheetHeader className="border-b p-6 pr-12">
              <SheetTitle className="font-mono text-base break-all">
                {requestedModel(call, details) ?? 'Request'}
              </SheetTitle>
              <SheetDescription>
                {formatRequestTime(call.created_at)} · {userLabel(call.user)}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-8 p-6">
              <RequestSection call={call} details={details} />
              {detailsQuery.isPending && <DetailsSkeleton />}
              {detailsQuery.error && (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertDescription>
                    Could not load request details: {detailsQuery.error.message}
                  </AlertDescription>
                </Alert>
              )}
              {details && (
                <>
                  <CallsSection calls={details.calls} selectedId={call.id} />
                  <RoutingSections metadata={details.metadata} />
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
