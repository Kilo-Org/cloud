'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { toast } from 'sonner';
import { AlertTriangle, Zap, ZapOff, Loader2, RefreshCw } from 'lucide-react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Routing Switch</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function RoutingSwitchPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [pendingState, setPendingState] = useState<boolean | null>(null);

  const statusQueryOptions = trpc.admin.routingSwitch.getStatus.queryOptions(undefined, {
    refetchInterval: 15_000,
  });
  const { data, isLoading, isError, error } = useQuery(statusQueryOptions);

  const setStatusMutation = useMutation(
    trpc.admin.routingSwitch.setStatus.mutationOptions({
      onSuccess: result => {
        queryClient.setQueryData(statusQueryOptions.queryKey, result);
        toast.success(
          result.enabled
            ? 'Universal Vercel routing ENABLED — all traffic now routes through Vercel'
            : 'Universal Vercel routing DISABLED — normal routing restored'
        );
        setConfirmDialogOpen(false);
        setPendingState(null);
      },
      onError: err => {
        toast.error(`Failed to toggle routing: ${err.message}`);
        setConfirmDialogOpen(false);
        setPendingState(null);
      },
    })
  );

  const enabled = data?.enabled ?? false;

  function handleToggleClick() {
    setPendingState(!enabled);
    setConfirmDialogOpen(true);
  }

  function handleConfirm() {
    if (pendingState === null) return;
    setStatusMutation.mutate({ enabled: pendingState });
  }

  function handleCancel() {
    setConfirmDialogOpen(false);
    setPendingState(null);
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-6">
        <div>
          <h2 className="text-2xl font-bold">Universal Vercel Routing Switch</h2>
          <p className="text-muted-foreground">
            Control whether all API traffic is routed through Vercel. This affects every request
            across all users. Changes propagate within ~15 seconds.
          </p>
        </div>

        <Card className="border-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Emergency Routing Control
            </CardTitle>
            <CardDescription>
              Toggle universal Vercel routing on or off. This is backed by Vercel Edge Config with a
              15-second in-memory TTL cache.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                <span className="text-muted-foreground ml-3">Loading routing status…</span>
              </div>
            ) : isError ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Failed to load routing status</AlertTitle>
                <AlertDescription>{error?.message ?? 'Unknown error'}</AlertDescription>
              </Alert>
            ) : (
              <div className="flex flex-col items-center gap-8 py-8">
                {/* Big status indicator */}
                <div className="flex flex-col items-center gap-4">
                  <div
                    className={`flex h-32 w-32 items-center justify-center rounded-full border-4 transition-colors duration-500 ${
                      enabled
                        ? 'border-green-500 bg-green-500/20 shadow-[0_0_30px_rgba(34,197,94,0.3)]'
                        : 'border-zinc-600 bg-zinc-800/50'
                    }`}
                  >
                    {enabled ? (
                      <Zap className="h-16 w-16 text-green-400" />
                    ) : (
                      <ZapOff className="h-16 w-16 text-zinc-500" />
                    )}
                  </div>

                  <Badge
                    variant={enabled ? 'default' : 'secondary'}
                    className={`px-4 py-1.5 text-lg font-bold ${
                      enabled ? 'bg-green-600 hover:bg-green-600' : ''
                    }`}
                  >
                    {enabled ? 'ENABLED' : 'DISABLED'}
                  </Badge>

                  <p className="text-muted-foreground max-w-md text-center text-sm">
                    {enabled
                      ? 'All API traffic is currently being routed through Vercel. This is the universal routing mode.'
                      : 'Normal routing is active. API traffic follows the default routing path.'}
                  </p>
                </div>

                {/* The big toggle button */}
                <Button
                  size="lg"
                  variant={enabled ? 'destructive' : 'default'}
                  className={`h-14 px-8 text-lg font-bold transition-all ${
                    enabled ? '' : 'bg-green-600 text-white hover:bg-green-700'
                  }`}
                  onClick={handleToggleClick}
                  disabled={setStatusMutation.isPending}
                >
                  {setStatusMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      Toggling…
                    </>
                  ) : enabled ? (
                    <>
                      <ZapOff className="mr-2 h-5 w-5" />
                      Disable Universal Routing
                    </>
                  ) : (
                    <>
                      <Zap className="mr-2 h-5 w-5" />
                      Enable Universal Routing
                    </>
                  )}
                </Button>

                {/* Refresh hint */}
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <RefreshCw className="h-3 w-3" />
                  Auto-refreshes every 15 seconds
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Warning card */}
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Hold onto your butts</AlertTitle>
          <AlertDescription>
            Toggling this switch affects <strong>all traffic for all users</strong> across the
            entire platform. The change propagates within ~15 seconds via Edge Config&apos;s
            in-memory TTL cache. Make sure you know what you&apos;re doing before flipping this
            switch.
          </AlertDescription>
        </Alert>
      </div>

      {/* Confirmation dialog */}
      <Dialog open={confirmDialogOpen} onOpenChange={open => !open && handleCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              {pendingState ? 'Enable' : 'Disable'} Universal Vercel Routing?
            </DialogTitle>
            <DialogDescription>
              {pendingState
                ? 'This will route ALL API traffic through Vercel for every user on the platform. Are you absolutely sure?'
                : 'This will restore normal routing for all API traffic. Are you sure you want to disable universal Vercel routing?'}
            </DialogDescription>
          </DialogHeader>
          <div className="bg-muted rounded-lg p-4">
            <p className="text-sm font-medium">What will happen:</p>
            <ul className="text-muted-foreground mt-2 list-disc pl-5 text-sm">
              <li>
                The routing flag will be set to{' '}
                <strong>{pendingState ? 'enabled' : 'disabled'}</strong>
              </li>
              <li>All running instances will pick up the change within ~15 seconds</li>
              <li>This action is logged with your admin identity for audit purposes</li>
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancel} disabled={setStatusMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant={pendingState ? 'default' : 'destructive'}
              onClick={handleConfirm}
              disabled={setStatusMutation.isPending}
              className={pendingState ? 'bg-green-600 hover:bg-green-700' : ''}
            >
              {setStatusMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Toggling…
                </>
              ) : (
                `Yes, ${pendingState ? 'enable' : 'disable'} it`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
