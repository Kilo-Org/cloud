'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import Link from 'next/link';
import { AlertTriangle, Loader2, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useKiloclawInstanceEvents } from '@/app/admin/api/kiloclaw-analytics/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from './shared';

type OrphanRow = {
  id: string;
  user_id: string;
  sandbox_id: string;
  organization_id: string | null;
  created_at: string;
  user_email: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  workerStatusError: string | null;
};

function toDatetimeLocalInput(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm");
}

function toIsoFromDatetimeLocal(value: string): string {
  return new Date(value).toISOString();
}

function TroubleshootingEventsDialog({
  sandboxId,
  open,
  onOpenChange,
}: {
  sandboxId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, error } = useKiloclawInstanceEvents(sandboxId ?? '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-5xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Analytics Troubleshooting</DialogTitle>
          <DialogDescription>
            Recent Analytics Engine lifecycle and reconcile events for `{sandboxId}`.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto">
          {isLoading && (
            <div className="flex items-center gap-2 py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-muted-foreground text-sm">Loading events...</span>
            </div>
          )}

          {error && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {error instanceof Error ? error.message : 'Failed to load Analytics Engine events'}
              </AlertDescription>
            </Alert>
          )}

          {data && data.data.length === 0 && (
            <p className="text-muted-foreground text-sm">No DO or reconcile events found.</p>
          )}

          {data && data.data.length > 0 && (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead>Region</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((row, idx) => (
                    <TableRow key={`${row.timestamp}-${row.event}-${idx}`}>
                      <TableCell className="text-muted-foreground text-xs">
                        {new Date(row.timestamp).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.event}</TableCell>
                      <TableCell className="text-xs">{row.delivery || '—'}</TableCell>
                      <TableCell className="text-xs">{row.status || '—'}</TableCell>
                      <TableCell className="max-w-[280px] text-xs break-words">
                        {row.error || '—'}
                      </TableCell>
                      <TableCell className="text-xs">{row.fly_region || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function KiloclawOrphansTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [createdAfterInput, setCreatedAfterInput] = useState(
    toDatetimeLocalInput(subDays(new Date(), 1))
  );
  const [createdBeforeInput, setCreatedBeforeInput] = useState(toDatetimeLocalInput(new Date()));
  const [scanResult, setScanResult] = useState<{
    orphans: OrphanRow[];
    scanned: number;
    capped: boolean;
  } | null>(null);
  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(null);
  const [destroyTarget, setDestroyTarget] = useState<OrphanRow | null>(null);

  const detectOrphans = useMutation(
    trpc.admin.kiloclawInstances.detectOrphans.mutationOptions({
      onSuccess: result => {
        setScanResult(result);
        toast.success(
          result.orphans.length === 0
            ? `No orphaned instances found across ${result.scanned} checked rows`
            : `Found ${result.orphans.length} orphaned instances across ${result.scanned} checked rows`
        );
      },
      onError: err => {
        toast.error(`Failed to scan for orphans: ${err.message}`);
      },
    })
  );

  const destroyOrphan = useMutation(
    trpc.admin.kiloclawInstances.destroyOrphan.mutationOptions({
      onSuccess: () => {
        toast.success('Orphaned instance destroyed');
        setDestroyTarget(null);
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.stats.queryKey(),
        });
        if (scanResult && destroyTarget) {
          setScanResult({
            ...scanResult,
            orphans: scanResult.orphans.filter(orphan => orphan.id !== destroyTarget.id),
          });
        }
      },
      onError: err => {
        toast.error(`Failed to destroy orphan: ${err.message}`);
      },
    })
  );

  const summary = useMemo(() => {
    return {
      scanned: scanResult?.scanned ?? 0,
      orphanCount: scanResult?.orphans.length ?? 0,
      withStatusErrors: scanResult?.orphans.filter(orphan => orphan.workerStatusError).length ?? 0,
    };
  }, [scanResult]);

  const handleScan = () => {
    if (!createdAfterInput || !createdBeforeInput) {
      toast.error('Please choose both start and end times');
      return;
    }

    const createdAfter = toIsoFromDatetimeLocal(createdAfterInput);
    const createdBefore = toIsoFromDatetimeLocal(createdBeforeInput);
    if (new Date(createdAfter) > new Date(createdBefore)) {
      toast.error('Start time must be before end time');
      return;
    }

    detectOrphans.mutate({ createdAfter, createdBefore });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Orphaned Instance Detector</CardTitle>
          <CardDescription>
            Scan active KiloClaw DB rows in a time window and ask the worker for status. Any row
            whose worker status is null is considered orphaned.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex min-w-[220px] flex-col gap-2">
              <label className="text-sm font-medium">Created After</label>
              <Input
                type="datetime-local"
                value={createdAfterInput}
                onChange={e => setCreatedAfterInput(e.target.value)}
              />
            </div>
            <div className="flex min-w-[220px] flex-col gap-2">
              <label className="text-sm font-medium">Created Before</label>
              <Input
                type="datetime-local"
                value={createdBeforeInput}
                onChange={e => setCreatedBeforeInput(e.target.value)}
              />
            </div>
            <Button onClick={handleScan} disabled={detectOrphans.isPending}>
              {detectOrphans.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Scan
                </>
              )}
            </Button>
          </div>

          {scanResult && (
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Rows Scanned</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{summary.scanned}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Orphans Found</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{summary.orphanCount}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Status Check Errors</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{summary.withStatusErrors}</div>
                </CardContent>
              </Card>
            </div>
          )}

          {scanResult?.capped && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Results capped at 1000 rows. Narrow the date range to scan all matching instances.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detected Orphans</CardTitle>
          <CardDescription>
            Potentially orphaned instances in the scanned range. Review analytics before cleanup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!scanResult ? (
            <p className="text-muted-foreground text-sm">
              Choose a date range and run a scan to inspect recent active instances.
            </p>
          ) : scanResult.orphans.length === 0 ? (
            <p className="text-muted-foreground text-sm">No orphaned instances found.</p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Sandbox ID</TableHead>
                    <TableHead>Subscription</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Status Check</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scanResult.orphans.map(orphan => (
                    <TableRow key={orphan.id}>
                      <TableCell>
                        <Link
                          href={`/admin/users/${encodeURIComponent(orphan.user_id)}`}
                          className="text-blue-600 hover:underline"
                        >
                          {orphan.user_email || orphan.user_id}
                        </Link>
                        <div className="text-muted-foreground font-mono text-xs">{orphan.id}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {orphan.organization_id ? 'Org' : 'Personal'}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{orphan.sandbox_id}</TableCell>
                      <TableCell>
                        {orphan.subscription_status ? (
                          <Badge
                            variant="outline"
                            title={orphan.subscription_id ?? undefined}
                            className={
                              orphan.subscription_status === 'active' ||
                              orphan.subscription_status === 'trialing'
                                ? 'border-amber-500/30 bg-amber-500/15 text-amber-400'
                                : undefined
                            }
                          >
                            {orphan.subscription_status}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell title={new Date(orphan.created_at).toLocaleString()}>
                        {formatRelativeTime(orphan.created_at)}
                      </TableCell>
                      <TableCell>
                        {orphan.workerStatusError ? (
                          <Badge variant="destructive" title={orphan.workerStatusError}>
                            Status check failed
                          </Badge>
                        ) : (
                          <Badge variant="secondary">No DO state</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSelectedSandboxId(orphan.sandbox_id)}
                          >
                            Troubleshoot
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDestroyTarget(orphan)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Destroy
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <TroubleshootingEventsDialog
        sandboxId={selectedSandboxId}
        open={!!selectedSandboxId}
        onOpenChange={open => {
          if (!open) setSelectedSandboxId(null);
        }}
      />

      <AlertDialog open={!!destroyTarget} onOpenChange={open => !open && setDestroyTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Destroy orphaned instance?</AlertDialogTitle>
            <AlertDialogDescription>
              This will soft-delete the DB row for `{destroyTarget?.sandbox_id}`. This action is
              intended for instances with no backing Durable Object.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destroyOrphan.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={destroyOrphan.isPending || !destroyTarget}
              onClick={e => {
                e.preventDefault();
                if (!destroyTarget) return;
                destroyOrphan.mutate({ id: destroyTarget.id });
              }}
            >
              {destroyOrphan.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Destroying...
                </>
              ) : (
                'Destroy orphan'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
