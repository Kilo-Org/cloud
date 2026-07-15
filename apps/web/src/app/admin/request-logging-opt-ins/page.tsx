'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
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

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Request Logging Opt-ins</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function RequestLoggingOptInsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listOptions = trpc.admin.requestLoggingOptIns.list.queryOptions();
  const { data: optIns, isLoading } = useQuery(listOptions);
  const [targetType, setTargetType] = useState<'account' | 'organization'>('account');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: listOptions.queryKey });
  const createMutation = useMutation(
    trpc.admin.requestLoggingOptIns.create.mutationOptions({
      onSuccess: () => {
        toast.success('Request logging enabled');
        setTargetId('');
        setReason('');
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
    createMutation.mutate({ target_type: targetType, target_id: targetId, reason });
  }

  function handleTargetTypeChange(value: string) {
    if (value === 'account' || value === 'organization') {
      setTargetType(value);
    }
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-6">
        <div>
          <h1 className="type-title">Request Logging Opt-ins</h1>
          <p className="text-muted-foreground mt-1 type-body">
            Enable AI gateway request and response logging for a specific account or organization.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Create opt-in</CardTitle>
            <CardDescription>
              Logging may capture customer prompts and model responses. Add a clear support or
              investigation reason.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 md:grid-cols-[180px_minmax(240px,1fr)_minmax(280px,2fr)_auto] md:items-end"
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
              <Button
                type="submit"
                disabled={createMutation.isPending || !targetId.trim() || !reason.trim()}
              >
                {createMutation.isPending ? 'Enabling…' : 'Enable logging'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Active opt-ins</CardTitle>
            <CardDescription>
              Hardcoded Kilo organization and email-domain opt-ins are not listed here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Added by</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      Loading opt-ins…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && optIns?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      No dynamic request logging opt-ins.
                    </TableCell>
                  </TableRow>
                )}
                {optIns?.map(entry => (
                  <TableRow key={entry.id}>
                    <TableCell className="capitalize">{entry.target_type}</TableCell>
                    <TableCell className="font-mono text-xs break-all">{entry.target_id}</TableCell>
                    <TableCell className="max-w-md whitespace-pre-wrap">{entry.reason}</TableCell>
                    <TableCell>{entry.added_by_email}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {new Date(entry.added_at).toLocaleString()}
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
                        {deleteMutation.isPending && deletingId === entry.id
                          ? 'Deleting…'
                          : 'Delete'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  );
}
