'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import Link from 'next/link';
import { toast } from 'sonner';
import type { BulkBlockResponse } from '@/lib/abuse/bulkBlock';

function BulkBlockTab() {
  const [rawIds, setRawIds] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<BulkBlockResponse | null>(null);

  const ids = useMemo(() => [...new Set(rawIds.split(/\s+/).filter(Boolean))], [rawIds]);

  const mutation = useMutation<BulkBlockResponse>({
    mutationFn: async () => {
      const res = await fetch('/admin/api/abuse/bulk-block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kilo_user_emails_or_ids: ids.slice(0, 2000), block_reason: reason }),
      });
      return res.json() as Promise<BulkBlockResponse>;
    },
    onSuccess: setResult,
    onError: err => setResult({ success: false, error: err.message, foundIds: [] }),
  });

  return (
    <div className="bg-background rounded-lg border p-6">
      <h3 className="mb-4 text-lg font-semibold">Bulk Block Users</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="ids">kilo_user_emails_or_ids (space/newline separated)</Label>
          <Textarea
            id="ids"
            placeholder="e.g.&#10;usr_123 usr_456&#10;usr_789"
            value={rawIds}
            onChange={e => setRawIds(e.target.value)}
            rows={8}
          />
          <div className="text-muted-foreground text-xs">
            Parsed {ids.length.toLocaleString()} unique ids / emails (no more than 10 000).
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="reason">Block reason</Label>
          <Input
            id="reason"
            placeholder="e.g. abuse/spam/chargeback"
            value={reason}
            onChange={e => setReason(e.target.value)}
          />

          <div className="flex items-center gap-2 pt-2">
            <Button
              onClick={() => {
                setResult(null);
                mutation.mutate();
              }}
              disabled={!ids.length || !reason.trim() || mutation.isPending}
              variant="destructive"
            >
              {mutation.isPending ? 'Blocking…' : 'Bulk Block'}
            </Button>

            {result && !result.success && result.foundIds.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  setRawIds(result.foundIds.join('\n'));
                  setResult(null);
                }}
              >
                Keep only valid ids
              </Button>
            )}
          </div>

          {result && !result.success && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>{result.error}</AlertDescription>
            </Alert>
          )}

          {result?.success && (
            <Alert className="mt-2">
              <AlertDescription>
                Updated {result.updatedCount.toLocaleString()} users with reason &ldquo;
                {reason.trim()}&rdquo;.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}

type RecentBlockRow = {
  blocked_reason: string;
  date: string;
  blocked_count: number;
};

function RecentBlocksTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [unblockTarget, setUnblockTarget] = useState<RecentBlockRow | null>(null);

  const { data, isLoading } = useQuery(trpc.admin.bulkBlock.recentBlocks.queryOptions());

  const unblockMutation = useMutation(
    trpc.admin.bulkBlock.unblockRecentBlock.mutationOptions({
      onSuccess: result => {
        setUnblockTarget(null);
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.bulkBlock.recentBlocks.queryKey(),
        });
        toast.success(`Unblocked ${result.updatedCount.toLocaleString()} users`);
      },
      onError: error => {
        toast.error(error.message || 'Failed to unblock users');
      },
    })
  );

  const rows = data ?? [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Recent Bulk Blocks</CardTitle>
          <CardDescription>
            Blocked accounts grouped by reason and date (based on last update timestamp).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-muted-foreground py-8 text-center text-sm">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center">No blocked accounts found</div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Block Reason</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Accounts Blocked</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => (
                    <TableRow key={`${row.blocked_reason}-${row.date}`}>
                      <TableCell className="font-medium">
                        <code className="bg-muted rounded px-2 py-1 text-sm">
                          {row.blocked_reason}
                        </code>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">{row.date}</TableCell>
                      <TableCell className="p-0 text-right">
                        <Link
                          href={`/admin/users?${new URLSearchParams({ notesSearch: row.blocked_reason, sortBy: 'updated_at', sortOrder: 'desc', blockedStatus: 'blocked' })}`}
                          className="text-primary hover:underline block px-4 py-2"
                        >
                          {row.blocked_count.toLocaleString()} users
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setUnblockTarget(row)}
                          disabled={unblockMutation.isPending}
                        >
                          Unblock
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
      <AlertDialog
        open={unblockTarget !== null}
        onOpenChange={open => {
          if (!open && !unblockMutation.isPending) {
            setUnblockTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unblock this bulk block?</AlertDialogTitle>
            <AlertDialogDescription>
              {unblockTarget && (
                <>
                  This will unblock {unblockTarget.blocked_count.toLocaleString()} users with reason
                  &ldquo;{unblockTarget.blocked_reason}&rdquo; from {unblockTarget.date}. This
                  cannot be undone automatically.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unblockMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!unblockTarget || unblockMutation.isPending}
              onClick={() => {
                if (!unblockTarget) return;
                unblockMutation.mutate({
                  blocked_reason: unblockTarget.blocked_reason,
                  date: unblockTarget.date,
                });
              }}
            >
              {unblockMutation.isPending ? 'Unblocking...' : 'Confirm unblock'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

const DEFAULT_TAB = 'bulk-block';

export function AbuseBulkBlock() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = searchParams.get('tab') || DEFAULT_TAB;

  function setActiveTab(tab: string) {
    const params = new URLSearchParams(searchParams);
    if (tab === DEFAULT_TAB) {
      params.delete('tab');
    } else {
      params.set('tab', tab);
    }
    const qs = params.toString();
    router.push(qs ? `?${qs}` : window.location.pathname);
  }

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
        <TabsTrigger value="bulk-block" className={tabTriggerClass}>
          Bulk Block
        </TabsTrigger>
        <TabsTrigger value="recent" className={tabTriggerClass}>
          Recent Blocks
        </TabsTrigger>
      </TabsList>
      <TabsContent value="bulk-block" className="mt-4">
        <BulkBlockTab />
      </TabsContent>
      <TabsContent value="recent" className="mt-4">
        {activeTab === 'recent' && <RecentBlocksTab />}
      </TabsContent>
    </Tabs>
  );
}
