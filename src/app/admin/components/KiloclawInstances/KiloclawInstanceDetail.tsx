'use client';

import { useState } from 'react';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  User,
  Calendar,
  Loader2,
  Server,
  Globe,
  HardDrive,
  AlertTriangle,
  ExternalLink,
  Trash2,
  BarChart,
  Camera,
  Play,
  Square,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return '—';
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

function formatAbsoluteTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

function formatEpochTime(epoch: number | null): string {
  if (epoch === null) return '—';
  return new Date(epoch).toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours > 0) return `${hours}h ${remMins}m`;
  return `${mins}m`;
}

type DetailPageWrapperProps = {
  children: React.ReactNode;
  subtitle: string | undefined;
};

function DetailPageWrapper({ children, subtitle }: DetailPageWrapperProps) {
  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/kiloclaw-instances">KiloClaw Instances</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{subtitle ?? 'Instance Details'}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return <AdminPage breadcrumbs={breadcrumbs}>{children}</AdminPage>;
}

function StatusBadge({ status }: { status: string | null }) {
  switch (status) {
    case 'running':
      return <Badge className="bg-green-600">Running</Badge>;
    case 'stopped':
      return <Badge variant="secondary">Stopped</Badge>;
    case 'provisioned':
      return <Badge className="bg-blue-600">Provisioned</Badge>;
    case 'destroying':
      return <Badge variant="destructive">Destroying</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function KiloclawInstanceDetail({ instanceId }: { instanceId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [destroyDialogOpen, setDestroyDialogOpen] = useState(false);

  const { data, isLoading, error } = useQuery(
    trpc.admin.kiloclawInstances.get.queryOptions({ id: instanceId })
  );

  const { mutateAsync: destroyInstance, isPending: isDestroying } = useMutation(
    trpc.admin.kiloclawInstances.destroy.mutationOptions({
      onSuccess: () => {
        toast.success('Instance destroyed successfully');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.get.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.stats.queryKey(),
        });
        setDestroyDialogOpen(false);
      },
      onError: err => {
        toast.error(`Failed to destroy instance: ${err.message}`);
      },
    })
  );

  const volumeId = data?.workerStatus?.flyVolumeId;
  const snapshotsEnabled = data !== undefined && data.destroyed_at === null && !!volumeId;

  const {
    data: snapshotsData,
    isLoading: snapshotsLoading,
    error: snapshotsError,
  } = useQuery({
    ...trpc.admin.kiloclawInstances.volumeSnapshots.queryOptions({
      userId: data?.user_id ?? '',
    }),
    enabled: snapshotsEnabled,
  });

  const gatewayControlsEnabled = data?.destroyed_at === null && !!data?.workerStatus?.flyMachineId;

  const {
    data: gatewayStatus,
    isLoading: gatewayStatusLoading,
    isFetching: gatewayStatusFetching,
    error: gatewayStatusError,
    refetch: refetchGatewayStatus,
  } = useQuery({
    ...trpc.admin.kiloclawInstances.gatewayStatus.queryOptions({
      userId: data?.user_id ?? '',
    }),
    enabled: gatewayControlsEnabled,
    refetchInterval: gatewayControlsEnabled ? 10000 : false,
  });

  const invalidateGatewayQueries = () => {
    if (!data?.user_id) return;
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawInstances.gatewayStatus.queryKey({ userId: data.user_id }),
    });
    void queryClient.invalidateQueries({ queryKey: trpc.admin.kiloclawInstances.get.queryKey() });
  };

  const { mutateAsync: gatewayStart, isPending: isGatewayStarting } = useMutation(
    trpc.admin.kiloclawInstances.gatewayStart.mutationOptions({
      onSuccess: () => {
        toast.success('Gateway start requested');
        invalidateGatewayQueries();
      },
      onError: err => {
        toast.error(`Failed to start gateway: ${err.message}`);
      },
    })
  );

  const { mutateAsync: gatewayStop, isPending: isGatewayStopping } = useMutation(
    trpc.admin.kiloclawInstances.gatewayStop.mutationOptions({
      onSuccess: () => {
        toast.success('Gateway stop requested');
        invalidateGatewayQueries();
      },
      onError: err => {
        toast.error(`Failed to stop gateway: ${err.message}`);
      },
    })
  );

  const { mutateAsync: gatewayRestart, isPending: isGatewayRestarting } = useMutation(
    trpc.admin.kiloclawInstances.gatewayRestart.mutationOptions({
      onSuccess: () => {
        toast.success('Gateway restart requested');
        invalidateGatewayQueries();
      },
      onError: err => {
        toast.error(`Failed to restart gateway: ${err.message}`);
      },
    })
  );

  if (isLoading) {
    return (
      <DetailPageWrapper subtitle={undefined}>
        <div className="flex items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading instance details...</span>
        </div>
      </DetailPageWrapper>
    );
  }

  if (error) {
    return (
      <DetailPageWrapper subtitle={undefined}>
        <Alert variant="destructive">
          <AlertDescription>
            {error instanceof Error ? error.message : 'Failed to load instance'}
          </AlertDescription>
        </Alert>
      </DetailPageWrapper>
    );
  }

  if (!data) {
    return (
      <DetailPageWrapper subtitle={undefined}>
        <Alert variant="destructive">
          <AlertDescription>Instance not found</AlertDescription>
        </Alert>
      </DetailPageWrapper>
    );
  }

  const isActive = data.destroyed_at === null;
  const gatewayActionPending = isGatewayStarting || isGatewayStopping || isGatewayRestarting;

  return (
    <DetailPageWrapper subtitle={data.user_email ?? data.user_id}>
      <div className="flex w-full flex-col gap-6">
        {/* Instance Information */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Instance Information</CardTitle>
                <CardDescription>Database record for this KiloClaw instance</CardDescription>
              </div>
              <div className="flex items-center gap-3">
                {isActive ? (
                  <>
                    <Badge className="bg-green-600">Active</Badge>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDestroyDialogOpen(true)}
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      Destroy Instance
                    </Button>
                  </>
                ) : (
                  <Badge variant="secondary">Destroyed</Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center gap-2">
              <User className="text-muted-foreground h-4 w-4 shrink-0" />
              <DetailField label="User">
                <Link
                  href={`/admin/users/${data.user_id}`}
                  className="text-blue-600 hover:underline"
                >
                  {data.user_email ?? data.user_id}
                </Link>
              </DetailField>
            </div>

            <div className="flex items-center gap-2">
              <Server className="text-muted-foreground h-4 w-4 shrink-0" />
              <DetailField label="Sandbox ID">
                <code className="text-sm">{data.sandbox_id}</code>
              </DetailField>
            </div>

            <div className="flex items-center gap-2">
              <Calendar className="text-muted-foreground h-4 w-4 shrink-0" />
              <DetailField label="Created">
                <span title={formatAbsoluteTime(data.created_at)}>
                  {formatRelativeTime(data.created_at)}
                </span>
              </DetailField>
            </div>

            <div className="flex items-center gap-2">
              <Calendar className="text-muted-foreground h-4 w-4 shrink-0" />
              <DetailField label="Destroyed">
                {data.destroyed_at ? (
                  <span title={formatAbsoluteTime(data.destroyed_at)}>
                    {formatRelativeTime(data.destroyed_at)}
                  </span>
                ) : (
                  '—'
                )}
              </DetailField>
            </div>
          </CardContent>
        </Card>

        {/* Technical Details */}
        <Card>
          <CardHeader>
            <CardTitle>Technical Details</CardTitle>
            <CardDescription>Internal identifiers</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <DetailField label="Instance ID">
              <code className="text-sm">{data.id}</code>
            </DetailField>
            <DetailField label="User ID">
              <code className="text-sm">{data.user_id}</code>
            </DetailField>
          </CardContent>
        </Card>

        {/* Worker Status (active instances only) */}
        {isActive && (
          <Card>
            <CardHeader>
              <CardTitle>Live Worker Status</CardTitle>
              <CardDescription>Real-time status from the KiloClaw Durable Object</CardDescription>
            </CardHeader>
            <CardContent>
              {data.workerStatusError && (
                <Alert className="mb-4">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{data.workerStatusError}</AlertDescription>
                </Alert>
              )}
              {data.workerStatus ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <DetailField label="DO Status">
                    <StatusBadge status={data.workerStatus.status} />
                  </DetailField>

                  <div className="flex items-center gap-2">
                    <Server className="text-muted-foreground h-4 w-4 shrink-0" />
                    <DetailField label="Fly Machine ID">
                      {data.workerStatus.flyMachineId && data.workerStatus.flyAppName ? (
                        <a
                          href={`https://fly.io/apps/${data.workerStatus.flyAppName}/machines/${data.workerStatus.flyMachineId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                        >
                          <code className="text-sm">{data.workerStatus.flyMachineId}</code>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <code className="text-sm">{data.workerStatus.flyMachineId ?? '—'}</code>
                      )}
                    </DetailField>
                  </div>

                  <div className="flex items-center gap-2">
                    <Globe className="text-muted-foreground h-4 w-4 shrink-0" />
                    <DetailField label="Fly Region">
                      {data.workerStatus.flyRegion ?? '—'}
                    </DetailField>
                  </div>

                  <div className="flex items-center gap-2">
                    <HardDrive className="text-muted-foreground h-4 w-4 shrink-0" />
                    <DetailField label="Fly Volume ID">
                      <code className="text-sm">{data.workerStatus.flyVolumeId ?? '—'}</code>
                    </DetailField>
                  </div>

                  <div className="flex items-center gap-2">
                    <Server className="text-muted-foreground h-4 w-4 shrink-0" />
                    <DetailField label="Fly App">
                      {data.workerStatus.flyAppName ? (
                        <a
                          href={`https://fly.io/apps/${data.workerStatus.flyAppName}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                        >
                          <code className="text-sm">{data.workerStatus.flyAppName}</code>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        '—'
                      )}
                    </DetailField>
                  </div>

                  {data.workerStatus.flyAppName && data.workerStatus.flyMachineId && (
                    <div className="flex items-center gap-2">
                      <BarChart className="text-muted-foreground h-4 w-4 shrink-0" />
                      <DetailField label="Metrics">
                        <a
                          href={`https://fly-metrics.net/d/fly-instance/fly-instance?from=now-1h&orgId=1480569&to=now&var-app=${data.workerStatus.flyAppName}&var-instance=${data.workerStatus.flyMachineId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                        >
                          <span className="text-sm">View Grafana Dashboard</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </DetailField>
                    </div>
                  )}

                  <DetailField label="Provisioned At">
                    {formatEpochTime(data.workerStatus.provisionedAt)}
                  </DetailField>

                  <DetailField label="Last Started At">
                    {formatEpochTime(data.workerStatus.lastStartedAt)}
                  </DetailField>

                  <DetailField label="Last Stopped At">
                    {formatEpochTime(data.workerStatus.lastStoppedAt)}
                  </DetailField>

                  <DetailField label="Env Vars">{data.workerStatus.envVarCount}</DetailField>

                  <DetailField label="Secrets">{data.workerStatus.secretCount}</DetailField>

                  <DetailField label="Channels">{data.workerStatus.channelCount}</DetailField>
                </div>
              ) : !data.workerStatusError ? (
                <p className="text-muted-foreground text-sm">No worker status available</p>
              ) : null}
            </CardContent>
          </Card>
        )}

        {/* Gateway Process (controller) */}
        {isActive && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>Gateway Process</CardTitle>
                  <CardDescription>
                    Controller-backed OpenClaw gateway process controls
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refetchGatewayStatus()}
                  disabled={!gatewayControlsEnabled || gatewayStatusFetching}
                >
                  {gatewayStatusFetching ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-4 w-4" />
                  )}
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {!gatewayControlsEnabled && (
                <p className="text-muted-foreground text-sm">
                  Gateway process controls are available when the instance has a machine ID.
                </p>
              )}

              {gatewayControlsEnabled && gatewayStatusLoading && (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-muted-foreground text-sm">Loading gateway status...</span>
                </div>
              )}

              {gatewayControlsEnabled && gatewayStatusError && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {gatewayStatusError instanceof Error
                      ? gatewayStatusError.message
                      : 'Failed to load gateway status'}
                  </AlertDescription>
                </Alert>
              )}

              {gatewayControlsEnabled && gatewayStatus && (
                <>
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    <DetailField label="State">
                      <Badge variant={gatewayStatus.state === 'running' ? 'default' : 'secondary'}>
                        {gatewayStatus.state}
                      </Badge>
                    </DetailField>
                    <DetailField label="PID">{gatewayStatus.pid ?? '—'}</DetailField>
                    <DetailField label="Uptime">{formatUptime(gatewayStatus.uptime)}</DetailField>
                    <DetailField label="Restarts">{gatewayStatus.restarts}</DetailField>
                    <DetailField label="Last Exit">
                      {gatewayStatus.lastExit
                        ? `${gatewayStatus.lastExit.code ?? 'null'} / ${
                            gatewayStatus.lastExit.signal ?? 'none'
                          } @ ${formatAbsoluteTime(gatewayStatus.lastExit.at)}`
                        : '—'}
                    </DetailField>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={gatewayActionPending}
                      onClick={() => void gatewayStart({ userId: data.user_id })}
                    >
                      {isGatewayStarting ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="mr-1 h-4 w-4" />
                      )}
                      Start
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={gatewayActionPending}
                      onClick={() => void gatewayStop({ userId: data.user_id })}
                    >
                      {isGatewayStopping ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Square className="mr-1 h-4 w-4" />
                      )}
                      Stop
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={gatewayActionPending}
                      onClick={() => void gatewayRestart({ userId: data.user_id })}
                    >
                      {isGatewayRestarting ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1 h-4 w-4" />
                      )}
                      Restart
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Volume Snapshots */}
        {snapshotsEnabled && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Camera className="text-muted-foreground h-5 w-5" />
                <div>
                  <CardTitle>Volume Snapshots</CardTitle>
                  <CardDescription>
                    Fly automatic backups for volume{' '}
                    {data.workerStatus?.flyAppName ? (
                      <a
                        href={`https://fly.io/apps/${data.workerStatus.flyAppName}/volumes/${volumeId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        {volumeId}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      volumeId
                    )}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {snapshotsLoading && (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-muted-foreground text-sm">Loading snapshots...</span>
                </div>
              )}
              {snapshotsError && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {snapshotsError instanceof Error
                      ? snapshotsError.message
                      : 'Failed to load snapshots'}
                  </AlertDescription>
                </Alert>
              )}
              {snapshotsData && snapshotsData.snapshots.length === 0 && (
                <p className="text-muted-foreground text-sm">No snapshots available yet.</p>
              )}
              {snapshotsData && snapshotsData.snapshots.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-muted-foreground border-b text-left text-xs">
                        <th className="pr-4 pb-2">Created</th>
                        <th className="pr-4 pb-2">Status</th>
                        <th className="pr-4 pb-2">Size</th>
                        <th className="pr-4 pb-2">Retention</th>
                        <th className="pb-2">ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshotsData.snapshots.map(snap => (
                        <tr key={snap.id} className="border-b last:border-0">
                          <td className="py-2 pr-4">
                            {snap.created_at && !snap.created_at.startsWith('0001-') ? (
                              <span title={formatAbsoluteTime(snap.created_at)}>
                                {formatRelativeTime(snap.created_at)}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2 pr-4">
                            <Badge
                              variant={snap.status === 'complete' ? 'default' : 'secondary'}
                              className={snap.status === 'complete' ? 'bg-green-600' : ''}
                            >
                              {snap.status}
                            </Badge>
                          </td>
                          <td className="py-2 pr-4">{formatBytes(snap.size)}</td>
                          <td className="py-2 pr-4">
                            {snap.retention_days ? `${snap.retention_days}d` : '—'}
                          </td>
                          <td className="py-2">
                            <code className="text-xs">{snap.id}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Destroyed notice */}
        {!isActive && (
          <Card>
            <CardHeader>
              <CardTitle>Live Worker Status</CardTitle>
              <CardDescription>Real-time status from the KiloClaw Durable Object</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Worker status is not available for destroyed instances.
              </p>
            </CardContent>
          </Card>
        )}
        {/* Destroy Confirmation Dialog */}
        <Dialog open={destroyDialogOpen} onOpenChange={setDestroyDialogOpen}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Destroy Instance
              </DialogTitle>
              <DialogDescription className="pt-3">
                Are you sure you want to destroy this KiloClaw instance?
                <span className="text-foreground mt-2 block font-medium">
                  User: {data.user_email ?? data.user_id}
                </span>
                <span className="mt-2 block">
                  This will stop the Fly machine and mark the instance as destroyed. The user will
                  need to re-provision to use KiloClaw again.
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <DialogClose asChild>
                <Button variant="secondary" disabled={isDestroying}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                onClick={() => void destroyInstance({ id: data.id })}
                disabled={isDestroying}
              >
                {isDestroying ? 'Destroying...' : 'Destroy Instance'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DetailPageWrapper>
  );
}
