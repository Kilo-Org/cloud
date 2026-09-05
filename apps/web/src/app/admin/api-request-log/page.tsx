'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

const BYTES_PER_GIGABYTE = 1024 * 1024 * 1024;

export default function ApiRequestLogPage() {
  const [userId, setUserId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [model, setModel] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [truncateDialogOpen, setTruncateDialogOpen] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const summaryOptions = trpc.admin.apiRequestLog.getSummary.queryOptions();
  const summaryQuery = useQuery(summaryOptions);
  const truncateMutation = useMutation(
    trpc.admin.apiRequestLog.truncate.mutationOptions({
      onSuccess: () => {
        toast.success('API request log truncated');
        setTruncateDialogOpen(false);
        void queryClient.invalidateQueries({ queryKey: summaryOptions.queryKey });
      },
      onError: error => {
        toast.error('Could not truncate API request log', { description: error.message });
      },
    })
  );

  function handleDownload() {
    const params = new URLSearchParams();
    if (userId.trim()) {
      params.set('userId', userId.trim());
    }
    if (startDate) {
      params.set('startDate', startDate);
    }
    if (endDate) {
      params.set('endDate', endDate);
    }
    if (model.trim()) {
      params.set('model', model.trim());
    }
    if (sessionId.trim()) {
      params.set('sessionId', sessionId.trim());
    }
    if (errorsOnly) {
      params.set('errorsOnly', 'true');
    }

    // Navigate directly to preserve server-side streaming
    window.location.href = `/admin/api/api-request-log/download?${params}`;
  }

  return (
    <AdminPage
      breadcrumbs={<BreadcrumbItem className="hidden md:block">API Request Log</BreadcrumbItem>}
    >
      <div className="w-full max-w-xl space-y-4">
        {summaryQuery.data && (
          <p className="text-muted-foreground text-sm tabular-nums">
            {summaryQuery.data.recordCount.toLocaleString()}{' '}
            {summaryQuery.data.recordCount === 1 ? 'record' : 'records'} ·{' '}
            {(summaryQuery.data.sizeBytes / BYTES_PER_GIGABYTE).toFixed(2)} GB
            {summaryQuery.data.oldestCreatedAt && (
              <>
                {' '}
                · oldest entry{' '}
                <span title={new Date(summaryQuery.data.oldestCreatedAt).toLocaleString()}>
                  {formatDistanceToNow(new Date(summaryQuery.data.oldestCreatedAt), {
                    addSuffix: true,
                  })}
                </span>
              </>
            )}
          </p>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Download API Request Log</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="userId">User ID (optional)</Label>
              <Input
                id="userId"
                placeholder="Enter user ID"
                value={userId}
                onChange={e => setUserId(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="model">Model (optional)</Label>
              <Input
                id="model"
                placeholder="e.g. claude-sonnet-4-20250514"
                value={model}
                onChange={e => setModel(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="sessionId">Session ID (optional)</Label>
              <Input
                id="sessionId"
                placeholder="Enter session ID"
                value={sessionId}
                onChange={e => setSessionId(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date (optional)</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date (optional)</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="errorsOnly"
                checked={errorsOnly}
                onCheckedChange={checked => setErrorsOnly(checked === true)}
              />
              <Label htmlFor="errorsOnly" className="cursor-pointer">
                Errors only (status &ge; 400 or error present)
              </Label>
            </div>

            <Button onClick={handleDownload} className="w-full">
              <Download className="mr-2 h-4 w-4" />
              Download ZIP
            </Button>
          </CardContent>
        </Card>
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Danger zone</CardTitle>
            <CardDescription>
              Permanently remove every record from the API request log table.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog
              open={truncateDialogOpen}
              onOpenChange={open => {
                if (!truncateMutation.isPending) setTruncateDialogOpen(open);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={truncateMutation.isPending}>
                  <Trash2 className="size-4" aria-hidden="true" />
                  Truncate API request log
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Truncate API request log?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes every record in{' '}
                    <span className="text-foreground font-mono">api_request_log</span>. This action
                    cannot be undone. New gateway requests will continue to be logged.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={truncateMutation.isPending}>
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={truncateMutation.isPending}
                    onClick={() => truncateMutation.mutate({ confirmation: 'api_request_log' })}
                  >
                    {truncateMutation.isPending ? 'Truncating...' : 'Truncate table'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  );
}
