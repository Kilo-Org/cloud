'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  GATEWAY_USAGE_COLUMNS,
  GatewayUsageRangeSchema,
  gatewayUsageToTsv,
  gatewayUsageRangeQueryOptions,
  type GatewayUsageRangeInput,
} from './gateway-usage-report';

export function UsageContent() {
  const trpc = useTRPC();
  const client = useRawTRPCClient();
  const [startDate, setStartDate] = useState(() => `${new Date().toISOString().slice(0, 7)}-01`);
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [model, setModel] = useState('');
  const [submitted, setSubmitted] = useState<GatewayUsageRangeInput | null>(null);
  const [copying, setCopying] = useState(false);
  const models = useQuery(trpc.models.list.queryOptions());
  const report = useQuery(
    gatewayUsageRangeQueryOptions(submitted, (input, signal) =>
      client.admin.gatewayUsage.getHourlyUsage.query(input, {
        signal,
        context: { skipBatch: true },
      })
    )
  );
  const progress = report.data?.progress;
  const isPartial = progress !== undefined && progress.completedHours < progress.totalHours;
  const tsv = report.data ? gatewayUsageToTsv(report.data.rows) : '';

  function runReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (report.isFetching) return;
    const parsed = GatewayUsageRangeSchema.safeParse({ startDate, endDate, model });
    if (!parsed.success) {
      toast.error(
        'Enter valid start and end dates, with the end on or after the start, and a model ID.'
      );
      return;
    }
    const input = parsed.data;
    if (
      submitted?.startDate === input.startDate &&
      submitted.endDate === input.endDate &&
      submitted.model === input.model
    ) {
      void report.refetch();
    } else {
      setSubmitted(input);
    }
  }

  async function copyReport() {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(tsv);
      toast.success(
        isPartial
          ? 'Partial results copied. Only completed hours are included.'
          : 'Report copied. Paste it into your spreadsheet.'
      );
    } catch {
      toast.error('Could not copy. Select and copy the tab-separated text below.');
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold">Model usage</h3>
        <p className="text-muted-foreground text-sm">
          PostgreSQL read-replica usage grouped by UTC hour, provider, and gateway BYOK. Excludes
          user BYOK and counts logged-in users separately from anonymous users. Queries run one hour
          at a time, with a 10-minute timeout per hour. Results appear as each hour completes. Both
          selected dates are included.
        </p>
      </div>
      <form onSubmit={runReport} className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="gateway-usage-start-date">Start date (UTC)</Label>
          <Input
            id="gateway-usage-start-date"
            type="date"
            min="2000-01-01"
            max={endDate || '9999-12-31'}
            required
            value={startDate}
            onChange={event => setStartDate(event.target.value)}
            disabled={report.isFetching}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gateway-usage-end-date">End date (UTC, inclusive)</Label>
          <Input
            id="gateway-usage-end-date"
            type="date"
            min={startDate || '2000-01-01'}
            max="9999-12-31"
            required
            value={endDate}
            onChange={event => setEndDate(event.target.value)}
            disabled={report.isFetching}
          />
        </div>
        <div className="min-w-0 flex-1 basis-80 space-y-2">
          <Label htmlFor="gateway-usage-model">Requested model ID</Label>
          <Input
            id="gateway-usage-model"
            list="gateway-usage-models"
            placeholder="stepfun/step-3.7-flash:free"
            value={model}
            onChange={event => setModel(event.target.value)}
            maxLength={256}
            required
            disabled={report.isFetching}
            aria-describedby="gateway-usage-model-help"
          />
          <datalist id="gateway-usage-models">
            {models.data?.map(option => (
              <option key={option.id} value={option.id} />
            ))}
          </datalist>
        </div>
        <Button
          type="submit"
          disabled={report.isFetching || !model.trim() || !startDate || !endDate}
        >
          {report.isFetching && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {report.isFetching ? 'Running report…' : 'Run report'}
        </Button>
      </form>
      <p id="gateway-usage-model-help" className="text-muted-foreground text-xs">
        Choose a suggested model or enter an exact model ID, including historical models.
      </p>
      {report.isFetching && (
        <p role="status" className="text-muted-foreground text-sm">
          {progress
            ? `Querying ${progress.hourStart}. ${progress.completedHours} of ${progress.totalHours} hours completed. `
            : 'Starting hourly queries. '}
          Keep this tab open while the report runs.
        </p>
      )}
      {report.error && (
        <p role="alert" className="text-destructive text-sm">
          {report.error.message}. Completed hours remain available below. Run the report again to
          restart the range.
        </p>
      )}
      {submitted && report.data && (
        <section className="min-w-0 space-y-4" aria-label="Hourly usage results">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">
                {submitted.startDate} through {submitted.endDate} (UTC) · {submitted.model}
              </p>
              <p className="text-muted-foreground text-xs">
                Costs are in microdollars (1 USD = 1,000,000 microdollars). Null values are shown as
                NULL and copied as empty cells. User counts are distinct within each hourly row and
                must not be summed across hours or providers.
              </p>
              <p role="status" className="text-muted-foreground text-sm">
                {isPartial ? 'Partial results' : 'Complete'} · {report.data.progress.completedHours}{' '}
                of {report.data.progress.totalHours} hours completed
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => void copyReport()}
              disabled={copying || report.data.rows.length === 0}
            >
              <Copy className="size-4" aria-hidden="true" />
              {copying ? 'Copying…' : isPartial ? 'Copy partial results' : 'Copy for spreadsheet'}
            </Button>
          </div>
          {report.data.rows.length === 0 ? (
            <p role="status" className="text-muted-foreground py-4 text-sm">
              {isPartial
                ? 'No usage found in the completed hours yet.'
                : 'No usage found for this model and date range.'}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table className="font-mono text-xs whitespace-nowrap">
                  <TableHeader>
                    <TableRow>
                      {GATEWAY_USAGE_COLUMNS.map(column => (
                        <TableHead key={column}>{column}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.data.rows.map(row => (
                      <TableRow key={JSON.stringify([row.hour_start, row.provider, row.is_byok])}>
                        {GATEWAY_USAGE_COLUMNS.map(column => (
                          <TableCell key={column} className="tabular-nums">
                            {row[column] === null ? 'NULL' : String(row[column])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gateway-usage-tsv">Tab-separated results</Label>
                <Textarea
                  id="gateway-usage-tsv"
                  value={tsv}
                  readOnly
                  rows={Math.min(report.data.rows.length + 1, 10)}
                  onFocus={event => event.currentTarget.select()}
                  className="font-mono text-xs whitespace-pre"
                  aria-label="Tab-separated results ready to copy into a spreadsheet"
                />
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
