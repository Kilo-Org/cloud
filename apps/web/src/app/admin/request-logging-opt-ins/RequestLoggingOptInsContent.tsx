'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useNowTicker } from '@/app/(app)/claw/kilo-chat/components/BotStatus';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';

export default function RequestLoggingOptInsContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listOptions = trpc.admin.requestLoggingOptIns.list.queryOptions();
  const { data: optIns, isLoading } = useQuery(listOptions);
  const [targetType, setTargetType] = useState<'account' | 'organization'>('account');
  const [targetId, setTargetId] = useState('');
  const [scope, setScope] = useState<'all' | 'errors_only'>('all');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const now = useNowTicker(10_000);
  const optInCount = optIns?.length ?? 0;
  const isOverCapacity = optInCount > 10;
  const activeOptInCount =
    optIns?.filter(entry => !entry.expires_at || new Date(entry.expires_at).getTime() > now)
      .length ?? 0;
  const isAtLimit = activeOptInCount >= 10;

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: listOptions.queryKey });
  const createMutation = useMutation(
    trpc.admin.requestLoggingOptIns.create.mutationOptions({
      onSuccess: () => {
        toast.success('Request logging enabled');
        setTargetId('');
        setReason('');
        setExpiresAt('');
        void invalidateList();
      },
      onError: error => toast.error(error.message || 'Request logging could not be enabled.'),
    })
  );
  const deleteMutation = useMutation(
    trpc.admin.requestLoggingOptIns.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Request logging opt-in deleted');
        void invalidateList();
      },
      onError: error =>
        toast.error(error.message || 'Request logging opt-in could not be deleted.'),
      onSettled: () => setDeletingId(null),
    })
  );

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isLoading || isAtLimit || createMutation.isPending) {
      return;
    }
    createMutation.mutate({
      target_type: targetType,
      target_id: targetId,
      reason,
      errors_only: scope === 'errors_only',
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    });
  }

  function handleTargetTypeChange(value: string) {
    if (value === 'account' || value === 'organization') {
      setTargetType(value);
    }
  }

  function handleScopeChange(value: string) {
    if (value === 'all' || value === 'errors_only') {
      setScope(value);
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Enable request logging</CardTitle>
          <CardDescription>
            Logs gateway requests and responses for an account or organization, including customer
            prompts. Add a clear support or investigation reason.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-2 md:items-end xl:grid-cols-3"
            onSubmit={handleCreate}
          >
            <div className="grid gap-2">
              <Label htmlFor="target-type">ID type</Label>
              <Select value={targetType} onValueChange={handleTargetTypeChange}>
                <SelectTrigger id="target-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="account">Account</SelectItem>
                  <SelectItem value="organization">Organization</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="target-id">ID</Label>
              <Input
                id="target-id"
                className="font-mono"
                value={targetId}
                onChange={event => setTargetId(event.target.value)}
                required
                maxLength={255}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="scope">Log</Label>
              <Select value={scope} onValueChange={handleScopeChange}>
                <SelectTrigger id="scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All requests</SelectItem>
                  <SelectItem value="errors_only">Errors only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="reason">Reason</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={event => setReason(event.target.value)}
                required
                maxLength={1000}
                className="min-h-9"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="expires-at">End date (optional, local time)</Label>
              <Input
                id="expires-at"
                type="datetime-local"
                value={expiresAt}
                onChange={event => setExpiresAt(event.target.value)}
                aria-describedby="expires-at-help"
              />
              <p id="expires-at-help" className="text-muted-foreground text-sm">
                Leave blank for no expiration.
              </p>
            </div>
            <Button
              type="submit"
              disabled={
                isLoading ||
                isAtLimit ||
                createMutation.isPending ||
                !targetId.trim() ||
                !reason.trim()
              }
              aria-describedby="opt-in-limit"
            >
              {createMutation.isPending ? 'Enabling…' : 'Enable logging'}
            </Button>
          </form>
          <p id="opt-in-limit" className="text-muted-foreground mt-4 text-sm" role="status">
            {isLoading ? 'Loading active opt-ins…' : `${activeOptInCount} of 10 active opt-ins.`}{' '}
            {isAtLimit
              ? 'Delete an active opt-in or wait for one to expire to enable logging.'
              : 'Expired opt-ins do not count toward this limit.'}
          </p>
          {isOverCapacity && (
            <p className="text-destructive mt-2 text-sm" role="status">
              Request logging is disabled while {optInCount} opt-ins are stored. Delete opt-ins
              until 10 or fewer remain.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Request logging opt-ins</CardTitle>
          <CardDescription>
            Errors-only opt-ins log responses with status 400 or higher, a response read error,
            invalid tool call arguments, or a guardrail rejection. When an account and its
            organization both match, the broader opt-in wins.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Log</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Added by</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>Expires (local time)</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    Loading opt-ins…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && optIns?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    No request logging opt-ins.
                  </TableCell>
                </TableRow>
              )}
              {optIns?.map(entry => (
                <TableRow key={entry.id}>
                  <TableCell className="capitalize">{entry.target_type}</TableCell>
                  <TableCell className="min-w-[calc(36ch+1.5rem)] font-mono text-xs break-all">
                    {entry.target_id}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {entry.errors_only ? 'Errors only' : 'All requests'}
                  </TableCell>
                  <TableCell className="max-w-md min-w-48 break-words whitespace-pre-wrap">
                    {entry.reason}
                  </TableCell>
                  <TableCell>{entry.added_by_email}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {new Date(entry.added_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {entry.expires_at
                      ? new Date(entry.expires_at).toLocaleString()
                      : 'No expiration'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={deleteMutation.isPending && deletingId === entry.id}
                      onClick={() => {
                        setDeletingId(entry.id);
                        deleteMutation.mutate({ id: entry.id });
                      }}
                    >
                      {deleteMutation.isPending && deletingId === entry.id ? 'Deleting…' : 'Delete'}
                    </Button>
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
