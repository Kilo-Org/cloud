'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Slider } from '@/components/ui/slider';
import {
  Loader2,
  AlertTriangle,
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  X,
  Rocket,
  Anchor,
  CheckCircle2,
  Square,
  Plus,
  Minus,
  Ban,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { toastPinMutationResult } from '@/lib/kiloclaw/pin-sync-toast';
import { formatDistanceToNow } from 'date-fns';

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'available':
      return <Badge className="bg-green-600">Available</Badge>;
    case 'disabled':
      return <Badge variant="destructive">Disabled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

type CatalogRow = {
  id: string;
  image_tag: string;
  openclaw_version: string;
  variant: string;
  status: string;
  rollout_percent: number;
  is_latest: boolean;
  published_at: string;
};

/**
 * Top-of-page hero showing the variant's release state at a glance:
 *  - which image is currently :latest
 *  - whether a rollout is in flight, and at what percent
 *  - inline controls to adjust the rollout (slider, +10/-10, promote, stop)
 *
 * The table below becomes pure reference data; ops doesn't need to scan rows
 * to figure out current state — it's right here.
 */
function RolloutStatusPanel({
  latest,
  candidate,
  onSetPercent,
  onPromoteCandidate,
}: {
  latest: CatalogRow | null;
  candidate: CatalogRow | null;
  onSetPercent: (imageTag: string, percent: number) => Promise<unknown>;
  onPromoteCandidate: (imageTag: string) => Promise<unknown>;
}) {
  const [optimisticPercent, setOptimisticPercent] = useState<number | null>(null);
  const displayPercent = optimisticPercent ?? candidate?.rollout_percent ?? 0;

  /**
   * Commit a percent change with edge-case affordances:
   *  - Drop to 0 → undo toast (easy to recover from an accidental drag).
   *  - Reach 100 → offer to promote to :latest in one step (since at 100%
   *    every instance is already in cohort — promotion is the natural next
   *    move and ends the rollout).
   */
  const commitPercent = async (imageTag: string, next: number, previous: number) => {
    setOptimisticPercent(next);
    try {
      await onSetPercent(imageTag, next);
      if (next === 0 && previous > 0) {
        toast(`Rollout of ${imageTag.slice(0, 24)}… stopped`, {
          description: `Was at ${previous}%. Click Undo to restore.`,
          duration: 12_000,
          action: {
            label: 'Undo',
            onClick: () => {
              void onSetPercent(imageTag, previous);
            },
          },
        });
      }
      if (next === 100 && previous < 100) {
        const ok = window.confirm(
          `Reached 100% — every instance now qualifies for ${imageTag}. ` +
            `Promote it to :latest now? This replaces the current :latest. ` +
            `New instances and unpinned upgrades will go to this image, ` +
            `and the rollout will close.\n\nClick Cancel to keep observing at 100% without promoting.`
        );
        if (ok) {
          await onPromoteCandidate(imageTag);
        }
      }
    } finally {
      setOptimisticPercent(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="h-4 w-4" /> Rollout Status — variant{' '}
          <code className="text-xs">{latest?.variant ?? candidate?.variant ?? 'default'}</code>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* :latest row */}
        <div className="flex items-center gap-3 rounded-md border-l-4 border-blue-600 bg-blue-950/20 px-3 py-2">
          <Anchor className="h-4 w-4 text-blue-500" />
          <div className="flex-1">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wide">
              Current :latest
            </div>
            {latest ? (
              <div className="flex items-center gap-2 text-sm">
                <code className="text-xs">{latest.image_tag}</code>
                <span className="text-muted-foreground">· OpenClaw {latest.openclaw_version}</span>
                <span className="text-muted-foreground">
                  · {formatDistanceToNow(new Date(latest.published_at), { addSuffix: true })}
                </span>
              </div>
            ) : (
              <div className="text-muted-foreground text-sm italic">
                No image marked as :latest. Promote one below.
              </div>
            )}
          </div>
        </div>

        {/* Candidate row (or empty state) */}
        {candidate ? (
          <div className="flex flex-col gap-3 rounded-md border-l-4 border-purple-600 bg-purple-950/20 px-3 py-3">
            <div className="flex items-start gap-3">
              <Rocket className="mt-0.5 h-4 w-4 text-purple-400" />
              <div className="flex-1">
                <div className="text-muted-foreground text-[10px] uppercase tracking-wide">
                  Rolling out
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <code className="text-xs">{candidate.image_tag}</code>
                  <span className="text-muted-foreground">
                    · OpenClaw {candidate.openclaw_version}
                  </span>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  void commitPercent(candidate.image_tag, 0, candidate.rollout_percent);
                }}
              >
                <Square className="mr-1 h-3 w-3 fill-current" /> Stop
              </Button>
              <Button
                size="sm"
                className="h-7 bg-blue-600 text-xs hover:bg-blue-700"
                onClick={() => {
                  if (
                    window.confirm(
                      `Promote ${candidate.image_tag} to :latest? This replaces the current :latest. New instances and unpinned upgrades will go to this image.`
                    )
                  ) {
                    void onPromoteCandidate(candidate.image_tag);
                  }
                }}
              >
                <CheckCircle2 className="mr-1 h-3 w-3" /> Promote to :latest
              </Button>
            </div>

            {/* Slider + percent */}
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  const next = Math.max(0, candidate.rollout_percent - 10);
                  void commitPercent(candidate.image_tag, next, candidate.rollout_percent);
                }}
                disabled={displayPercent === 0}
              >
                <Minus className="h-3 w-3" />
              </Button>
              <div className="flex-1">
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={[displayPercent]}
                  onValueChange={value => setOptimisticPercent(value[0] ?? 0)}
                  onValueCommit={value => {
                    const next = value[0] ?? 0;
                    void commitPercent(candidate.image_tag, next, candidate.rollout_percent);
                  }}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  const next = Math.min(100, candidate.rollout_percent + 10);
                  void commitPercent(candidate.image_tag, next, candidate.rollout_percent);
                }}
                disabled={displayPercent === 100}
              >
                <Plus className="h-3 w-3" />
              </Button>
              <span className="w-12 text-right text-sm font-semibold tabular-nums">
                {displayPercent}%
              </span>
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
            <Rocket className="mr-2 inline h-3 w-3" />
            No rollout in flight. Click <strong>Start rollout</strong> on any available image below
            to stage it as a candidate.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Starts a rollout on a row that isn't currently the candidate. If a candidate
 * already exists for the variant, the popover shows a confirmation message —
 * the parent's `onStart` handler clears the existing candidate first, then
 * sets the new one.
 */
