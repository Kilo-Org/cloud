'use client';

import Link from 'next/link';
import { useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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

function parse(value: string | null, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

export function IpClustersTable() {
  const trpc = useTRPC();
  const router = useRouter();
  const search = useSearchParams();
  const threshold = parse(search.get('threshold'), 3);
  const days = parse(search.get('days'), 7);

  const input = useMemo(
    () => ({
      threshold: Math.min(Math.max(threshold, 2), 100),
      days: Math.min(Math.max(days, 1), 90),
      limit: 100,
    }),
    [threshold, days]
  );

  const query = useQuery(trpc.admin.ipClusters.list.queryOptions(input));

  const push = useCallback(
    (next: { threshold?: number; days?: number }) => {
      const params = new URLSearchParams();
      params.set('threshold', String(next.threshold ?? input.threshold));
      params.set('days', String(next.days ?? input.days));
      router.push(`/admin/ip-clusters?${params.toString()}`);
    },
    [input.days, input.threshold, router]
  );

  if (query.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load IP clusters</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {query.error instanceof Error ? query.error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex w-full flex-col gap-y-4">
      <div>
        <h2 className="text-2xl font-bold">IP-to-account clusters</h2>
        <p className="text-muted-foreground mt-2 max-w-3xl">
          Surface IP addresses with unusually high numbers of distinct user accounts in recent
          request usage. Default view shows IPs with 3+ accounts, sorted by account count.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Adjust the cluster sensitivity and recent usage window.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-2">
              <Label htmlFor="threshold">Minimum distinct accounts</Label>
              <Input
                id="threshold"
                type="number"
                min={2}
                max={100}
                value={input.threshold}
                onChange={event => push({ threshold: Number(event.target.value) })}
                className="w-56"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="days">Time window (days)</Label>
              <Input
                id="days"
                type="number"
                min={1}
                max={90}
                value={input.days}
                onChange={event => push({ days: Number(event.target.value) })}
                className="w-40"
              />
            </div>
            <Button variant="outline" onClick={() => push({ threshold: 3, days: 7 })}>
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>IP address</TableHead>
              <TableHead className="text-right">Accounts</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead>Account IDs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-8 text-center">
                  Loading IP clusters...
                </TableCell>
              </TableRow>
            ) : query.data?.clusters.length ? (
              query.data.clusters.map(cluster => (
                <TableRow key={cluster.ip}>
                  <TableCell className="font-mono text-sm">{cluster.ip}</TableCell>
                  <TableCell className="text-right font-medium">
                    {cluster.accountCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {cluster.requestCount.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Collapsible>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="sm" className="px-0">
                          Show {cluster.accountIds.length.toLocaleString()} account
                          {cluster.accountIds.length === 1 ? '' : 's'}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="mt-2 flex max-w-4xl flex-wrap gap-2">
                          {cluster.accountIds.map(id => (
                            <Link
                              key={id}
                              href={`/admin/users/${encodeURIComponent(id)}`}
                              className="bg-muted hover:bg-muted/80 rounded px-2 py-1 font-mono text-xs underline-offset-2 hover:underline"
                            >
                              {id}
                            </Link>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-8 text-center">
                  No IP clusters found for this threshold and time window.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
