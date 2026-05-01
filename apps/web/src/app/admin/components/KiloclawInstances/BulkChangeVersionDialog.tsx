'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import type { AdminKiloclawInstance } from '@/routers/admin-kiloclaw-instances-router';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type ListVersionsItem = RouterOutputs['admin']['kiloclawVersions']['listVersions']['items'][number];
type BulkResult = RouterOutputs['admin']['kiloclawInstances']['bulkChangeVersion'];

const CONFIRM_TOKEN = 'override';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All selected instance ids — what the mutation operates on. */
  selectedIds: string[];
  /**
   * Subset of `selectedIds` for which we have full row data (currently
   * visible on the table). Used to derive the summary panel. Selections
   * that span multiple pages won't have summary data; surfaces in the
   * "(N more selected, no preview)" hint.
   */
  visibleSelectedInstances: AdminKiloclawInstance[];
  availableVersions: ListVersionsItem[];
  /** Called after a successful apply (regardless of skipped/failed). */
  onApplied: () => void;
};

export function BulkChangeVersionDialog({
  open,
  onOpenChange,
  selectedIds,
  visibleSelectedInstances,
  availableVersions,
  onApplied,
}: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [targetTag, setTargetTag] = useState<string>('');
  const [overridePins, setOverridePins] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);
  const [appliedSectionOpen, setAppliedSectionOpen] = useState(true);
  const [skippedSectionOpen, setSkippedSectionOpen] = useState(true);
  const [failedSectionOpen, setFailedSectionOpen] = useState(true);

  // Reset form whenever the dialog reopens. Keeps state from leaking
  // between independent admin actions.
  useEffect(() => {
    if (open) {
      setTargetTag('');
      setOverridePins(false);
      setConfirmInput('');
      setResult(null);
    }
  }, [open]);

  // Filter out any tag that every visible instance is already running on —
  // mirrors the single-instance dialog convention. Skip the exclusion
  // entirely when off-page selections exist: visible rows may all be on
  // tag A, but an off-page selection on tag B still makes A a valid
  // target. Being permissive when our view is partial avoids hiding
  // legitimate options.
  const tagsToExclude = useMemo(() => {
    if (visibleSelectedInstances.length === 0) return new Set<string>();
    const visibleIds = new Set(visibleSelectedInstances.map(i => i.id));
    const hasOffPageSelections = selectedIds.some(id => !visibleIds.has(id));
    if (hasOffPageSelections) return new Set<string>();
    const firstTag = visibleSelectedInstances[0].tracked_image_tag;
    if (firstTag === null) return new Set<string>();
    const allMatch = visibleSelectedInstances.every(i => i.tracked_image_tag === firstTag);
    return allMatch ? new Set([firstTag]) : new Set<string>();
  }, [selectedIds, visibleSelectedInstances]);

  const targetOptions = useMemo(
    () => availableVersions.filter(v => !tagsToExclude.has(v.image_tag)),
    [availableVersions, tagsToExclude]
  );

  // Derive a per-instance summary from the visible rows. Counts pinned,
  // already-on-target, and destroyed; the rest are eligible. Off-page
  // selections (in selectedIds but not in visibleSelectedInstances) are
  // surfaced as a separate "no preview" count so admins know the visible
  // numbers undercount.
  const summary = useMemo(() => {
    const total = selectedIds.length;
    const visibleIds = new Set(visibleSelectedInstances.map(i => i.id));
    const noPreview = selectedIds.filter(id => !visibleIds.has(id)).length;

    let pinnedByUser = 0;
    let pinnedByAdmin = 0;
    let destroyed = 0;
    let alreadyOnTarget = 0;

    for (const i of visibleSelectedInstances) {
      if (i.destroyed_at) {
        destroyed += 1;
        continue;
      }
      if (i.pin) {
        if (i.pin.is_admin_pin) pinnedByAdmin += 1;
        else pinnedByUser += 1;
        continue;
      }
      if (targetTag && i.tracked_image_tag === targetTag) {
        alreadyOnTarget += 1;
      }
    }

    return {
      total,
      noPreview,
      pinnedByUser,
      pinnedByAdmin,
      destroyed,
      alreadyOnTarget,
    };
  }, [selectedIds, visibleSelectedInstances, targetTag]);

  const bulkChange = useMutation(
    trpc.admin.kiloclawInstances.bulkChangeVersion.mutationOptions({
      onSuccess: data => {
        setResult(data);
        if (data.applied.length > 0) {
          // Refetch the page so the new tracked_image_tag values surface.
          // Phase 1.5.1's alarm syncs the column; the worker restart
          // triggers the next alarm, which writes the new tag.
          void queryClient.invalidateQueries({
            queryKey: trpc.admin.kiloclawInstances.list.queryKey(),
          });
        }
        // Clear selection regardless of partition outcome — even an
        // all-skipped/all-failed run has been "processed", and leaving
        // selection state would force the admin to manually click Clear.
        onApplied();
      },
    })
  );

  const overrideRequiresConfirm = overridePins;
  const confirmMatches = !overrideRequiresConfirm || confirmInput === CONFIRM_TOKEN;
  const canApply = targetTag !== '' && confirmMatches && !bulkChange.isPending && result === null;

  const onApply = () => {
    if (!targetTag) return;
    bulkChange.mutate({
      instanceIds: selectedIds,
      imageTag: targetTag,
      overridePins,
    });
  };

  const handleClose = (next: boolean) => {
    if (bulkChange.isPending) return; // don't close mid-flight
    onOpenChange(next);
  };

  const copyIds = (ids: string[]) => {
    void navigator.clipboard.writeText(ids.join('\n'));
  };

  // If the chosen target is older than every visible instance's tracked
  // tag, surface the same advisory the single-instance dialog uses.
  const showOlderAdvisory = useMemo(() => {
    if (!targetTag) return false;
    const target = availableVersions.find(v => v.image_tag === targetTag);
    if (!target) return false;
    if (visibleSelectedInstances.length === 0) return false;
    const targetPublishedAt = target.published_at;
    return visibleSelectedInstances.every(i => {
      if (!i.tracked_image_tag) return false;
      const current = availableVersions.find(v => v.image_tag === i.tracked_image_tag);
      if (!current) return false;
      return current.published_at > targetPublishedAt;
    });
  }, [targetTag, availableVersions, visibleSelectedInstances]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl">
        {result === null ? (
          <>
            <DialogHeader>
              <DialogTitle>
                Change version on {selectedIds.length}{' '}
                {selectedIds.length === 1 ? 'instance' : 'instances'}
              </DialogTitle>
              <DialogDescription>
                Apply a version change to the selected instances. The chosen version can be newer or
                older than what each instance is currently running.
              </DialogDescription>
            </DialogHeader>

            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>This runs immediately. No undo, no user notice.</AlertTitle>
              <AlertDescription>
                Every selected instance restarts now. End users get no notification, and any active
                session is interrupted. Confirm the selection and target version are correct before
                applying.
              </AlertDescription>
            </Alert>

            <div className="space-y-4 py-2">
              <div className="bg-muted/30 rounded-md border p-3 text-sm">
                <div className="font-medium">Selection summary</div>
                <ul className="text-muted-foreground mt-1 list-disc pl-5">
                  <li>
                    {summary.total} {summary.total === 1 ? 'instance' : 'instances'} selected
                    {summary.noPreview > 0 && (
                      <span className="text-amber-400">
                        {' '}
                        ({summary.noPreview} not on this page, preview limited)
                      </span>
                    )}
                  </li>
                  {summary.pinnedByUser > 0 && <li>{summary.pinnedByUser} pinned by users</li>}
                  {summary.pinnedByAdmin > 0 && <li>{summary.pinnedByAdmin} pinned by admins</li>}
                  {summary.destroyed > 0 && <li>{summary.destroyed} destroyed</li>}
                  {targetTag && summary.alreadyOnTarget > 0 && (
                    <li>{summary.alreadyOnTarget} already on the chosen target</li>
                  )}
                </ul>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bulk-target-version">Target version</Label>
                <Select value={targetTag} onValueChange={setTargetTag}>
                  <SelectTrigger id="bulk-target-version">
                    <SelectValue placeholder="Choose a target image tag…" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetOptions.map(v => (
                      <SelectItem
                        key={v.image_tag}
                        value={v.image_tag}
                        textValue={`${v.openclaw_version} ${v.image_tag}${v.is_latest ? ' (latest)' : ''}`}
                      >
                        <span className="font-medium">{v.openclaw_version}</span>
                        <span className="text-muted-foreground ml-2 font-mono text-xs">
                          {v.image_tag}
                        </span>
                        {v.is_latest && (
                          <span className="text-muted-foreground ml-2 text-xs">(latest)</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {showOlderAdvisory && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Older version selected</AlertTitle>
                  <AlertDescription>
                    The chosen target is older than every visible selected instance is currently
                    running. Older versions may be missing features or unable to read data written
                    by newer versions.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="bulk-override-pins"
                    checked={overridePins}
                    onCheckedChange={checked => {
                      setOverridePins(checked === true);
                      if (checked !== true) setConfirmInput('');
                    }}
                  />
                  <div className="flex-1 space-y-1">
                    <Label htmlFor="bulk-override-pins" className="cursor-pointer">
                      Override existing pins
                    </Label>
                    <p className="text-muted-foreground text-xs">
                      This removes any existing version pinning, both admin and user set. The
                      instances keep running and keep all their data. Affected users can set a new
                      pin afterwards if they want.
                    </p>
                  </div>
                </div>

                {overrideRequiresConfirm && (
                  <div className="space-y-2 pt-2">
                    <Label htmlFor="bulk-confirm">
                      Type <span className="font-mono">{CONFIRM_TOKEN}</span> to confirm
                    </Label>
                    <Input
                      id="bulk-confirm"
                      value={confirmInput}
                      onChange={e => setConfirmInput(e.target.value)}
                      placeholder={CONFIRM_TOKEN}
                      maxLength={32}
                      autoComplete="off"
                    />
                  </div>
                )}
              </div>

              {bulkChange.error && (
                <Alert variant="destructive">
                  <AlertTitle>Bulk change failed</AlertTitle>
                  <AlertDescription>
                    {bulkChange.error instanceof Error ? bulkChange.error.message : 'Unknown error'}
                  </AlertDescription>
                </Alert>
              )}

              {bulkChange.isPending && (
                <div className="text-muted-foreground text-sm">
                  Applying… (this may take a few seconds for {selectedIds.length}{' '}
                  {selectedIds.length === 1 ? 'instance' : 'instances'})
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleClose(false)}
                disabled={bulkChange.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={onApply}
                disabled={!canApply}
                className={overridePins ? 'bg-destructive hover:bg-destructive/90' : undefined}
              >
                {overridePins ? 'Override and change version' : 'Apply'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Bulk change complete</DialogTitle>
              <DialogDescription>
                Applied {result.applied.length} · Skipped {result.skipped.length} · Failed{' '}
                {result.failed.length}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              {result.applied.length > 0 && (
                <ResultSection
                  title="Applied"
                  count={result.applied.length}
                  open={appliedSectionOpen}
                  onToggle={() => setAppliedSectionOpen(o => !o)}
                  onCopy={() => copyIds(result.applied)}
                  className="border-green-500/30 bg-green-500/5"
                >
                  <ul className="font-mono text-xs">
                    {result.applied.map(id => (
                      <li key={id} className="truncate" title={id}>
                        {id}
                      </li>
                    ))}
                  </ul>
                </ResultSection>
              )}

              {result.skipped.length > 0 && (
                <ResultSection
                  title="Skipped"
                  count={result.skipped.length}
                  open={skippedSectionOpen}
                  onToggle={() => setSkippedSectionOpen(o => !o)}
                  onCopy={() => copyIds(result.skipped.map(s => s.instanceId))}
                  className="border-amber-500/30 bg-amber-500/5"
                >
                  {(
                    [
                      'pinned_by_user',
                      'pinned_by_admin',
                      'pin_changed_in_flight',
                      'already_on_target',
                      'destroyed',
                    ] as const
                  ).map(reason => {
                    const items = result.skipped.filter(s => s.reason === reason);
                    if (items.length === 0) return null;
                    return (
                      <div key={reason} className="mb-2 last:mb-0">
                        <div className="text-muted-foreground text-xs">
                          {reasonLabel(reason)} ({items.length})
                        </div>
                        <ul className="font-mono text-xs">
                          {items.map(s => (
                            <li key={s.instanceId} className="truncate" title={s.instanceId}>
                              {s.instanceId}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </ResultSection>
              )}

              {result.failed.length > 0 && (
                <ResultSection
                  title="Failed"
                  count={result.failed.length}
                  open={failedSectionOpen}
                  onToggle={() => setFailedSectionOpen(o => !o)}
                  onCopy={() => copyIds(result.failed.map(f => `${f.instanceId}\t${f.error}`))}
                  className="border-red-500/30 bg-red-500/5"
                >
                  <ul className="space-y-1 text-xs">
                    {result.failed.map(f => (
                      <li key={f.instanceId} className="font-mono">
                        <span className="truncate" title={f.instanceId}>
                          {f.instanceId}
                        </span>
                        <span className="text-muted-foreground">: {f.error}</span>
                      </li>
                    ))}
                  </ul>
                </ResultSection>
              )}
            </div>

            <DialogFooter>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResultSection({
  title,
  count,
  open,
  onToggle,
  onCopy,
  className,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  onCopy: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md border p-3 ${className ?? ''}`}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-sm font-medium"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {title} ({count})
        </button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCopy}
          aria-label={`Copy ${title.toLowerCase()} IDs`}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      {open && <div className="mt-2 max-h-48 overflow-y-auto">{children}</div>}
    </div>
  );
}

function reasonLabel(
  reason:
    | 'pinned_by_user'
    | 'pinned_by_admin'
    | 'already_on_target'
    | 'destroyed'
    | 'pin_changed_in_flight'
) {
  switch (reason) {
    case 'pinned_by_user':
      return 'Pinned by user';
    case 'pinned_by_admin':
      return 'Pinned by admin';
    case 'pin_changed_in_flight':
      return 'Pin changed during apply';
    case 'already_on_target':
      return 'Already on target';
    case 'destroyed':
      return 'Destroyed';
  }
}
