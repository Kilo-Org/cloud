'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatMicrodollars, formatRelativeTime } from '@/lib/admin-utils';
import { useTRPC } from '@/lib/trpc/utils';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function DecisionBadge({ decision }: { decision: string }) {
  if (decision === 'blocked') return <Badge variant="destructive">blocked</Badge>;
  if (decision === 'allowed') return <Badge variant="new">allowed</Badge>;
  return <Badge variant="beta">{decision}</Badge>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <div className="font-mono text-xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

export function EnkryptGuardrailChargesContent() {
  const trpc = useTRPC();
  const [organizationInput, setOrganizationInput] = useState('');
  const [organizationId, setOrganizationId] = useState<string | undefined>(undefined);
  const { data, isLoading, isFetching, error, refetch } = useQuery(
    trpc.admin.enkryptGuardrailCharges.list.queryOptions({ organizationId, limit: 200 })
  );

  const trimmedInput = organizationInput.trim();
  const inputInvalid = trimmedInput !== '' && !UUID_PATTERN.test(trimmedInput);

  function handleFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inputInvalid) return;
    setOrganizationId(trimmedInput || undefined);
  }

  const summary = data?.summary;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="type-title">Enkrypt Guardrail Charges</h1>
          <p className="text-muted-foreground mt-1 type-body">
            Rows in <code>enkrypt_guardrail_charges</code>: one per Enkrypt guardrail detect call
            billed to an organization. Shows the latest 200 rows; totals cover every matching row.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? 'size-4 animate-spin' : 'size-4'} />
          Refresh
        </Button>
      </div>

      <form className="flex flex-wrap items-end gap-3" onSubmit={handleFilter}>
        <div className="grid gap-2">
          <Label htmlFor="enkrypt-org-filter">Organization ID</Label>
          <Input
            id="enkrypt-org-filter"
            className="w-[calc(36ch+1.5rem)] font-mono"
            placeholder="All organizations"
            value={organizationInput}
            onChange={event => setOrganizationInput(event.target.value)}
            aria-invalid={inputInvalid}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={inputInvalid}>
          Filter
        </Button>
        {organizationId && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setOrganizationInput('');
              setOrganizationId(undefined);
            }}
          >
            Clear
          </Button>
        )}
      </form>

      {error && <p className="text-destructive type-body">{error.message}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <Stat label="Calls" value={summary ? summary.total_calls.toLocaleString() : '—'} />
        <Stat
          label="Allowed / blocked / error"
          value={summary ? `${summary.allowed} / ${summary.blocked} / ${summary.errors}` : '—'}
        />
        <Stat
          label="Enkrypt credits"
          value={
            summary
              ? summary.total_credits.toLocaleString(undefined, { maximumFractionDigits: 2 })
              : '—'
          }
        />
        <Stat
          label="Charged"
          value={summary ? formatMicrodollars(summary.total_charged_microdollars, 4) : '—'}
        />
        <Stat
          label="Avg added latency"
          value={
            summary?.avg_added_latency_ms != null
              ? `${Math.round(summary.avg_added_latency_ms)} ms`
              : '—'
          }
        />
        <Stat
          label="Organizations"
          value={summary ? summary.organizations.toLocaleString() : '—'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Latest charges</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>User</TableHead>
                <TableHead>API</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Charged</TableHead>
                <TableHead className="text-right">Added latency</TableHead>
                <TableHead>Session</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={9} className="text-muted-foreground">
                    Loading charges…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && data?.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-muted-foreground">
                    No guardrail charges yet.
                  </TableCell>
                </TableRow>
              )}
              {data?.rows.map(row => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap" title={row.created_at}>
                    <div>{new Date(row.created_at).toLocaleString()}</div>
                    <div className="text-muted-foreground text-xs">
                      {formatRelativeTime(row.created_at)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/organizations/${encodeURIComponent(row.organization_id)}`}
                      className="hover:underline"
                    >
                      {row.organization_name ?? (
                        <span className="font-mono text-xs">{row.organization_id}</span>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/users/${encodeURIComponent(row.kilo_user_id)}`}
                      className="hover:underline"
                    >
                      {row.user_email ?? (
                        <span className="font-mono text-xs">{row.kilo_user_id}</span>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.api_kind}</TableCell>
                  <TableCell>
                    <DecisionBadge decision={row.decision} />
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.enkrypt_credits_cost ?? '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatMicrodollars(row.charged_microdollars, 4)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.added_latency_ms != null ? `${row.added_latency_ms} ms` : '—'}
                  </TableCell>
                  <TableCell
                    className="max-w-48 truncate font-mono text-xs"
                    title={row.session_id ?? undefined}
                  >
                    {row.session_id ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