function StartRolloutButton({
  imageTag,
  existingCandidate,
  onStart,
}: {
  imageTag: string;
  existingCandidate: { image_tag: string; rollout_percent: number } | null;
  onStart: (percent: number) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('20');
  const [saving, setSaving] = useState(false);

  const parsed = Number.parseInt(value, 10);
  const valid = Number.isInteger(parsed) && parsed > 0 && parsed <= 100;
  const replacing = existingCandidate !== null && existingCandidate.image_tag !== imageTag;

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (!next && !saving) setValue('20');
        setOpen(next);
      }}
    >
      {/* Both PopoverTrigger and TooltipTrigger use asChild — they need to
          wrap the Button directly so click + hover handlers both reach the
          DOM element. Nesting Tooltip inside PopoverTrigger broke the click
          handler because Tooltip is a Provider (no DOM output). */}
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 w-8 p-0" aria-label="Start rollout">
              <Rocket className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent>Start rollout</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-[300px]" align="end">
        <div className="flex flex-col gap-2">
          {replacing && (
            <p className="text-xs text-yellow-500">
              This will stop the current candidate (
              <code>{existingCandidate.image_tag.slice(0, 18)}…</code> at{' '}
              {existingCandidate.rollout_percent}%) and start a new rollout on this image.
            </p>
          )}
          <label className="text-muted-foreground text-xs">Initial rollout percent (1-100)</label>
          <Input
            type="number"
            min={1}
            max={100}
            step={1}
            value={value}
            onChange={e => setValue(e.target.value)}
            disabled={saving}
            autoFocus
          />
          <Button
            size="sm"
            disabled={!valid || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onStart(parsed);
                setOpen(false);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Starting…' : `Start at ${valid ? `${parsed}%` : ''}`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type SortColumn = 'openclaw_version' | 'image_tag' | 'status' | 'published_at';
type SortDir = 'asc' | 'desc';

function SortableHeader({
  column,
  label,
  activeSort,
  activeDir,
  onSort,
  className,
}: {
  column: SortColumn;
  label: string;
  activeSort: SortColumn;
  activeDir: SortDir;
  onSort: (column: SortColumn) => void;
  className?: string;
}) {
  const active = activeSort === column;
  const Icon = active ? (activeDir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        className={`hover:text-foreground inline-flex items-center gap-1 transition-colors ${
          active ? 'text-foreground' : 'text-muted-foreground'
        }`}
        onClick={() => onSort(column)}
      >
        {label}
        <Icon className={`h-3 w-3 ${active ? 'opacity-100' : 'opacity-50'}`} />
      </button>
    </TableHead>
  );
}

export function VersionsTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'all' | 'available' | 'disabled'>('all');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortColumn>('published_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const limit = 25;

  const { data, isLoading } = useQuery(
    trpc.admin.kiloclawVersions.listVersions.queryOptions({
      offset: page * limit,
      limit,
      status: statusFilter === 'all' ? undefined : statusFilter,
      sortBy,
      sortDir,
    })
  );

  // Rows that are eligible for bulk disable on the current page. Excludes
  // :latest (kiloclaw service refuses to disable it) and already-disabled
  // rows (idempotent). Active candidates ARE eligible — disabling clears
  // their rollout percent.
  const eligibleRows = (data?.items ?? []).filter(v => v.status === 'available' && !v.is_latest);
  const allEligibleSelected =
    eligibleRows.length > 0 && eligibleRows.every(v => selectedTags.has(v.image_tag));

  // After any mutation that changes catalog state, invalidate both the
  // paginated list (table view) AND the active rollout query (hero panel).
  const invalidateRolloutState = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawVersions.listVersions.queryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawVersions.getActiveRollout.queryKey(),
    });
  };

  const { mutateAsync: updateStatus } = useMutation(
    trpc.admin.kiloclawVersions.updateVersionStatus.mutationOptions({
      onSuccess: () => {
        toast.success('Version status updated');
        invalidateRolloutState();
      },
      onError: err => {
        toast.error(`Failed to update status: ${err.message}`);
      },
    })
  );

  const { mutateAsync: bulkDisable, isPending: isBulkDisabling } = useMutation(
    trpc.admin.kiloclawVersions.bulkDisableVersions.mutationOptions({
      onSuccess: result => {
        const parts: string[] = [];
        if (result.disabled.length) parts.push(`${result.disabled.length} disabled`);
        if (result.skippedLatest.length)
          parts.push(`${result.skippedLatest.length} skipped (:latest)`);
        if (result.skippedAlreadyDisabled.length)
          parts.push(`${result.skippedAlreadyDisabled.length} already disabled`);
        if (result.notFound.length) parts.push(`${result.notFound.length} not found`);
        if (result.errors.length) parts.push(`${result.errors.length} errored`);
        const summary = parts.length > 0 ? parts.join(', ') : 'no changes';
        if (result.errors.length > 0) {
          toast.error(`Bulk disable: ${summary}`);
        } else {
          toast.success(`Bulk disable: ${summary}`);
        }
        invalidateRolloutState();
        setSelectedTags(new Set());
        setBulkConfirmOpen(false);
      },
      onError: err => {
        toast.error(`Bulk disable failed: ${err.message}`);
      },
    })
  );

  // Clear selection when the page or filter changes — selected tags may no
  // longer be in the visible list, and silently carrying them through a
  // pagination click would be confusing.
  const resetSelection = () => setSelectedTags(new Set());

  // Click a sort header: same column flips direction, new column starts in
  // the column's natural direction (desc for date/numericish, asc for text).
  // Resets pagination + selection because the visible row set changes.
  const handleSort = (column: SortColumn) => {
    setPage(0);
    resetSelection();
    if (sortBy === column) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDir(column === 'published_at' ? 'desc' : 'asc');
    }
  };

  const { mutateAsync: setRolloutPercent } = useMutation(
    trpc.admin.kiloclawVersions.setRolloutPercent.mutationOptions({
      onSuccess: result => {
        toast.success(`Rollout updated: ${result.imageTag} → ${result.rolloutPercent}%`);
        invalidateRolloutState();
      },
      onError: err => {
        toast.error(`Failed to update rollout: ${err.message}`);
      },
    })
  );

  const { mutateAsync: markLatest } = useMutation(
    trpc.admin.kiloclawVersions.markLatest.mutationOptions({
      onSuccess: result => {
        toast.success(`Marked ${result.imageTag} as :latest`);
        invalidateRolloutState();
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawVersions.getLatestTag.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to mark as latest: ${err.message}`);
      },
    })
  );

  // Top-of-page state — the hero panel and per-row affordances both depend on
  // these. Source these from a dedicated catalog query (NOT from the paginated
  // table data) so we never miss an active candidate just because it sits on a
  // different page than what the admin is currently viewing.
  const { data: activeRollout } = useQuery(
    trpc.admin.kiloclawVersions.getActiveRollout.queryOptions({ variant: 'default' })
  );
  const currentLatest = (activeRollout?.latest ?? null) as CatalogRow | null;
  const currentCandidate = (activeRollout?.candidate ?? null) as CatalogRow | null;

  // Newly published images sit dormant until ops promotes them. Surface a
  // reminder when there are available rows newer than :latest at 0% rollout
  // — these are typically post-deploy images waiting for someone to either
  // mark them :latest or start a rollout.
  const latestPublishedAt = currentLatest ? new Date(currentLatest.published_at).getTime() : 0;
  const unpromotedImages = (data?.items ?? []).filter(
    v =>
      v.status === 'available' &&
      !v.is_latest &&
      v.rollout_percent === 0 &&
      new Date(v.published_at).getTime() > latestPublishedAt
  );

  const { mutateAsync: syncCatalog, isPending: isSyncing } = useMutation(
    trpc.admin.kiloclawVersions.syncCatalog.mutationOptions({
      onSuccess: result => {
        const parts = [`${result.synced} added`, `${result.alreadyExisted} already existed`];
        if (result.invalid > 0) parts.push(`${result.invalid} invalid`);
        toast.success(`Sync complete: ${parts.join(', ')}`);
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawVersions.listVersions.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Sync failed: ${err.message}`);
      },
    })
  );

  return (
    <div className="flex flex-col gap-y-4">
      {/* Hero: at-a-glance state of the variant */}
      <RolloutStatusPanel
        latest={currentLatest}
        candidate={currentCandidate}
        onSetPercent={async (imageTag, percent) => {
          await setRolloutPercent({ imageTag, percent });
        }}
        onPromoteCandidate={async imageTag => {
          await markLatest({ imageTag });
        }}
      />

      {/* Reminder when newly-published images are sitting dormant. */}
      {unpromotedImages.length > 0 && (
        <div className="flex items-start gap-3 rounded-md border border-amber-700/50 bg-amber-950/20 px-3 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="flex-1">
            <div className="font-medium text-amber-400">
              {unpromotedImages.length} newly published image
              {unpromotedImages.length === 1 ? '' : 's'} waiting for promotion
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              Publishing no longer auto-promotes to <code>:latest</code>. New images land at 0% and
              aren't exposed to instances until you either click <strong>Make :latest</strong> or{' '}
              <strong>Start rollout</strong> in the table below.
            </p>
            {unpromotedImages.length <= 3 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {unpromotedImages.map(v => (
                  <code key={v.id} className="bg-amber-900/30 rounded px-1.5 py-0.5 text-[10px]">
                    {v.image_tag.slice(0, 24)}
                    {v.image_tag.length > 24 ? '…' : ''}
                  </code>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Filter + sync controls */}
      <div className="flex items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v: string) => {
            if (v === 'all' || v === 'available' || v === 'disabled') {
              setStatusFilter(v);
              setPage(0);
              resetSelection();
            }
          }}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="available">Available</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" disabled={isSyncing} onClick={() => void syncCatalog()}>
          {isSyncing ? 'Syncing...' : 'Sync from KV'}
        </Button>
      </div>

      {/* Bulk action bar — always rendered so the affordance is discoverable.
          Empty state shows a muted hint; active state shows count + buttons. */}
      {selectedTags.size === 0 ? (
        <div className="text-muted-foreground border-border/60 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
          <Info className="h-3 w-3 opacity-60" />
          <span>Use the checkboxes to select rows for bulk actions.</span>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2">
          <span className="text-muted-foreground text-sm">{selectedTags.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-red-500/30 text-xs text-red-400 hover:bg-red-500/10"
            onClick={() => setBulkConfirmOpen(true)}
            disabled={isBulkDisabling}
          >
            <Ban className="mr-1 h-3 w-3" />
            Disable selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={resetSelection}
            disabled={isBulkDisabling}
          >
            Clear
          </Button>
        </div>
      )}

      {/* Reference catalog table — :latest and candidate rows are accent-bordered */}
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={allEligibleSelected}
                  disabled={eligibleRows.length === 0}
                  onCheckedChange={() => {
                    if (allEligibleSelected) {
                      resetSelection();
                    } else {
                      setSelectedTags(new Set(eligibleRows.map(v => v.image_tag)));
                    }
                  }}
                  aria-label="Select all eligible versions"
                />
              </TableHead>
              <SortableHeader
                column="openclaw_version"
                label="OpenClaw"
                activeSort={sortBy}
                activeDir={sortDir}
                onSort={handleSort}
              />
              <SortableHeader
                column="image_tag"
                label="Image Tag"
                activeSort={sortBy}
                activeDir={sortDir}
                onSort={handleSort}
              />
              <TableHead>Digest</TableHead>
              <SortableHeader
                column="status"
                label="State"
                activeSort={sortBy}
                activeDir={sortDir}
                onSort={handleSort}
              />
              <SortableHeader
                column="published_at"
                label="Published"
                activeSort={sortBy}
                activeDir={sortDir}
                onSort={handleSort}
              />
              <TableHead className="w-[140px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : data?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground text-center">
                  No versions found
                </TableCell>
              </TableRow>
            ) : (
              data?.items.map(version => {
                const isLatest = version.is_latest;
                const isCandidate =
                  !isLatest && version.status === 'available' && version.rollout_percent > 0;
                const isAvailable = version.status === 'available';
                const isDisabled = version.status === 'disabled';
                const isSelectable = isAvailable && !isLatest;
                const isSelected = selectedTags.has(version.image_tag);
                const accent = isLatest
                  ? 'border-l-4 border-l-blue-600'
                  : isCandidate
                    ? 'border-l-4 border-l-purple-600'
                    : 'border-l-4 border-l-transparent';
                return (
                  <TableRow key={version.id} className={accent}>
                    <TableCell className="py-2">
                      {isSelectable ? (
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => {
                            setSelectedTags(prev => {
                              const next = new Set(prev);
                              if (next.has(version.image_tag)) {
                                next.delete(version.image_tag);
                              } else {
                                next.add(version.image_tag);
                              }
                              return next;
                            });
                          }}
                          aria-label={`Select ${version.image_tag}`}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <span>{version.openclaw_version}</span>
                        <span className="text-muted-foreground text-[10px]">{version.variant}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">
                        {version.image_tag.length > 24
                          ? `${version.image_tag.slice(0, 24)}…`
                          : version.image_tag}
                      </code>
                    </TableCell>
                    <TableCell>
                      <code
                        className="text-muted-foreground text-xs"
                        title={version.image_digest ?? undefined}
                      >
                        {version.image_digest ? version.image_digest.slice(7, 19) : '—'}
                      </code>
                    </TableCell>
                    <TableCell>
                      {isDisabled ? (
                        <StatusBadge status="disabled" />
                      ) : isLatest ? (
                        <Badge className="bg-blue-600 text-white">
                          <Anchor className="mr-1 h-3 w-3" /> :latest
                        </Badge>
                      ) : isCandidate ? (
                        <Badge className="bg-purple-600 text-white">
                          <Rocket className="mr-1 h-3 w-3" /> candidate · {version.rollout_percent}%
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          available
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      <span title={new Date(version.published_at).toLocaleString()}>
                        {formatDistanceToNow(new Date(version.published_at), { addSuffix: true })}
                      </span>
                    </TableCell>
                    <TableCell>
                      {/* Three fixed slots so action icons line up vertically
                          across rows. Each slot is one of: a button OR an
                          empty 8x8 placeholder. Tooltip names each action on
                          hover. Slot order:
                            1) Start rollout (Rocket)
                            2) Make / Promote :latest (Anchor)
                            3) Disable (Ban) or Re-enable (CheckCircle) */}
                      <TooltipProvider delayDuration={150}>
                        <div className="flex items-center gap-1">
                          {/* Slot 1: Start rollout */}
                          {isAvailable && !isLatest && !isCandidate ? (
                            <StartRolloutButton
                              imageTag={version.image_tag}
                              existingCandidate={currentCandidate}
                              onStart={async percent => {
                                if (
                                  currentCandidate &&
                                  currentCandidate.image_tag !== version.image_tag
                                ) {
                                  await setRolloutPercent({
                                    imageTag: currentCandidate.image_tag,
                                    percent: 0,
                                  });
                                }
                                await setRolloutPercent({
                                  imageTag: version.image_tag,
                                  percent,
                                });
                              }}
                            />
                          ) : (
                            <div className="h-8 w-8" aria-hidden="true" />
                          )}
                          {/* Slot 2: Make / Promote :latest */}
                          {isAvailable && !isLatest ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  className="h-8 w-8 bg-blue-600 p-0 text-white hover:bg-blue-700"
                                  aria-label="Make :latest"
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        isCandidate
                                          ? `Promote ${version.image_tag} to :latest? This replaces the current :latest and ends the rollout.`
                                          : `Mark ${version.image_tag} as :latest? This replaces the current :latest and clears any rollout percent on this image.`
                                      )
                                    ) {
                                      void markLatest({ imageTag: version.image_tag });
                                    }
                                  }}
                                >
                                  <Anchor className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {isCandidate ? 'Promote to :latest' : 'Make :latest'}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <div className="h-8 w-8" aria-hidden="true" />
                          )}
                          {/* Slot 3: Disable (available rows) or Re-enable (disabled rows) */}
                          {isAvailable && !isLatest && !isCandidate ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 w-8 p-0 text-red-500 hover:bg-red-950/30 hover:text-red-400"
                                  aria-label="Disable image"
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `Disable ${version.image_tag}? It will no longer be available for new pins or rollouts. Already pinned instances continue running it.`
                                      )
                                    ) {
                                      void updateStatus({
                                        imageTag: version.image_tag,
                                        status: 'disabled',
                                      });
                                    }
                                  }}
                                >
                                  <Ban className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Disable image</TooltipContent>
                            </Tooltip>
                          ) : isDisabled ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 w-8 p-0"
                                  aria-label="Re-enable image"
                                  onClick={() => {
                                    void updateStatus({
                                      imageTag: version.image_tag,
                                      status: 'available',
                                    });
                                  }}
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Re-enable image</TooltipContent>
                            </Tooltip>
                          ) : (
                            <div className="h-8 w-8" aria-hidden="true" />
                          )}
                        </div>
                      </TooltipProvider>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page + 1} of {data.pagination.totalPages}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPage(p => p - 1);
                resetSelection();
              }}
              disabled={page === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPage(p => p + 1);
                resetSelection();
              }}
              disabled={page + 1 >= data.pagination.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Bulk disable confirmation. AlertDialog wraps Radix Dialog, which
          fires onOpenChange for both Escape and overlay clicks. The wrapper
          handler suppresses our own state flip while the mutation is in
          flight, but Radix still processes the underlying event and would
          flip its internal open state out from under React. Pass through
          onEscapeKeyDown and onPointerDownOutside guards so Radix never
          gets the chance.

          AlertDialogAction is a plain Button (no DialogClose wrapper), so
          the dialog dismisses through the mutation's onSuccess / onError
          handlers calling setBulkConfirmOpen(false). */}
      <AlertDialog
        open={bulkConfirmOpen}
        onOpenChange={open => {
          if (!open && !isBulkDisabling) setBulkConfirmOpen(false);
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={e => {
            if (isBulkDisabling) e.preventDefault();
          }}
          onPointerDownOutside={e => {
            if (isBulkDisabling) e.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disable {selectedTags.size} version{selectedTags.size === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedTags.size === 1 ? 'This image' : `These ${selectedTags.size} images`} will be
              marked <code>status=&apos;disabled&apos;</code> and any in flight rollout on{' '}
              {selectedTags.size === 1 ? 'it' : 'them'} will be cleared. New instances and unpinned
              upgrades won&apos;t pick {selectedTags.size === 1 ? 'it' : 'them'} up. Already pinned
              instances continue running their pinned image untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkDisabling}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isBulkDisabling}
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => {
                void bulkDisable({ imageTags: Array.from(selectedTags) });
              }}
            >
              {isBulkDisabling
                ? 'Disabling…'
                : `Disable ${selectedTags.size} version${selectedTags.size === 1 ? '' : 's'}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function PinsTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [removingInstanceId, setRemovingInstanceId] = useState<string | null>(null);
  const limit = 25;

  // Add pin form state
  const [userSearch, setUserSearch] = useState('');
  const [userComboboxOpen, setUserComboboxOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserEmail, setSelectedUserEmail] = useState<string | null>(null);
  const [pinImageTag, setPinImageTag] = useState('');
  const [pinReason, setPinReason] = useState('');

  const { data: userResults } = useQuery({
    ...trpc.admin.kiloclawVersions.searchUsers.queryOptions({ query: userSearch }),
    enabled: userSearch.length >= 2 && !selectedUserId,
  });

  const { data: availableVersions } = useQuery(
    trpc.admin.kiloclawVersions.listVersions.queryOptions({ status: 'available', limit: 100 })
  );

  const { data, isLoading } = useQuery(
    trpc.admin.kiloclawVersions.listPins.queryOptions({
      offset: page * limit,
      limit,
    })
  );

  const invalidatePinQueries = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawVersions.listPins.queryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawVersions.getUserPin.queryKey(),
    });
  };

  const { mutateAsync: setPin, isPending: isPinning } = useMutation(
    trpc.admin.kiloclawVersions.setPin.mutationOptions({
      onSuccess: result => {
        toastPinMutationResult(result, 'Pin created');
        invalidatePinQueries();
        setSelectedUserId(null);
        setSelectedUserEmail(null);
        setUserSearch('');
        setPinImageTag('');
        setPinReason('');
      },
      onError: err => {
        toast.error(`Failed to create pin: ${err.message}`);
      },
    })
  );

  const { mutateAsync: removePin, isPending: isRemoving } = useMutation(
    trpc.admin.kiloclawVersions.removePin.mutationOptions({
      onSuccess: result => {
        toastPinMutationResult(result, 'Pin removed');
        invalidatePinQueries();
        setRemovingInstanceId(null);
      },
      onError: err => {
        toast.error(`Failed to remove pin: ${err.message}`);
      },
    })
  );

  return (
    <div className="flex flex-col gap-y-4">
      {/* Add Pin form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Pin</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <div className="w-[280px] shrink-0">
              <label className="text-muted-foreground mb-1 block text-xs">User</label>
              {selectedUserId ? (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-sm">
                    {selectedUserEmail ?? selectedUserId}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => {
                      setSelectedUserId(null);
                      setSelectedUserEmail(null);
                      setUserSearch('');
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <Popover open={userComboboxOpen} onOpenChange={setUserComboboxOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={userComboboxOpen}
                      className="w-full justify-between font-normal"
                    >
                      <span className="text-muted-foreground">Search by email or user ID...</span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput
                        placeholder="Search by email or user ID..."
                        value={userSearch}
                        onValueChange={setUserSearch}
                      />
                      <CommandList>
                        {userSearch.length < 2 && (
                          <CommandEmpty>Type at least 2 characters to search...</CommandEmpty>
                        )}
                        {userSearch.length >= 2 && !userResults?.length && (
                          <CommandEmpty>No users found</CommandEmpty>
                        )}
                        {userResults && userResults.length > 0 && (
                          <CommandGroup>
                            {userResults.map(user => (
                              <CommandItem
                                key={user.id}
                                value={user.id}
                                onSelect={() => {
                                  setSelectedUserId(user.id);
                                  setSelectedUserEmail(user.email);
                                  setUserSearch('');
                                  setUserComboboxOpen(false);
                                }}
                              >
                                <span className="font-medium">{user.email}</span>
                                {user.name && (
                                  <span className="text-muted-foreground ml-2">{user.name}</span>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <div className="w-[300px] shrink-0">
              <label className="text-muted-foreground mb-1 block text-xs">Image Tag</label>
              <Select value={pinImageTag} onValueChange={setPinImageTag}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select image tag..." />
                </SelectTrigger>
                <SelectContent className="min-w-[500px]">
                  {availableVersions?.items.map(v => (
                    <SelectItem key={v.image_tag} value={v.image_tag}>
                      {v.image_tag} (OpenClaw {v.openclaw_version})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <p className="mb-1 flex items-center gap-1 text-xs text-red-400">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Reason is visible to the end user.
              </p>
              <label className="text-muted-foreground mb-1 block text-xs">Reason</label>
              <Input
                placeholder="Why pin this instance?"
                value={pinReason}
                onChange={e => setPinReason(e.target.value)}
              />
            </div>
            <Button
              onClick={() =>
                selectedUserId &&
                pinImageTag &&
                void setPin({
                  userId: selectedUserId,
                  imageTag: pinImageTag,
                  reason: pinReason || undefined,
                })
              }
              disabled={!selectedUserId || !pinImageTag || isPinning}
            >
              {isPinning ? 'Pinning...' : 'Pin Instance'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Instance</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Image Tag</TableHead>
              <TableHead>OpenClaw Version</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Pinned By</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : data?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-muted-foreground text-center">
                  No active pins
                </TableCell>
              </TableRow>
            ) : (
              data?.items.map(pin => (
                <TableRow key={pin.id}>
                  <TableCell className="font-mono text-xs">{pin.instance_id}</TableCell>
                  <TableCell className="font-medium">{pin.user_email ?? 'Unknown user'}</TableCell>
                  <TableCell>
                    <code className="text-xs">{pin.image_tag}</code>
                  </TableCell>
                  <TableCell>{pin.openclaw_version ?? '—'}</TableCell>
                  <TableCell>{pin.variant ?? '—'}</TableCell>
                  <TableCell>{pin.pinned_by_email ?? pin.pinned_by}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-sm">
                    {pin.reason ?? '—'}
                  </TableCell>
                  <TableCell>
                    <span title={new Date(pin.created_at).toLocaleString()}>
                      {formatDistanceToNow(new Date(pin.created_at), { addSuffix: true })}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setRemovingInstanceId(pin.instance_id)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page + 1} of {data.pagination.totalPages}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p - 1)}
              disabled={page === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p + 1)}
              disabled={page + 1 >= data.pagination.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Remove Pin Confirmation Dialog */}
      <Dialog
        open={removingInstanceId !== null}
        onOpenChange={open => !open && setRemovingInstanceId(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Remove Version Pin
            </DialogTitle>
            <DialogDescription className="pt-3">
              Are you sure you want to remove this version pin? The user will follow the latest
              available version.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button variant="secondary" disabled={isRemoving}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() =>
                removingInstanceId && void removePin({ instanceId: removingInstanceId })
              }
              disabled={isRemoving}
            >
              {isRemoving ? 'Removing...' : 'Remove Pin'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
