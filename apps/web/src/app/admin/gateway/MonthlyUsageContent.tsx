'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterInputs } from '@trpc/server';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';
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
import { MONTHLY_USAGE_COLUMNS, monthlyUsageToTsv } from './monthly-usage-export';

type MonthlyUsageInput = inferRouterInputs<RootRouter>['admin']['gatewayUsage']['getMonthlyUsage'];

export function MonthlyUsageContent() {
  const trpc = useTRPC();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [model, setModel] = useState('');
  const [submitted, setSubmitted] = useState<MonthlyUsageInput | null>(null);
  const [copying, setCopying] = useState(false);
  const models = useQuery(trpc.models.list.queryOptions());
  const report = useQuery(
    trpc.admin.gatewayUsage.getMonthlyUsage.queryOptions(
      submitted ?? { year: 2000, month: 1, model: '' },
      {
        enabled: submitted !== null,
        staleTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
        trpc: { context: { skipBatch: true } },
      }
    )
  );
  const tsv = report.data ? monthlyUsageToTsv(report.data) : '';

  function runReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (report.isFetching) return;
    const [year, monthNumber] = month.split('-').map(Number);
    const input = { year, month: monthNumber, model: model.trim() };
    if (
      !Number.isInteger(year) ||
      year < 2000 ||
      year > 9999 ||
      !Number.isInteger(monthNumber) ||
      monthNumber < 1 ||
      monthNumber > 12 ||
      !input.model
    ) {
      toast.error('Enter a valid year, month, and model ID.');
      return;
    }
    if (
      submitted?.year === input.year &&
      submitted.month === input.month &&
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
      toast.success('Report copied. Paste it into your spreadsheet.');
    } catch {
      toast.error('Could not copy. Select and copy the tab-separated text below.');
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold">Monthly model usage</h3>
        <p className="text-muted-foreground text-sm">
          PostgreSQL read-replica usage grouped by provider and gateway BYOK. Excludes user BYOK and
          counts logged-in users separately from anonymous users. Queries can take up to 10 minutes,
          or longer if the configured timeout is higher.
        </p>
      </div>
      <form onSubmit={runReport} className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="gateway-usage-month">Year / month (UTC)</Label>
          <Input
            id="gateway-usage-month"
            type="month"
            min="2000-01"
            max="9999-12"
            required
            value={month}
            onChange={event => setMonth(event.target.value)}
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
        <Button type="submit" disabled={report.isFetching || !model.trim() || !month}>
          {report.isFetching && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {report.isFetching ? 'Running report…' : 'Run report'}
        </Button>
      </form>
      <p id="gateway-usage-model-help" className="text-muted-foreground text-xs">
        Choose a suggested model or enter an exact model ID, including historical models.
      </p>
      {report.isFetching && (
        <p role="status" className="text-muted-foreground text-sm">
          Querying the PostgreSQL read replica. Keep this tab open while the report runs.
        </p>
      )}
      {report.error && (
        <p role="alert" className="text-destructive text-sm">
          {report.error.message}. Run the report again to retry.
        </p>
      )}
      {submitted && report.data && !report.isFetching && !report.error && (
        <section className="min-w-0 space-y-4" aria-label="Monthly usage results">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">
                {submitted.year}-{String(submitted.month).padStart(2, '0')} · {submitted.model}
              </p>
              <p className="text-muted-foreground text-xs">
                Costs are in microdollars (1 USD = 1,000,000 microdollars). Null values are shown as
                NULL and copied as empty cells. User counts are distinct within each row, not
                additive.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => void copyReport()}
              disabled={copying || report.data.length === 0}
            >
              <Copy className="size-4" aria-hidden="true" />
              {copying ? 'Copying…' : 'Copy for spreadsheet'}
            </Button>
          </div>
          {report.data.length === 0 ? (
            <p role="status" className="text-muted-foreground py-4 text-sm">
              No usage found for this model and month.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table className="font-mono text-xs whitespace-nowrap">
                  <TableHeader>
                    <TableRow>
                      {MONTHLY_USAGE_COLUMNS.map(column => (
                        <TableHead key={column}>{column}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.data.map(row => (
                      <TableRow key={JSON.stringify([row.provider, row.is_byok])}>
                        {MONTHLY_USAGE_COLUMNS.map(column => (
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
                  rows={Math.min(report.data.length + 1, 10)}
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
