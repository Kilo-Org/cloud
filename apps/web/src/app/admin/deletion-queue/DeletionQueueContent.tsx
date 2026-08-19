'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { AlertCircle, RefreshCw, Search, X } from 'lucide-react';
// Temporarily unused while Add requests / Substack credential are hidden.
// import { KeyRound, Plus } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { DeletionQueueDetailContent } from './[id]/DeletionQueueDetailContent';
import { cn } from '@/lib/utils';
import { deletionAttentionHint } from '@/lib/user/deletion-queue/deletion-hints';
import {
  DELETION_QUEUE_TABS,
  formatAge,
  formatTimestamp,
  humanizeToken,
  parseDeletionEntries,
  parseDeletionQueueTab,
  shortId,
  statusBadgeClass,
  type DeletionQueueTab,
} from './deletion-queue-format';

const COLUMN_COUNT = 7;

type RouterOutputs = inferRouterOutputs<RootRouter>;
type QueueSummary = RouterOutputs['admin']['userDeletionQueue']['summary'];
type ListRow = RouterOutputs['admin']['userDeletionQueue']['list']['rows'][number];
type PreviewResult = RouterOutputs['admin']['userDeletionQueue']['preview'];

export function DeletionQueueContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseDeletionQueueTab(searchParams.get('tab'));
  const searchEmail = searchParams.get('email')?.trim() || undefined;
  const [searchDraft, setSearchDraft] = useState(searchEmail ?? '');
  const [addOpen, setAddOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const summaryQuery = useQuery({
    ...trpc.admin.userDeletionQueue.summary.queryOptions(),
    refetchInterval: 15_000,
  });
  const listQuery = useQuery({
    ...trpc.admin.userDeletionQueue.list.queryOptions({
      tab,
      searchEmail,
      limit: 25,
    }),
    placeholderData: keepPreviousData,
    refetchInterval: query => {
      const queued = summaryQuery.data?.queued ?? 0;
      const hasActive = (query.state.data?.rows ?? []).some(
        row =>
          row.status === 'pending' || row.status === 'in_progress' || row.status === 'finalizing'
      );
      return queued > 0 || hasActive ? 5_000 : 15_000;
    },
  });

  const setParams = useCallback(
    (next: { tab?: DeletionQueueTab; email?: string | null }) => {
      const params = new URLSearchParams(searchParams.toString());
      const nextTab = next.tab ?? tab;
      if (nextTab === 'open') params.delete('tab');
      else params.set('tab', nextTab);
      const email = next.email === undefined ? searchEmail : next.email || undefined;
      if (email) params.set('email', email);
      else params.delete('email');
      const query = params.toString();
      router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
    },
    [pathname, router, searchEmail, searchParams, tab]
  );

  const rows = listQuery.data?.rows ?? [];
  const asOf = listQuery.data?.asOf;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <h2 className="text-2xl font-bold">Deletion queue</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void summaryQuery.refetch();
              void listQuery.refetch();
            }}
            disabled={listQuery.isFetching}
          >
            <RefreshCw className={listQuery.isFetching ? 'animate-spin' : undefined} /> Refresh
          </Button>
          {/* Temporarily disabled: Substack task is not in the active catalog.
          <Button variant="secondary" size="sm" onClick={() => setCredentialOpen(true)}>
            <KeyRound /> Substack credential
          </Button>
          */}
          {/* Temporarily disabled: start deletion via CSA API or the user profile page.
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus /> Add requests
          </Button>
          */}
        </div>
      </div>

      {summaryQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Queue summary could not load</AlertTitle>
          <AlertDescription>Refresh to try again.</AlertDescription>
        </Alert>
      ) : (
        <QueueSummaryStrip
          summary={summaryQuery.data}
          isLoading={summaryQuery.isLoading}
          onSelectTab={nextTab => setParams({ tab: nextTab })}
        />
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={value => setParams({ tab: parseDeletionQueueTab(value) })}>
          <TabsList className="h-auto flex-wrap">
            {DELETION_QUEUE_TABS.map(item => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <form
          className="flex items-center gap-1"
          onSubmit={event => {
            event.preventDefault();
            setParams({ email: searchDraft.trim() || null });
          }}
        >
          <Label htmlFor="deletion-queue-search" className="sr-only">
            Filter by email
          </Label>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input
              id="deletion-queue-search"
              value={searchDraft}
              onChange={event => setSearchDraft(event.target.value)}
              onBlur={() => setParams({ email: searchDraft.trim() || null })}
              placeholder="Filter email"
              className="h-8 w-44 pl-7 font-mono text-xs"
              maxLength={320}
              title="Completed and cancelled requests stay redacted."
            />
          </div>
          {searchEmail || searchDraft ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={() => {
                setSearchDraft('');
                setParams({ email: null });
              }}
            >
              <X />
              <span className="sr-only">Clear email filter</span>
            </Button>
          ) : null}
        </form>
      </div>

      {listQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Deletion queue could not load</AlertTitle>
          <AlertDescription>{listQuery.error.message}</AlertDescription>
        </Alert>
      ) : (
        <DeletionQueueTable
          rows={rows}
          asOf={asOf}
          isLoading={listQuery.isLoading}
          selectedRequestId={selectedRequestId}
          onSelect={setSelectedRequestId}
        />
      )}

      <Sheet
        open={selectedRequestId !== null}
        onOpenChange={open => {
          if (!open) setSelectedRequestId(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-hidden p-0 sm:max-w-2xl"
          onInteractOutside={event => {
            if (document.querySelectorAll('[role="dialog"]').length > 1) {
              event.preventDefault();
            }
          }}
        >
          <SheetHeader className="border-border shrink-0 border-b px-6 py-4 pr-12">
            <SheetTitle>Deletion request</SheetTitle>
            <SheetDescription className="font-mono">{selectedRequestId ?? '—'}</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-4">
            {selectedRequestId ? (
              <DeletionQueueDetailContent requestId={selectedRequestId} compact />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <AddRequestsDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSubmitted={() => {
          void queryClient.invalidateQueries(trpc.admin.userDeletionQueue.list.queryFilter());
          void queryClient.invalidateQueries(trpc.admin.userDeletionQueue.summary.queryFilter());
        }}
      />
      <SubstackCredentialDialog open={credentialOpen} onOpenChange={setCredentialOpen} />
    </div>
  );
}

function QueueSummaryStrip({
  summary,
  isLoading,
  onSelectTab,
}: {
  summary: QueueSummary | undefined;
  isLoading: boolean;
  onSelectTab: (tab: DeletionQueueTab) => void;
}) {
  if (isLoading && !summary) {
    return <Skeleton className="h-24 w-full rounded-lg" />;
  }
  if (!summary) return null;
  const items = [
    { tab: 'open' as const, label: 'Queued', value: summary.queued },
    {
      tab: 'needs_attention' as const,
      label: 'Needs attention',
      value: summary.needsAttention,
      attention: true,
    },
    {
      tab: 'completed' as const,
      label: `Completed (${summary.completedWindowDays}d)`,
      value: summary.completedLast7Days,
    },
  ];
  return (
    <section aria-label="Queue summary">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {items.map(item => (
          <button
            key={item.tab}
            type="button"
            className="bg-card hover:bg-accent flex flex-col gap-0.5 p-3 text-left"
            onClick={() => onSelectTab(item.tab)}
          >
            <span className="text-muted-foreground text-xs font-medium">{item.label}</span>
            <span
              className={cn(
                'text-xl font-semibold tabular-nums',
                item.attention && item.value > 0 ? 'text-destructive' : 'text-foreground'
              )}
            >
              {item.value}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function DeletionQueueTable({
  rows,
  asOf,
  isLoading,
  selectedRequestId,
  onSelect,
}: {
  rows: ListRow[];
  asOf: string | undefined;
  isLoading: boolean;
  selectedRequestId: string | null;
  onSelect: (requestId: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Created</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Ticket</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Attention</TableHead>
            <TableHead>Last progress</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && rows.length === 0
            ? Array.from({ length: 5 }, (_, rowIndex) => (
                <TableRow key={rowIndex}>
                  {Array.from({ length: COLUMN_COUNT }, (_, cellIndex) => (
                    <TableCell key={cellIndex}>
                      <Skeleton className="h-4 w-full max-w-24" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : null}
          {!isLoading && rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="h-24 text-center">
                <p className="text-sm font-medium">No requests in this view</p>
                <p className="text-muted-foreground text-sm">Add requests or choose another tab.</p>
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map(row => {
            const done = row.tasks.filter(task =>
              ['succeeded', 'not_applicable', 'manually_verified'].includes(task.status)
            ).length;
            const attention = row.tasks.find(
              task => task.status === 'needs_attention' || task.status === 'manual_action_required'
            );
            return (
              <TableRow
                key={row.id}
                data-state={row.id === selectedRequestId ? 'selected' : undefined}
                className={cn(
                  'cursor-pointer',
                  row.stale ? 'bg-status-warning-surface/40' : undefined
                )}
                onClick={() => onSelect(row.id)}
              >
                <TableCell className="text-sm">
                  <div className="flex flex-col gap-0.5">
                    <span>{formatTimestamp(row.createdAt)}</span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {shortId(row.id)}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <Badge variant="outline" className={statusBadgeClass(row.status)}>
                      {humanizeToken(row.status)}
                    </Badge>
                    {row.stale ? (
                      <Badge
                        variant="outline"
                        className="border-status-warning-border bg-status-warning-surface text-status-warning"
                      >
                        No progress 7d
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {row.email ? (
                    <span className="block max-w-64 truncate font-mono" title={row.email}>
                      {row.email}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Redacted</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{row.pylonTicket ?? '—'}</TableCell>
                <TableCell className="text-sm tabular-nums">
                  {done}/{row.tasks.length}
                </TableCell>
                <TableCell className="text-xs">
                  {row.preflightAttentionCode ? (
                    <span className="font-mono">{row.preflightAttentionCode}</span>
                  ) : attention ? (
                    <span className="font-mono">
                      {humanizeToken(attention.stepKey)}
                      {attention.lastErrorCode ? ` · ${attention.lastErrorCode}` : ''}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  <div className="flex flex-col gap-0.5">
                    <span>{formatTimestamp(row.lastProgressAt)}</span>
                    {asOf ? (
                      <span className="text-muted-foreground text-xs">
                        {formatAge(row.lastProgressAt, asOf)}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function AddRequestsDialog({
  open,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
}) {
  const trpc = useTRPC();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const entries = useMemo(() => parseDeletionEntries(text), [text]);
  const previewMutation = useMutation(trpc.admin.userDeletionQueue.preview.mutationOptions());
  const previewMutateAsync = previewMutation.mutateAsync;
  const submitMutation = useMutation(trpc.admin.userDeletionQueue.submit.mutationOptions());
  const canSubmit = (preview?.accepted.length ?? 0) > 0 && !submitMutation.isPending;

  useEffect(() => {
    if (!open) return;
    if (entries.length === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void previewMutateAsync({ entries })
        .then(result => {
          if (!cancelled) setPreview(result);
        })
        .catch(error => {
          if (!cancelled) {
            toast.error(error instanceof Error ? error.message : 'Preview failed');
          }
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [entries, open, previewMutateAsync]);

  const reset = () => {
    setText('');
    setPreview(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add deletion requests</DialogTitle>
          <DialogDescription>
            One request per line. Email and ticket can be on the same line.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Label htmlFor="deletion-entries">Targets</Label>
          <Textarea
            id="deletion-entries"
            value={text}
            onChange={event => {
              setText(event.target.value);
              setPreview(null);
            }}
            className="min-h-40 font-mono"
            placeholder={
              'customer@example.com 1234\ncustomer2@example.com\nhttps://app.usepylon.com/issues/5678\n#9999'
            }
          />
          {preview ? (
            <div className="flex flex-col gap-2 text-sm">
              {preview.accepted.length > 0 ? (
                <div>
                  <p className="font-medium">Accepted ({preview.accepted.length})</p>
                  <ul className="space-y-1 text-xs">
                    {preview.accepted.map(entry => (
                      <li key={entry.email} className="font-mono">
                        {entry.email}
                        {entry.pylonTicket ? ` · ${entry.pylonTicket}` : ''}
                        {entry.warnings.length > 0 ? (
                          <span className="text-status-warning block font-sans">
                            {entry.warnings
                              .map(
                                code => deletionAttentionHint(code)?.title ?? humanizeToken(code)
                              )
                              .join(' · ')}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.rejected.length > 0 ? (
                <div>
                  <p className="font-medium">Rejected ({preview.rejected.length})</p>
                  <ul className="space-y-1 text-xs">
                    {preview.rejected.map(entry => (
                      <li key={`${entry.email}:${entry.code}`} className="font-mono">
                        {entry.email} · <span className="text-status-warning">{entry.code}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant={preview ? 'secondary' : 'default'}
            onClick={async () => {
              if (entries.length === 0) return;
              try {
                setPreview(await previewMutation.mutateAsync({ entries }));
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Preview failed');
              }
            }}
            disabled={entries.length === 0 || previewMutation.isPending}
          >
            Preview
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={async () => {
              if (!preview || preview.accepted.length === 0) return;
              try {
                await submitMutation.mutateAsync({
                  entries: preview.accepted.map(entry => ({
                    email: entry.email,
                    pylonTicket: entry.pylonTicket ?? undefined,
                  })),
                });
                toast.success('Requests submitted');
                onSubmitted();
                onOpenChange(false);
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Submit failed');
              }
            }}
          >
            Confirm submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubstackCredentialDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [material, setMaterial] = useState('');
  const metaQuery = useQuery({
    ...trpc.admin.userDeletionQueue.substackCredential.queryOptions(),
    enabled: open,
  });
  const storeMutation = useMutation(
    trpc.admin.userDeletionQueue.replaceSubstackCredential.mutationOptions()
  );
  const testMutation = useMutation(
    trpc.admin.userDeletionQueue.testSubstackCredential.mutationOptions()
  );
  const deleteMutation = useMutation(
    trpc.admin.userDeletionQueue.deleteSubstackCredential.mutationOptions()
  );
  const meta = metaQuery.data;
  const testResult = testMutation.data;
  const busy = storeMutation.isPending || testMutation.isPending || deleteMutation.isPending;

  const invalidate = () =>
    queryClient.invalidateQueries(trpc.admin.userDeletionQueue.substackCredential.queryFilter());

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) {
          setMaterial('');
          testMutation.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Substack credential</DialogTitle>
          <DialogDescription>
            Encrypted session cookie used by the Substack task. Test before storing. The value is
            not logged.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {meta?.configured
              ? `Stored ${meta.updatedAt ? formatTimestamp(meta.updatedAt) : '—'}`
              : 'No credential stored'}
          </p>
          {testResult ? (
            <p className="text-sm">
              {testResult.status === 'healthy'
                ? `Healthy${testResult.name || testResult.handle ? ` · ${testResult.name ?? testResult.handle}` : ''}`
                : testResult.status === 'expired'
                  ? 'Session expired. Paste a fresh cookie.'
                  : testResult.status === 'missing'
                    ? 'Nothing stored to test.'
                    : `Test failed · ${testResult.errorCode}`}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="substack-material">Session material</Label>
            <Textarea
              id="substack-material"
              value={material}
              onChange={event => setMaterial(event.target.value)}
              className="min-h-28 font-mono"
              placeholder="substack.sid=…"
            />
            <p className="text-muted-foreground text-xs">
              Paste the <span className="font-mono">substack.sid</span> cookie from a logged-in
              Substack session.
            </p>
          </div>
        </div>
        <DialogFooter className="flex-wrap">
          <Button
            variant="secondary"
            disabled={busy || (!material.trim() && !meta?.configured)}
            onClick={async () => {
              try {
                const result = await testMutation.mutateAsync(
                  material.trim() ? { material: material.trim() } : {}
                );
                if (result.status === 'healthy') toast.success('Substack session is healthy');
                else if (result.status === 'expired') toast.error('Substack session expired');
                else toast.error('Substack test failed');
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Test failed');
              }
            }}
          >
            Test
          </Button>
          {meta?.configured ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                try {
                  await deleteMutation.mutateAsync();
                  toast.success('Substack credential removed');
                  await invalidate();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : 'Disconnect failed');
                }
              }}
            >
              Disconnect
            </Button>
          ) : null}
          <Button
            disabled={!material.trim() || busy}
            onClick={async () => {
              try {
                await storeMutation.mutateAsync({ material: material.trim() });
                toast.success('Substack credential stored');
                setMaterial('');
                await invalidate();
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Could not store credential');
              }
            }}
          >
            Store credential
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
