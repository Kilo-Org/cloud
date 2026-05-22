'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import Link from 'next/link';
import { AlertTriangle, HardDrive, Loader2, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useKiloclawInstanceEvents } from '@/app/admin/api/kiloclaw-analytics/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
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
import type { OrphanVolumeClassification } from '@/lib/kiloclaw/orphan-volume';
import { EventLabelCell, formatRelativeTime } from './shared';

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
                    <TableHead>Attribution / Label</TableHead>
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
                      <TableCell className="min-w-[180px]">
                        <EventLabelCell event={row.event} label={row.label} />
                      </TableCell>
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

type OrphanVolumeRow = {
  instance_id: string;
  user_id: string;
  user_email: string | null;
  sandbox_id: string;
  organization_id: string | null;
  destroyed_at: string;
  subscription_status: string | null;
  fly_app: string;
  volume_id: string;
  volume_name: string;
  volume_state: string;
  volume_region: string;
  volume_size_gb: number;
  attached_machine_id: string | null;
  volume_created_at: string;
  do_status: string | null;
  classification: OrphanVolumeClassification;
};

type OrphanVolumeScanErrorRow = {
  instance_id: string;
  user_id: string;
  user_email: string | null;
  sandbox_id: string;
  error: string;
};

type OrphanVolumeScanResult = {
  volumes: OrphanVolumeRow[];
  errors: OrphanVolumeScanErrorRow[];
  scanned: number;
  capped: boolean;
  nextCursor: { destroyedAt: string; id: string } | null;
};

/** Human-readable label + visual tone for each volume classification. */
const VOLUME_CLASSIFICATION_DISPLAY: Record<
  OrphanVolumeClassification,
  { label: string; tone: 'safe' | 'warn' | 'danger' | 'muted'; help: string }
> = {
  safe_destroy: {
    label: 'Safe to destroy',
    tone: 'safe',
    help: 'Unattached, no live DO, subscription inactive, past the 7-day grace period.',
  },
  fly_reaping: {
    label: 'Fly is reaping',
    tone: 'muted',
    help: 'Volume is already in a pending_destroy / destroying state — Fly will remove it.',
  },
  attached: {
    label: 'Attached to machine',
    tone: 'danger',
    help: 'Volume still backs a machine. Destroy the machine first (force-destroy flow).',
  },
  do_tracked: {
    label: 'Live DO references it',
    tone: 'danger',
    help: 'A live Durable Object still tracks this volume ID. Resolve the DO state first.',
  },
  do_alive: {
    label: 'DO still alive',
    tone: 'warn',
    help: 'The instance is destroyed in the DB but its Durable Object is still alive. Investigate.',
  },
  do_check_failed: {
    label: 'DO state unknown',
    tone: 'danger',
    help: 'Could not confirm Durable Object state — refusing to classify as safe.',
  },
  subscription_active: {
    label: 'Active subscription',
    tone: 'warn',
    help: 'User still has an access-granting subscription — data preserved.',
  },
  destruction_scheduled: {
    label: 'Destruction scheduled',
    tone: 'muted',
    help: 'A billing destruction deadline is still pending — the lifecycle reaper will reap this instance and its volume. Only a true orphan if that reaper fails.',
  },
  within_grace: {
    label: 'Within 7-day grace',
    tone: 'muted',
    help: 'Instance was destroyed less than 7 days ago. Recheck after the grace period.',
  },
};

function VolumeClassificationBadge({
  classification,
}: {
  classification: OrphanVolumeClassification;
}) {
  const { label, tone, help } = VOLUME_CLASSIFICATION_DISPLAY[classification];
  const className =
    tone === 'safe'
      ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400'
      : tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/15 text-amber-400'
        : tone === 'danger'
          ? 'border-red-500/30 bg-red-500/15 text-red-400'
          : undefined;
  return (
    <Badge variant="outline" className={className} title={help}>
      {label}
    </Badge>
  );
}

