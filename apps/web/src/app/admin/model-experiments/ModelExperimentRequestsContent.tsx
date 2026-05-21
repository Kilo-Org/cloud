'use client';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useModelExperimentRequests } from '@/app/admin/api/model-experiments/hooks';

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatNullable(value: string | null): string {
  return value && value.length > 0 ? value : '—';
}

function formatTokens(value: number): string {
  return value.toLocaleString();
}

function formatMicrodollars(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString();
}

function HashCell({ value }: { value: string }) {
  const display = value.length > 18 ? `${value.slice(0, 18)}…` : value;
  return (
    <span className="font-mono text-xs" title={value}>
      {display}
    </span>
  );
}

export function ModelExperimentRequestsContent() {
  const { data, isLoading } = useModelExperimentRequests();
  const rows = data?.items ?? [];

  return (
    <div className="flex w-full flex-col gap-y-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">Experiment Requests</h2>
        <p className="text-muted-foreground text-sm">
          Last 100 requests attributed to model experiments. Prompt bodies stay in R2; this table
          shows attribution, routing, and usage metadata only.
        </p>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="border-border bg-card text-muted-foreground rounded-lg border p-6 text-sm">
          No experiment requests recorded yet.
        </div>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Experiment</TableHead>
                <TableHead>Variant</TableHead>
                <TableHead>Request</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead>Prompt hash</TableHead>
                <TableHead>User / org</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => (
                <TableRow key={row.usageId}>
                  <TableCell className="whitespace-nowrap align-top text-sm">
                    {formatDate(row.createdAt)}
                  </TableCell>
                  <TableCell className="min-w-56 align-top">
                    <div className="font-medium">{row.experimentName}</div>
                    <div className="text-muted-foreground font-mono text-xs">
                      {row.publicModelId}
                    </div>
                    <div className="text-muted-foreground mt-1 font-mono text-xs">
                      {row.experimentId}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-48 align-top">
                    <div className="font-medium">{row.variantLabel}</div>
                    <div className="text-muted-foreground font-mono text-xs">
                      {row.variantVersionId}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-48 align-top">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant="outline">{row.requestKind}</Badge>
                      <Badge variant="secondary">{row.allocationSubject}</Badge>
                      {row.wasTruncated && <Badge variant="destructive">truncated</Badge>}
                    </div>
                    <div className="text-muted-foreground mt-1 text-xs">
                      Client: {formatNullable(row.clientRequestId)}
                    </div>
                    <div className="text-muted-foreground font-mono text-xs">{row.usageId}</div>
                  </TableCell>
                  <TableCell className="min-w-48 align-top text-sm">
                    <div>
                      Tokens: {formatTokens(row.inputTokens)} in / {formatTokens(row.outputTokens)}{' '}
                      out
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Cache: {formatTokens(row.cacheWriteTokens)} write /{' '}
                      {formatTokens(row.cacheHitTokens)} hit
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Cost: {formatMicrodollars(row.costMicrodollars)} µ$ · discount:{' '}
                      {formatMicrodollars(row.cacheDiscountMicrodollars)} µ$
                    </div>
                    {row.hasError && <Badge variant="destructive">error</Badge>}
                  </TableCell>
                  <TableCell className="min-w-44 align-top">
                    <HashCell value={row.requestBodySha256} />
                  </TableCell>
                  <TableCell className="min-w-56 align-top text-xs">
                    <div className="font-mono">{row.userId}</div>
                    <div className="text-muted-foreground font-mono">
                      {formatNullable(row.organizationId)}
                    </div>
                    <div className="text-muted-foreground mt-1">
                      {formatNullable(row.provider)} / {formatNullable(row.inferenceProvider)}
                    </div>
                    <div className="text-muted-foreground font-mono">
                      {formatNullable(row.requestedModel)} → {formatNullable(row.upstreamModel)}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