function OrphanVolumesSection() {
  const trpc = useTRPC();

  const [destroyedAfterInput, setDestroyedAfterInput] = useState(
    toDatetimeLocalInput(subDays(new Date(), 90))
  );
  const [destroyedBeforeInput, setDestroyedBeforeInput] = useState(
    toDatetimeLocalInput(new Date())
  );
  const [scanWindow, setScanWindow] = useState<{
    destroyedAfter: string;
    destroyedBefore: string;
  } | null>(null);
  const [scanResult, setScanResult] = useState<OrphanVolumeScanResult | null>(null);
  const [destroyTarget, setDestroyTarget] = useState<OrphanVolumeRow | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [selectedVolumeIds, setSelectedVolumeIds] = useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [isContinuingScan, setIsContinuingScan] = useState(false);

  const findOrphanVolumes = useMutation(
    trpc.admin.kiloclawInstances.findOrphanVolumes.mutationOptions({
      onSuccess: (result, variables) => {
        if (variables.cursor) {
          setScanResult(current => {
            if (!current) return result;
            const volumesById = new Map(current.volumes.map(volume => [volume.volume_id, volume]));
            for (const volume of result.volumes) {
              volumesById.set(volume.volume_id, volume);
            }
            return {
              volumes: [...volumesById.values()],
              errors: [...current.errors, ...result.errors],
              scanned: current.scanned + result.scanned,
              capped: result.capped,
              nextCursor: result.nextCursor,
            };
          });
          toast.success(
            `Scanned ${result.scanned} more destroyed instance(s) — ${result.volumes.length} additional orphan volume(s) found`
          );
        } else {
          setScanResult(result);
          setScanWindow({
            destroyedAfter: variables.destroyedAfter,
            destroyedBefore: variables.destroyedBefore,
          });
          setSelectedVolumeIds(new Set());
          toast.success(
            `Scanned ${result.scanned} destroyed instance(s) — ${result.volumes.length} orphan volume(s) found`
          );
        }
      },
      onSettled: () => {
        setIsContinuingScan(false);
      },
      onError: err => {
        toast.error(`Failed to scan for orphan volumes: ${err.message}`);
      },
    })
  );

  const scanInProgress = findOrphanVolumes.isPending;

  const destroyOrphanVolume = useMutation(
    trpc.admin.kiloclawInstances.destroyOrphanVolume.mutationOptions({
      onSuccess: (result, variables) => {
        toast.success(
          result.alreadyGone
            ? 'Volume was already gone — removed from the list'
            : 'Orphan volume destroyed'
        );
        setScanResult(current =>
          current
            ? {
                ...current,
                volumes: current.volumes.filter(volume => volume.volume_id !== variables.volumeId),
              }
            : current
        );
        setDestroyTarget(null);
      },
      onError: err => {
        toast.error(`Failed to destroy volume: ${err.message}`);
      },
    })
  );

  // A separate handle on the same procedure for the multi-select flow: it
  // carries no per-call toast, so `handleBulkDestroy` can drive aggregate
  // progress and a single summary toast. Every call still runs the identical
  // fully-guarded destroyOrphanVolume procedure.
  const bulkDestroyVolume = useMutation(
    trpc.admin.kiloclawInstances.destroyOrphanVolume.mutationOptions()
  );

  const summary = useMemo(
    () => ({
      scanned: scanResult?.scanned ?? 0,
      total: scanResult?.volumes.length ?? 0,
      errors: scanResult?.errors.length ?? 0,
    }),
    [scanResult]
  );

  const selectedRows = useMemo(
    () => scanResult?.volumes.filter(v => selectedVolumeIds.has(v.volume_id)) ?? [],
    [scanResult, selectedVolumeIds]
  );

  const bulkInProgress = bulkProgress !== null;

  const handleScan = () => {
    if (!destroyedAfterInput || !destroyedBeforeInput) {
      toast.error('Please choose both start and end times');
      return;
    }
    const destroyedAfter = toIsoFromDatetimeLocal(destroyedAfterInput);
    const destroyedBefore = toIsoFromDatetimeLocal(destroyedBeforeInput);
    if (new Date(destroyedAfter) > new Date(destroyedBefore)) {
      toast.error('Start time must be before end time');
      return;
    }
    findOrphanVolumes.mutate({ destroyedAfter, destroyedBefore });
  };

  const handleContinueScan = () => {
    if (!scanResult?.nextCursor || !scanWindow) return;
    setIsContinuingScan(true);
    findOrphanVolumes.mutate({
      destroyedAfter: scanWindow.destroyedAfter,
      destroyedBefore: scanWindow.destroyedBefore,
      cursor: scanResult.nextCursor,
    });
  };

  const toggleVolume = (volumeId: string) => {
    setSelectedVolumeIds(current => {
      const next = new Set(current);
      if (next.has(volumeId)) {
        next.delete(volumeId);
      } else {
        next.add(volumeId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    const rows = scanResult?.volumes ?? [];
    setSelectedVolumeIds(
      selectedRows.length === rows.length && rows.length > 0
        ? new Set()
        : new Set(rows.map(v => v.volume_id))
    );
  };

  const handleBulkDestroy = async () => {
    setBulkConfirmOpen(false);
    const targets = selectedRows;
    if (targets.length === 0) return;
    setBulkProgress({ done: 0, total: targets.length });
    let succeeded = 0;
    const failed: string[] = [];
    // Sequential: one fully-guarded destroy at a time, so progress is
    // accurate and the worker / Fly API are never hammered.
    for (const volume of targets) {
      try {
        await bulkDestroyVolume.mutateAsync({
          instanceId: volume.instance_id,
          volumeId: volume.volume_id,
        });
        succeeded += 1;
        setScanResult(current =>
          current
            ? {
                ...current,
                volumes: current.volumes.filter(v => v.volume_id !== volume.volume_id),
              }
            : current
        );
      } catch {
        failed.push(volume.volume_id);
      }
      setBulkProgress(current => (current ? { ...current, done: current.done + 1 } : current));
    }
    setBulkProgress(null);
    setSelectedVolumeIds(new Set());
    if (failed.length === 0) {
      toast.success(`Destroyed ${succeeded} orphan volume(s)`);
    } else {
      toast.error(
        `Destroyed ${succeeded} of ${targets.length}; ${failed.length} failed — re-scan and retry`
      );
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Leftover Volume Cleanup
          </CardTitle>
          <CardDescription>
            Scan destroyed KiloClaw instances for the Fly volumes they left behind. The results list
            only confirmed orphans: unattached, no live Durable Object, no access-granting
            subscription, and destroyed more than 7 days ago. Anything that fails a check is
            excluded; instances that could not be fully scanned are reported separately.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex min-w-[220px] flex-col gap-2">
              <label htmlFor="orphan-volumes-destroyed-after" className="text-sm font-medium">
                Destroyed After
              </label>
              <Input
                id="orphan-volumes-destroyed-after"
                type="datetime-local"
                value={destroyedAfterInput}
                onChange={e => setDestroyedAfterInput(e.target.value)}
              />
            </div>
            <div className="flex min-w-[220px] flex-col gap-2">
              <label htmlFor="orphan-volumes-destroyed-before" className="text-sm font-medium">
                Destroyed Before
              </label>
              <Input
                id="orphan-volumes-destroyed-before"
                type="datetime-local"
                value={destroyedBeforeInput}
                onChange={e => setDestroyedBeforeInput(e.target.value)}
              />
            </div>
            <Button onClick={handleScan} disabled={scanInProgress || bulkInProgress}>
              {scanInProgress && !isContinuingScan ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Scan Volumes
                </>
              )}
            </Button>
          </div>

          {scanResult && (
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Instances Scanned</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{summary.scanned}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Orphan Volumes</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-emerald-400">{summary.total}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Scan Errors</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{summary.errors}</div>
                </CardContent>
              </Card>
            </div>
          )}

          {scanResult?.nextCursor && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    This batch was capped at 500 instances. Continue scanning older destroyed
                    instances in the same date window to check the full range.
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleContinueScan}
                    disabled={scanInProgress || bulkInProgress}
                  >
                    {scanInProgress && isContinuingScan ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Scanning older...
                      </>
                    ) : (
                      'Continue older'
                    )}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {scanResult && scanResult.errors.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="flex flex-col gap-2">
                  <span>
                    {scanResult.errors.length} instance(s) could not be fully scanned — their
                    volumes are <span className="font-medium">not</span> shown below, so treat this
                    scan as incomplete.
                  </span>
                  <button
                    type="button"
                    className="self-start text-xs underline"
                    onClick={() => setShowErrors(v => !v)}
                  >
                    {showErrors ? 'Hide details' : 'Show details'}
                  </button>
                  {showErrors && (
                    <ul className="flex flex-col gap-1">
                      {scanResult.errors.map(err => (
                        <li key={err.instance_id} className="font-mono text-xs">
                          {err.user_email || err.user_id} / {err.sandbox_id}: {err.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Orphan Volumes</CardTitle>
              <CardDescription>
                Confirmed orphan volumes for destroyed instances. Select rows to destroy in bulk, or
                use the per-row action. Each volume is re-verified by the worker immediately before
                deletion.
              </CardDescription>
            </div>
            {selectedRows.length > 0 && (
              <Button
                variant="destructive"
                onClick={() => setBulkConfirmOpen(true)}
                disabled={bulkInProgress || scanInProgress}
              >
                {bulkInProgress ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Destroying {bulkProgress?.done ?? 0} / {bulkProgress?.total ?? 0}...
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Destroy selected ({selectedRows.length})
                  </>
                )}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!scanResult ? (
            <p className="text-muted-foreground text-sm">
              Choose a date range and run a scan to inspect destroyed instances.
            </p>
          ) : scanResult.volumes.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No orphan volumes found for destroyed instances in this window.
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="Select all orphan volumes"
                        disabled={bulkInProgress || scanInProgress}
                        checked={
                          selectedRows.length === 0
                            ? false
                            : selectedRows.length === scanResult.volumes.length
                              ? true
                              : 'indeterminate'
                        }
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Fly App / Volume</TableHead>
                    <TableHead>Region / Size</TableHead>
                    <TableHead>Volume State</TableHead>
                    <TableHead>DO Status</TableHead>
                    <TableHead>Destroyed</TableHead>
                    <TableHead>Subscription</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scanResult.volumes.map(volume => (
                    <TableRow key={volume.volume_id}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Select volume ${volume.volume_id}`}
                          disabled={bulkInProgress || scanInProgress}
                          checked={selectedVolumeIds.has(volume.volume_id)}
                          onCheckedChange={() => toggleVolume(volume.volume_id)}
                        />
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/admin/users/${encodeURIComponent(volume.user_id)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          {volume.user_email || volume.user_id}
                        </Link>
                        <div className="text-muted-foreground font-mono text-xs">
                          {volume.sandbox_id}
                        </div>
                      </TableCell>
                      <TableCell>
                        <a
                          href={`https://fly.io/apps/${volume.fly_app}/volumes`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-blue-600 hover:underline"
                        >
                          {volume.fly_app}
                        </a>
                        <div className="text-muted-foreground font-mono text-xs">
                          {volume.volume_id}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {volume.volume_region} / {volume.volume_size_gb} GB
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {volume.volume_state}
                        </Badge>
                        {volume.attached_machine_id && (
                          <div className="text-muted-foreground mt-1 font-mono text-xs">
                            → {volume.attached_machine_id}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{volume.do_status ?? 'finalized'}</TableCell>
                      <TableCell title={new Date(volume.destroyed_at).toLocaleString()}>
                        {formatRelativeTime(volume.destroyed_at)}
                      </TableCell>
                      <TableCell>
                        {volume.subscription_status ? (
                          <Badge
                            variant="outline"
                            title="Subscription attached to this destroyed instance. The access check also considers successor subscriptions in the same context."
                            className={
                              volume.subscription_status === 'active' ||
                              volume.subscription_status === 'trialing'
                                ? 'border-amber-500/30 bg-amber-500/15 text-amber-400'
                                : undefined
                            }
                          >
                            {volume.subscription_status}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <VolumeClassificationBadge classification={volume.classification} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={bulkInProgress || scanInProgress}
                          onClick={() => setDestroyTarget(volume)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Destroy
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!destroyTarget} onOpenChange={open => !open && setDestroyTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Destroy orphan volume?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                <span>
                  This permanently deletes Fly volume{' '}
                  <span className="font-mono">{destroyTarget?.volume_id}</span> (
                  {destroyTarget?.volume_size_gb} GB in {destroyTarget?.volume_region}) from app{' '}
                  <span className="font-mono">{destroyTarget?.fly_app}</span>.
                </span>
                <span>
                  Owner: {destroyTarget?.user_email || destroyTarget?.user_id}. The worker
                  re-verifies the volume name, state, and Durable Object references before deleting.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destroyOrphanVolume.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={destroyOrphanVolume.isPending || !destroyTarget}
              onClick={e => {
                e.preventDefault();
                if (!destroyTarget) return;
                destroyOrphanVolume.mutate({
                  instanceId: destroyTarget.instance_id,
                  volumeId: destroyTarget.volume_id,
                });
              }}
            >
              {destroyOrphanVolume.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Destroying...
                </>
              ) : (
                'Destroy volume'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkConfirmOpen} onOpenChange={open => !open && setBulkConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Destroy {selectedRows.length} orphan volume(s)?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                <span>
                  This permanently deletes {selectedRows.length} Fly volume(s) across the selected
                  destroyed instances.
                </span>
                <span>
                  They are destroyed one at a time. The worker re-verifies each volume&apos;s name,
                  state, and Durable Object references immediately before it is deleted.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                e.preventDefault();
                void handleBulkDestroy();
              }}
            >
              Destroy {selectedRows.length} volume(s)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
                          target="_blank"
                          rel="noopener noreferrer"
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

      <OrphanVolumesSection />

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
