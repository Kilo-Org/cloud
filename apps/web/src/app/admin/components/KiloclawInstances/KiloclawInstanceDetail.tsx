'use client';

import { useEffect, useRef, useState } from 'react';
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
import { calverAtLeast, cleanVersion } from '@/lib/kiloclaw/version';
import { formatBytes, formatUptime, formatVolumeUsage } from '@/lib/kiloclaw/instance-display';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  RotateCw,
  ArrowUpCircle,
  ArrowUpDown,
  RefreshCw,
  Pin,
  Stethoscope,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  Activity,
  Copy,
} from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { stripAnsi } from '@/lib/stripAnsi';
import { DetailField, formatAbsoluteTime, formatRelativeTime, parseTimestamp } from './shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { AdminFileEditor } from './AdminFileEditor';
import { KiloCliRunCard } from './KiloCliRunCard';
import { BumpVolumeTo15GbButton } from './BumpVolumeTo15GbDialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useKiloclawInstanceEvents,
  useKiloclawAllEvents,
  type KiloclawEventRow,
  type KiloclawAllEventRow,
} from '@/app/admin/api/kiloclaw-analytics/hooks';
import type { AnalyticsEngineResponse, ControllerTelemetryRow } from '@/lib/kiloclaw/disk-usage';

function formatEpochTime(epoch: number | null): string {
  if (epoch === null) return '—';
  return new Date(epoch).toLocaleString();
}

function formatEpochRelativeTime(epoch: number | null): string {
  if (epoch === null) return '—';
  return formatDistanceToNow(new Date(epoch), { addSuffix: true });
}

function useControllerTelemetryDiskUsage(sandboxId: string) {
  return useQuery<AnalyticsEngineResponse<ControllerTelemetryRow>>({
    queryKey: ['kiloclaw-controller-telemetry', 'disk-usage', sandboxId],
    queryFn: async () => {
      const response = await fetch(
        `/admin/api/kiloclaw-controller-telemetry?sandboxId=${encodeURIComponent(sandboxId)}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch controller telemetry disk usage');
      }
      return response.json() as Promise<AnalyticsEngineResponse<ControllerTelemetryRow>>;
    },
    enabled: !!sandboxId,
    refetchInterval: 60_000,
  });
}

type DetailPageWrapperProps = {
  children: React.ReactNode;
  subtitle: string | undefined;
};

function DetailPageWrapper({ children, subtitle }: DetailPageWrapperProps) {
  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/kiloclaw">KiloClaw</BreadcrumbLink>
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
    case 'starting':
      return <Badge className="bg-blue-500">Starting</Badge>;
    case 'restarting':
      return <Badge className="bg-amber-500">Restarting</Badge>;
    case 'recovering':
      return <Badge className="bg-orange-600">Recovering</Badge>;
    case 'restoring':
      return <Badge className="bg-violet-600">Restoring</Badge>;
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

function CopySshCommandButton({
  flyAppName,
  flyMachineId,
}: {
  flyAppName: string;
  flyMachineId: string;
}) {
  const command = `fly ssh console --machine ${flyMachineId} -a ${flyAppName}`;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('SSH command copied to clipboard');
    } catch {
      toast.error('Failed to copy SSH command');
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" onClick={() => void copyCommand()}>
          <Copy className="mr-1 h-3.5 w-3.5" />
          Copy SSH
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <code>{command}</code>
      </TooltipContent>
    </Tooltip>
  );
}

function VersionPinCard({ userId, instanceId }: { userId: string; instanceId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [reason, setReason] = useState('');

  const { data: pinData, isLoading: pinLoading } = useQuery(
    trpc.admin.kiloclawVersions.getUserPin.queryOptions({ userId, instanceId })
  );

  const { data: versionsData } = useQuery(
    trpc.admin.kiloclawVersions.listVersions.queryOptions({
      status: 'available',
      limit: 100,
    })
  );

  const { mutateAsync: setPin, isPending: isPinning } = useMutation(
    trpc.admin.kiloclawVersions.setPin.mutationOptions({
      onSuccess: () => {
        toast.success('Version pin set');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawVersions.getUserPin.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawVersions.listPins.queryKey(),
        });
        setSelectedTag('');
        setReason('');
      },
      onError: err => {
        toast.error(`Failed to set pin: ${err.message}`);
      },
    })
  );

  const { mutateAsync: removePin, isPending: isUnpinning } = useMutation(
    trpc.admin.kiloclawVersions.removePin.mutationOptions({
      onSuccess: () => {
        toast.success('Version pin removed');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawVersions.getUserPin.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawVersions.listPins.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to remove pin: ${err.message}`);
      },
    })
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Pin className="h-5 w-5" />
          <CardTitle>Version Pin</CardTitle>
        </div>
        <CardDescription>Pin this user to a specific KiloClaw image tag</CardDescription>
      </CardHeader>
      <CardContent>
        {pinLoading ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-sm">Loading pin status...</span>
          </div>
        ) : pinData ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <DetailField label="Pinned Image Tag">
                <Badge className="bg-blue-600 font-mono text-xs">{pinData.image_tag}</Badge>
              </DetailField>
              <DetailField label="OpenClaw Version">{pinData.openclaw_version ?? '—'}</DetailField>
              <DetailField label="Variant">{pinData.variant ?? 'default'}</DetailField>
              <DetailField label="Pinned By">
                {pinData.pinned_by_email ?? pinData.pinned_by}
              </DetailField>
              {pinData.reason && <DetailField label="Reason">{pinData.reason}</DetailField>}
            </div>
            <div className="space-y-2 pt-2">
              <div className="flex items-center gap-2">
                <Select value={selectedTag} onValueChange={setSelectedTag}>
                  <SelectTrigger className="w-[250px]">
                    <SelectValue placeholder="Change image tag..." />
                  </SelectTrigger>
                  <SelectContent>
                    {versionsData?.items.map(v => (
                      <SelectItem key={v.image_tag} value={v.image_tag}>
                        {v.image_tag} (OpenClaw {v.openclaw_version})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Reason (optional)"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-[200px]"
                />
                {selectedTag && (
                  <Button
                    size="sm"
                    onClick={() =>
                      void setPin({
                        userId,
                        instanceId,
                        imageTag: selectedTag,
                        reason: reason || undefined,
                      })
                    }
                    disabled={isPinning}
                  >
                    {isPinning ? 'Updating...' : 'Update Pin'}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void removePin({ instanceId })}
                  disabled={isUnpinning}
                >
                  {isUnpinning ? 'Unpinning...' : 'Unpin'}
                </Button>
              </div>
              <p className="flex items-center gap-1 text-xs text-red-400">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Reason is visible to the end user.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">Following latest available version</p>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Select value={selectedTag} onValueChange={setSelectedTag}>
                  <SelectTrigger className="w-[250px]">
                    <SelectValue placeholder="Select image tag to pin..." />
                  </SelectTrigger>
                  <SelectContent>
                    {versionsData?.items.map(v => (
                      <SelectItem key={v.image_tag} value={v.image_tag}>
                        {v.image_tag} (OpenClaw {v.openclaw_version})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Reason (optional)"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-[200px]"
                />
                <Button
                  size="sm"
                  onClick={() =>
                    void setPin({
                      userId,
                      instanceId,
                      imageTag: selectedTag,
                      reason: reason || undefined,
                    })
                  }
                  disabled={!selectedTag || isPinning}
                >
                  {isPinning ? 'Pinning...' : 'Pin Version'}
                </Button>
              </div>
              <p className="flex items-center gap-1 text-xs text-red-400">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Reason is visible to the end user.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type ReassociatePhase =
  | 'idle'
  | 'stopping'
  | 'reassociating'
  | 'starting'
  | 'waiting'
  | 'done'
  | 'error';

const PHASE_LABELS: Record<ReassociatePhase, string> = {
  idle: '',
  stopping: 'Stopping machine...',
  reassociating: 'Reassociating volume...',
  starting: 'Starting machine...',
  waiting: 'Waiting for machine to be ready...',
  done: 'Complete',
  error: 'Failed',
};

function VolumeReassociationCard({
  userId,
  instanceId,
  currentStatus,
  currentMachineId,
  previousVolumeId,
  onStatusChange,
}: {
  userId: string;
  instanceId: string;
  currentStatus: string | null;
  currentMachineId: string | null;
  previousVolumeId: string | null;
  onStatusChange: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [selectedVolumeId, setSelectedVolumeId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [phase, setPhase] = useState<ReassociatePhase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    data: candidateData,
    isLoading: candidatesLoading,
    error: candidatesError,
    refetch: refetchCandidates,
  } = useQuery({
    ...trpc.admin.kiloclawInstances.candidateVolumes.queryOptions({ userId, instanceId }),
    enabled: expanded,
  });

  const { data: auditLogs } = useQuery({
    ...trpc.admin.kiloclawInstances.adminAuditLogs.queryOptions({
      userId,
      action: 'kiloclaw.volume.reassociate',
      limit: 10,
    }),
    enabled: expanded || phase === 'done',
  });

  const isStopped = currentStatus === 'stopped';
  const isInProgress = phase !== 'idle' && phase !== 'done' && phase !== 'error';

  // Poll parent status during active phases
  const polling = phase === 'stopping' || phase === 'starting' || phase === 'waiting';
  useQuery({
    queryKey: ['volume-reassociate-poll', userId, instanceId, polling],
    queryFn: async () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.admin.kiloclawInstances.get.queryKey(),
      });
      onStatusChange();
      return { ts: Date.now() };
    },
    enabled: polling,
    refetchInterval: polling ? 3000 : false,
  });

  // Advance phase based on machine status changes
  if (phase === 'waiting' && currentStatus === 'running') {
    setPhase('done');
    void refetchCandidates();
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawInstances.adminAuditLogs.queryKey(),
    });
  }

  const { mutateAsync: machineStop } = useMutation(
    trpc.admin.kiloclawInstances.machineStop.mutationOptions()
  );

  const { mutateAsync: reassociate } = useMutation(
    trpc.admin.kiloclawInstances.reassociateVolume.mutationOptions()
  );

  const { mutateAsync: machineStart } = useMutation(
    trpc.admin.kiloclawInstances.machineStart.mutationOptions()
  );

  const handleReassociate = async () => {
    setConfirmDialogOpen(false);
    setErrorMessage(null);

    try {
      // Step 1: Stop if not already stopped
      if (!isStopped) {
        setPhase('stopping');
        await machineStop({ userId, instanceId });
        // Wait for stopped state
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Step 2: Reassociate
      setPhase('reassociating');
      await reassociate({ userId, instanceId, newVolumeId: selectedVolumeId, reason });

      // Step 3: Start
      setPhase('starting');
      await machineStart({ userId, instanceId });

      // Step 4: Wait for running
      setPhase('waiting');
      setSelectedVolumeId('');
      setReason('');
    } catch (err) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : 'An unknown error occurred');
    }
  };

  const resetState = () => {
    setPhase('idle');
    setErrorMessage(null);
    setSelectedVolumeId('');
    setReason('');
    setExpanded(false);
  };

  const currentVolume = candidateData?.volumes.find(v => v.isCurrent);
  const selectedVolume = candidateData?.volumes.find(v => v.id === selectedVolumeId);

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="text-destructive h-5 w-5 shrink-0" />
            <div>
              <CardTitle className="text-destructive">Volume Reassociation</CardTitle>
              <CardDescription>
                Change the Fly volume attached to this instance. This is a dangerous operation.
              </CardDescription>
            </div>
          </div>
          {!expanded && phase === 'idle' && (
            <Button variant="destructive" size="sm" onClick={() => setExpanded(true)}>
              <ShieldAlert className="mr-1 h-4 w-4" />
              Change Volume
            </Button>
          )}
        </div>
      </CardHeader>

      {/* Progress indicator — shown when operation is in flight */}
      {isInProgress && (
        <CardContent>
          <div className="flex items-center gap-3 rounded border p-4">
            <Loader2 className="text-destructive h-5 w-5 shrink-0 animate-spin" />
            <div className="space-y-1">
              <p className="text-sm font-medium">{PHASE_LABELS[phase]}</p>
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                {(['stopping', 'reassociating', 'starting', 'waiting'] as const).map((step, i) => (
                  <span key={step} className="flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground/50">&rarr;</span>}
                    <span
                      className={
                        phase === step
                          ? 'text-destructive font-medium'
                          : (['stopping', 'reassociating', 'starting', 'waiting'] as const).indexOf(
                                phase
                              ) > i
                            ? 'text-foreground'
                            : ''
                      }
                    >
                      {step === 'stopping'
                        ? 'Stop'
                        : step === 'reassociating'
                          ? 'Reassociate'
                          : step === 'starting'
                            ? 'Start'
                            : 'Health check'}
                    </span>
                  </span>
                ))}
              </div>
              {currentStatus && (
                <p className="text-muted-foreground text-xs">
                  Machine status: <StatusBadge status={currentStatus} />
                </p>
              )}
            </div>
          </div>
        </CardContent>
      )}

      {/* Done state */}
      {phase === 'done' && (
        <CardContent>
          <div className="flex items-center gap-3 rounded border border-green-600/30 bg-green-600/5 p-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
            <div>
              <p className="text-sm font-medium text-green-600">Volume reassociation complete</p>
              <p className="text-muted-foreground text-xs">
                Machine is running with the new volume.
              </p>
            </div>
            <Button variant="outline" size="sm" className="ml-auto" onClick={resetState}>
              Dismiss
            </Button>
          </div>
        </CardContent>
      )}

      {/* Error state */}
      {phase === 'error' && (
        <CardContent>
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>
              <p>{errorMessage}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Check the machine status above and retry if needed.
              </p>
            </AlertDescription>
          </Alert>
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" onClick={resetState}>
              Dismiss
            </Button>
          </div>
        </CardContent>
      )}

      {/* Selection UI — only when idle and expanded */}
      {expanded && phase === 'idle' && (
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Changing the volume will remount the machine&apos;s /root directory to a different Fly
              volume. This directly edits the Durable Object storage. The machine will be{' '}
              {isStopped ? 'started' : 'stopped and restarted'} after reassociation.
            </AlertDescription>
          </Alert>

          {candidatesLoading && (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-muted-foreground text-sm">Loading candidate volumes...</span>
            </div>
          )}

          {candidatesError && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {candidatesError instanceof Error
                  ? candidatesError.message
                  : 'Failed to load candidate volumes'}
              </AlertDescription>
            </Alert>
          )}

          {candidateData && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Current Volume</label>
                <code className="bg-muted block rounded p-2 text-sm">
                  {candidateData.currentVolumeId ?? 'None'}
                </code>
              </div>

              {candidateData.volumes.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No candidate volumes found in this Fly app.
                </p>
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Select New Volume</label>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-muted-foreground border-b text-left text-xs">
                            <th className="pr-4 pb-2">Select</th>
                            <th className="pr-4 pb-2">Volume ID</th>
                            <th className="pr-4 pb-2">Name</th>
                            <th className="pr-4 pb-2">Size</th>
                            <th className="pr-4 pb-2">Region</th>
                            <th className="pr-4 pb-2">Attached Machine</th>
                            <th className="pb-2">Created</th>
                          </tr>
                        </thead>
                        <tbody>
                          {candidateData.volumes.map(vol => {
                            const isPrevious =
                              !vol.isCurrent && !!previousVolumeId && vol.id === previousVolumeId;
                            const attachedElsewhere =
                              !!vol.attached_machine_id &&
                              vol.attached_machine_id !== currentMachineId;
                            const isDisabled = vol.isCurrent || attachedElsewhere;
                            return (
                              <tr
                                key={vol.id}
                                className={`border-b last:border-0 ${
                                  vol.isCurrent ? 'bg-muted/50' : ''
                                } ${attachedElsewhere ? 'opacity-60' : ''} ${selectedVolumeId === vol.id ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}
                              >
                                <td className="py-2 pr-4">
                                  <input
                                    type="radio"
                                    name="volume-select"
                                    checked={selectedVolumeId === vol.id}
                                    disabled={isDisabled}
                                    onChange={() => setSelectedVolumeId(vol.id)}
                                  />
                                </td>
                                <td className="py-2 pr-4">
                                  <code className="text-xs">{vol.id}</code>
                                  {vol.isCurrent && (
                                    <Badge className="ml-2 bg-green-600" variant="default">
                                      current
                                    </Badge>
                                  )}
                                  {isPrevious && (
                                    <Badge className="ml-2 bg-amber-600" variant="default">
                                      previous
                                    </Badge>
                                  )}
                                  {attachedElsewhere && (
                                    <Badge className="ml-2" variant="destructive">
                                      attached elsewhere
                                    </Badge>
                                  )}
                                </td>
                                <td className="py-2 pr-4">
                                  <code className="text-xs">{vol.name}</code>
                                </td>
                                <td className="py-2 pr-4">{vol.size_gb} GB</td>
                                <td className="py-2 pr-4">{vol.region}</td>
                                <td className="py-2 pr-4">
                                  <code className="text-xs">{vol.attached_machine_id ?? '—'}</code>
                                </td>
                                <td className="py-2">
                                  {vol.created_at ? (
                                    <span title={formatAbsoluteTime(vol.created_at)}>
                                      {formatRelativeTime(vol.created_at)}
                                    </span>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Reason for change{' '}
                      <span className="text-muted-foreground">(min 10 chars)</span>
                    </label>
                    <Textarea
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      placeholder="e.g., Volume was swapped during migration, wrong flyVolumeId stored..."
                      maxLength={500}
                      className="resize-none"
                      rows={2}
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={!selectedVolumeId || reason.length < 10}
                      onClick={() => setConfirmDialogOpen(true)}
                    >
                      Reassociate Volume
                    </Button>
                    <Button variant="outline" size="sm" onClick={resetState}>
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </>
          )}

          {/* Confirmation Dialog */}
          <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle className="text-destructive flex items-center gap-2">
                  <ShieldAlert className="h-5 w-5" />
                  Confirm Volume Reassociation
                </DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-3 pt-3">
                    <p>
                      You are about to change the volume attached to this instance. This directly
                      modifies the Durable Object&apos;s storage.
                    </p>
                    <table className="bg-muted w-full rounded text-sm">
                      <thead>
                        <tr className="text-muted-foreground text-xs">
                          <th className="px-3 pt-3 pb-1 text-left"></th>
                          <th className="px-3 pt-3 pb-1 text-left">Current</th>
                          <th className="px-3 pt-3 pb-1 text-left">New</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="text-muted-foreground px-3 py-1 text-xs font-medium">
                            Volume
                          </td>
                          <td className="px-3 py-1">
                            <code>{candidateData?.currentVolumeId ?? 'None'}</code>
                          </td>
                          <td className="px-3 py-1">
                            <code>{selectedVolumeId}</code>
                          </td>
                        </tr>
                        {selectedVolume && (
                          <>
                            <tr>
                              <td className="text-muted-foreground px-3 py-1 text-xs font-medium">
                                Region
                              </td>
                              <td className="px-3 py-1">{currentVolume?.region ?? '—'}</td>
                              <td className="px-3 py-1">{selectedVolume.region}</td>
                            </tr>
                            <tr>
                              <td className="text-muted-foreground px-3 py-1 pb-3 text-xs font-medium">
                                Size
                              </td>
                              <td className="px-3 py-1 pb-3">{currentVolume?.size_gb ?? '—'} GB</td>
                              <td className="px-3 py-1 pb-3">{selectedVolume.size_gb} GB</td>
                            </tr>
                          </>
                        )}
                      </tbody>
                    </table>
                    <p className="font-medium">Reason: {reason}</p>
                    {!isStopped && (
                      <Alert variant="destructive" className="mt-2">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>
                          <p>
                            The machine is currently <strong>{currentStatus}</strong>. It will be
                            stopped before reassociation and then restarted automatically.
                          </p>
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <DialogClose asChild>
                  <Button variant="secondary">Cancel</Button>
                </DialogClose>
                <Button variant="destructive" onClick={() => void handleReassociate()}>
                  Confirm Reassociation
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      )}

      {/* Audit log — shown when expanded or after completion */}
      {auditLogs && auditLogs.length > 0 && (expanded || phase === 'done') && (
        <CardContent className="border-t pt-4">
          <details>
            <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
              Recent volume reassociations ({auditLogs.length})
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th className="pr-4 pb-1">When</th>
                    <th className="pr-4 pb-1">Admin</th>
                    <th className="pr-4 pb-1">Previous</th>
                    <th className="pr-4 pb-1">New</th>
                    <th className="pr-4 pb-1">Region</th>
                    <th className="pb-1">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map(log => {
                    const meta = log.metadata ?? {};
                    return (
                      <tr key={log.id} className="border-b last:border-0">
                        <td className="py-1.5 pr-4 whitespace-nowrap">
                          <span title={formatAbsoluteTime(log.created_at)}>
                            {formatRelativeTime(log.created_at)}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4 whitespace-nowrap">{log.actor_email ?? '—'}</td>
                        <td className="py-1.5 pr-4">
                          <code>{(meta.previousVolumeId as string) ?? '—'}</code>
                        </td>
                        <td className="py-1.5 pr-4">
                          <code>{(meta.newVolumeId as string) ?? '—'}</code>
                        </td>
                        <td className="py-1.5 pr-4">{(meta.newRegion as string) ?? '—'}</td>
                        <td className="text-muted-foreground py-1.5">
                          {(meta.reason as string) ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </CardContent>
      )}
    </Card>
  );
}

function DeliveryBadge({ delivery }: { delivery: string }) {
  switch (delivery) {
    case 'do':
      return (
        <Badge className="bg-blue-600 text-xs" variant="default">
          do
        </Badge>
      );
    case 'reconcile':
      return (
        <Badge className="bg-amber-600 text-xs" variant="default">
          reconcile
        </Badge>
      );
    case 'http':
      return (
        <Badge className="bg-green-600 text-xs" variant="default">
          http
        </Badge>
      );
    case 'queue':
      return (
        <Badge className="bg-purple-600 text-xs" variant="default">
          queue
        </Badge>
      );
    default:
      return <Badge variant="outline">{delivery}</Badge>;
  }
}

function formatDuration(ms: number): string {
  if (ms === 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function EventsTable({ rows }: { rows: KiloclawEventRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th className="pr-4 pb-2">Time</th>
            <th className="pr-4 pb-2">Event</th>
            <th className="pr-4 pb-2">Delivery</th>
            <th className="pr-4 pb-2">Status</th>
            <th className="pr-4 pb-2">Label</th>
            <th className="pr-4 pb-2">Duration</th>
            <th className="pb-2">Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const eventTimestamp = parseTimestamp(row.timestamp);
            return (
              <tr key={`${row.timestamp}-${i}`} className="border-b last:border-0">
                <td className="py-2 pr-4 whitespace-nowrap">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-xs">
                        {formatDistanceToNow(eventTimestamp, { addSuffix: true })}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{eventTimestamp.toLocaleString()}</TooltipContent>
                  </Tooltip>
                </td>
                <td className="py-2 pr-4">
                  <code className="text-xs">{row.event}</code>
                </td>
                <td className="py-2 pr-4">
                  <DeliveryBadge delivery={row.delivery} />
                </td>
                <td className="py-2 pr-4">
                  <span className="text-xs">{row.status || '—'}</span>
                </td>
                <td className="py-2 pr-4">
                  <span className="text-xs">{row.label || '—'}</span>
                </td>
                <td className="py-2 pr-4 whitespace-nowrap">
                  <span className="text-xs">{formatDuration(row.duration_ms)}</span>
                </td>
                <td className="py-2">
                  {row.error ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-destructive block max-w-[200px] truncate text-xs">
                          {row.error}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[400px]">
                        <p className="break-words text-xs">{row.error}</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type InstanceEventsCardProps = {
  sandboxId: string;
  flyAppName?: string | null;
  flyMachineId?: string | null;
};

function AllEventsTabContent({ sandboxId, flyAppName, flyMachineId }: InstanceEventsCardProps) {
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error } = useKiloclawAllEvents({
    sandboxId,
    flyAppName,
    flyMachineId,
    offset,
  });

  const pageSize = 100;
  const hasNextPage = (data?.data.length ?? 0) === pageSize;
  const hasPrevPage = offset > 0;

  return (
    <div className="space-y-3">
      {isLoading && (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Loading events...</span>
        </div>
      )}

      {error && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : 'Failed to load events'}
          </AlertDescription>
        </Alert>
      )}

      {data && data.data.length === 0 && (
        <p className="text-muted-foreground text-sm">No events found.</p>
      )}

      {data && data.data.length > 0 && <EventsTable rows={data.data as KiloclawAllEventRow[]} />}

      {(hasPrevPage || hasNextPage) && (
        <div className="flex items-center justify-between pt-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!hasPrevPage || isLoading}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            Previous
          </Button>
          <span className="text-muted-foreground text-xs">
            Showing {offset + 1}–{offset + (data?.data.length ?? 0)}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!hasNextPage || isLoading}
            onClick={() => setOffset(offset + pageSize)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function InstanceEventsCard({ sandboxId, flyAppName, flyMachineId }: InstanceEventsCardProps) {
  const { data, isLoading, error } = useKiloclawInstanceEvents(sandboxId);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          <div>
            <CardTitle>Events</CardTitle>
            <CardDescription>Events from Analytics Engine</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="lifecycle">
          <TabsList className="mb-4">
            <TabsTrigger value="lifecycle">DO &amp; Reconcile</TabsTrigger>
            <TabsTrigger value="all">All Events</TabsTrigger>
          </TabsList>

          <TabsContent value="lifecycle">
            {isLoading && (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-muted-foreground text-sm">Loading events...</span>
              </div>
            )}

            {error && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {error instanceof Error ? error.message : 'Failed to load events'}
                </AlertDescription>
              </Alert>
            )}

            {data && data.data.length === 0 && (
              <p className="text-muted-foreground text-sm">No DO or reconcile events found.</p>
            )}

            {data && data.data.length > 0 && <EventsTable rows={data.data} />}
          </TabsContent>

          <TabsContent value="all">
            <AllEventsTabContent
              sandboxId={sandboxId}
              flyAppName={flyAppName}
              flyMachineId={flyMachineId}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export function KiloclawInstanceDetail({ instanceId }: { instanceId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [destroyDialogOpen, setDestroyDialogOpen] = useState(false);
  const [doctorDialogOpen, setDoctorDialogOpen] = useState(false);
  const [restoreConfigDialogOpen, setRestoreConfigDialogOpen] = useState(false);
  const [destroyMachineDialogOpen, setDestroyMachineDialogOpen] = useState(false);
  const [resizeMachineDialogOpen, setResizeMachineDialogOpen] = useState(false);
  const [selectedMachineSize, setSelectedMachineSize] = useState<string>('performance-1x');
  const [resizeConfirmText, setResizeConfirmText] = useState('');
  const [resizePhase, setResizePhase] = useState<
    'idle' | 'stopping' | 'resizing' | 'starting' | 'waiting' | 'done' | 'error'
  >('idle');
  const [resizeError, setResizeError] = useState<string | null>(null);
  const [awaitingRestartCompletion, setAwaitingRestartCompletion] = useState(false);
  const [restoreSnapshotDialogOpen, setRestoreSnapshotDialogOpen] = useState(false);
  const [restoreSnapshotId, setRestoreSnapshotId] = useState<string | null>(null);
  const [restoreReason, setRestoreReason] = useState('');
  const [cleanupRecoveryVolumeDialogOpen, setCleanupRecoveryVolumeDialogOpen] = useState(false);
  const [inboundEmailCycleDialogOpen, setInboundEmailCycleDialogOpen] = useState(false);
  const [awaitingRestoreCompletion, setAwaitingRestoreCompletion] = useState(false);

  const { data, isLoading, error } = useQuery({
    ...trpc.admin.kiloclawInstances.get.queryOptions({ id: instanceId }),
    refetchInterval: awaitingRestartCompletion || awaitingRestoreCompletion ? 3000 : false,
  });

  const userId = data?.user_id;
  const orgId = data?.organization_id;
  const { data: registryData } = useQuery({
    ...trpc.admin.kiloclawInstances.registryEntries.queryOptions({
      userId: userId ?? '',
      orgId: orgId ?? undefined,
    }),
    enabled: !!userId,
  });

  const sandboxId = data?.sandbox_id;
  const aeDiskUsage = useControllerTelemetryDiskUsage(sandboxId ?? '');
  const aeRow = aeDiskUsage.data?.data?.[0];
  const diskUsed = aeRow && aeRow.disk_used_bytes > 0 ? aeRow.disk_used_bytes : null;
  const diskTotal = aeRow && aeRow.disk_total_bytes > 0 ? aeRow.disk_total_bytes : null;

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

  const { mutateAsync: restoreSnapshot, isPending: isRestoring } = useMutation(
    trpc.admin.kiloclawInstances.restoreVolumeSnapshot.mutationOptions({
      onSuccess: () => {
        toast.success('Snapshot restore enqueued');
        setAwaitingRestoreCompletion(true);
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.get.queryKey(),
        });
        setRestoreSnapshotDialogOpen(false);
        setRestoreSnapshotId(null);
        setRestoreReason('');
      },
      onError: err => {
        toast.error(`Failed to restore snapshot: ${err.message}`);
      },
    })
  );

  const provider = data?.workerStatus?.provider ?? null;
  const isFlyProvider = provider === 'fly';
  const runtimeId = data?.workerStatus?.runtimeId ?? null;
  const storageId = data?.workerStatus?.storageId ?? null;
  const flyMachineId = data?.workerStatus?.flyMachineId ?? null;
  const canShowFlySshCommand =
    isFlyProvider && !!data?.workerStatus?.runtimeId && !!data.workerStatus.flyAppName;
  const volumeId = isFlyProvider ? storageId : null;
  const snapshotsEnabled = data !== undefined && data.destroyed_at === null && !!volumeId;

  const {
    data: snapshotsData,
    isLoading: snapshotsLoading,
    error: snapshotsError,
  } = useQuery({
    ...trpc.admin.kiloclawInstances.volumeSnapshots.queryOptions({
      userId: data?.user_id ?? '',
      instanceId: data?.id,
    }),
    enabled: snapshotsEnabled,
  });

  const { data: restoreAuditLogs } = useQuery({
    ...trpc.admin.kiloclawInstances.adminAuditLogs.queryOptions({
      userId: data?.user_id ?? '',
      action: 'kiloclaw.snapshot.restore',
      limit: 10,
    }),
    enabled: snapshotsEnabled,
  });

  const gatewayControlsEnabled =
    data?.destroyed_at === null && !!runtimeId && data?.workerStatus?.status !== 'restoring';

  const {
    data: gatewayStatus,
    isLoading: gatewayStatusLoading,
    isFetching: gatewayStatusFetching,
    error: gatewayStatusError,
    refetch: refetchGatewayStatus,
  } = useQuery({
    ...trpc.admin.kiloclawInstances.gatewayStatus.queryOptions({
      userId: data?.user_id ?? '',
      instanceId: data?.id,
    }),
    enabled: gatewayControlsEnabled,
    refetchInterval: gatewayControlsEnabled ? 10000 : false,
  });

  const { data: controllerVersion } = useQuery({
    ...trpc.admin.kiloclawInstances.controllerVersion.queryOptions({
      userId: data?.user_id ?? '',
      instanceId: data?.id,
    }),
    enabled: gatewayControlsEnabled,
    staleTime: 5 * 60_000,
  });

  const supportsConfigRestore = calverAtLeast(
    cleanVersion(controllerVersion?.version),
    '2026.2.26'
  );

  // After a restart/upgrade, poll the machine status until it returns to "running",
  // then invalidate controllerVersion so supportsConfigRestore reflects the new build.
  const prevMachineStatus = useRef(data?.workerStatus?.status);
  useEffect(() => {
    const status = data?.workerStatus?.status;
    const wasRestarting = prevMachineStatus.current !== 'running';
    prevMachineStatus.current = status;

    if (awaitingRestartCompletion && status === 'running' && wasRestarting) {
      setAwaitingRestartCompletion(false);
      if (data?.user_id && data?.id) {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.controllerVersion.queryKey({
            userId: data.user_id,
            instanceId: data.id,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.gatewayStatus.queryKey({
            userId: data.user_id,
            instanceId: data.id,
          }),
        });
      }
    }
  }, [
    data?.workerStatus?.status,
    data?.user_id,
    data?.id,
    awaitingRestartCompletion,
    queryClient,
    trpc,
  ]);

  // Stop polling when restore completes (status transitions from 'restoring' to something else).
  // Track whether we've seen 'restoring' to avoid false positives when the mutation succeeds
  // but the data hasn't refreshed to show 'restoring' yet.
  const hasSeenRestoring = useRef(false);
  useEffect(() => {
    if (awaitingRestoreCompletion && data?.workerStatus?.status === 'restoring') {
      hasSeenRestoring.current = true;
    }
    if (
      awaitingRestoreCompletion &&
      hasSeenRestoring.current &&
      data?.workerStatus?.status !== 'restoring'
    ) {
      setAwaitingRestoreCompletion(false);
      hasSeenRestoring.current = false;
      if (data?.workerStatus?.status === 'running') {
        toast.success('Snapshot restore completed — instance is running');
      } else if (data?.workerStatus?.status === 'stopped') {
        toast.success('Snapshot restore completed — instance is stopped');
      }
      void queryClient.invalidateQueries({
        queryKey: trpc.admin.kiloclawInstances.volumeSnapshots.queryKey(),
      });
    }
  }, [data?.workerStatus?.status, awaitingRestoreCompletion, queryClient, trpc]);

  const invalidateGatewayQueries = () => {
    if (!data?.user_id || !data?.id) return;
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawInstances.gatewayStatus.queryKey({
        userId: data.user_id,
        instanceId: data.id,
      }),
    });
    void queryClient.invalidateQueries({ queryKey: trpc.admin.kiloclawInstances.get.queryKey() });
  };

  const machineControlsEnabled =
    data?.destroyed_at === null &&
    data?.workerStatus?.status !== 'restoring' &&
    data?.workerStatus?.status !== 'recovering';
  const hasRuntime = !!runtimeId;
  const hasFlyMachine = isFlyProvider && !!flyMachineId;
  const canRetryMetadataRecovery =
    data?.destroyed_at === null &&
    isFlyProvider &&
    !flyMachineId &&
    data?.workerStatus?.status === 'stopped';

  const invalidateMachineQueries = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.admin.kiloclawInstances.get.queryKey() });
  };

  const { mutateAsync: machineStart, isPending: isMachineStarting } = useMutation(
    trpc.admin.kiloclawInstances.machineStart.mutationOptions({
      onSuccess: () => {
        toast.success('Machine start requested');
        invalidateMachineQueries();
      },
      onError: err => {
        toast.error(`Failed to start machine: ${err.message}`);
      },
    })
  );

  const { mutateAsync: machineStop, isPending: isMachineStopping } = useMutation(
    trpc.admin.kiloclawInstances.machineStop.mutationOptions({
      onSuccess: () => {
        toast.success('Machine stop requested');
        invalidateMachineQueries();
      },
      onError: err => {
        toast.error(`Failed to stop machine: ${err.message}`);
      },
    })
  );

  const { mutateAsync: machineRedeploy, isPending: isMachineRedeploying } = useMutation(
    trpc.admin.kiloclawInstances.restartMachine.mutationOptions({
      onSuccess: () => {
        toast.success('Redeploy requested');
        invalidateMachineQueries();
        invalidateGatewayQueries();
        setAwaitingRestartCompletion(true);
      },
      onError: err => {
        toast.error(`Failed to redeploy: ${err.message}`);
      },
    })
  );

  const { mutateAsync: machineUpgrade, isPending: isMachineUpgrading } = useMutation(
    trpc.admin.kiloclawInstances.restartMachine.mutationOptions({
      onSuccess: () => {
        toast.success('Upgrade to latest requested');
        invalidateMachineQueries();
        invalidateGatewayQueries();
        setAwaitingRestartCompletion(true);
      },
      onError: err => {
        toast.error(`Failed to upgrade: ${err.message}`);
      },
    })
  );

  const {
    mutateAsync: destroyFlyMachine,
    isPending: isDestroyingFlyMachine,
    isSuccess: isFlyMachineDestroyed,
    reset: resetDestroyFlyMachine,
  } = useMutation(
    trpc.admin.kiloclawInstances.destroyFlyMachine.mutationOptions({
      onSuccess: () => {
        toast.success('Fly machine destroyed');
        invalidateMachineQueries();
        setDestroyMachineDialogOpen(false);
      },
      onError: err => {
        toast.error(`Failed to destroy Fly machine: ${err.message}`);
      },
    })
  );

  const { mutateAsync: resizeMachineMutation } = useMutation(
    trpc.admin.kiloclawInstances.resizeMachine.mutationOptions()
  );

  const isResizingMachine =
    resizePhase !== 'idle' && resizePhase !== 'done' && resizePhase !== 'error';

  // Poll status during resize phases
  const resizePolling =
    resizePhase === 'stopping' || resizePhase === 'starting' || resizePhase === 'waiting';
  useQuery({
    queryKey: ['machine-resize-poll', userId, instanceId, resizePolling],
    queryFn: async () => {
      invalidateMachineQueries();
      return { ts: Date.now() };
    },
    enabled: resizePolling,
    refetchInterval: resizePolling ? 3000 : false,
  });

  // Advance resize phase when machine reaches running
  const currentStatus = data?.workerStatus?.status;
  useEffect(() => {
    if (resizePhase === 'waiting' && currentStatus === 'running') {
      setResizePhase('done');
    }
  }, [resizePhase, currentStatus]);

  const handleResize = async () => {
    setResizeMachineDialogOpen(false);
    setResizeConfirmText('');
    setResizeError(null);

    const sizeMap: Record<
      string,
      { cpus: number; memory_mb: number; cpu_kind: 'shared' | 'performance' }
    > = {
      'shared-cpu-2x': { cpus: 2, memory_mb: 3072, cpu_kind: 'shared' },
      'shared-cpu-4x': { cpus: 4, memory_mb: 3072, cpu_kind: 'shared' },
      'performance-1x': { cpus: 1, memory_mb: 3072, cpu_kind: 'performance' },
      'performance-2x': { cpus: 2, memory_mb: 4096, cpu_kind: 'performance' },
    };
    const machineSize = sizeMap[selectedMachineSize];
    if (!machineSize || !data || !userId) return;

    try {
      // Step 1: Stop if running — retry up to 3 times since Fly can be slow
      if (currentStatus !== 'stopped') {
        setResizePhase('stopping');
        let stopped = false;
        for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
          try {
            await machineStop({ userId, instanceId });
            stopped = true;
          } catch {
            // Stop timed out — wait and check if it actually stopped
            await new Promise(resolve => setTimeout(resolve, 10_000));
            // Re-fetch status to check
            await queryClient.invalidateQueries({
              queryKey: trpc.admin.kiloclawInstances.get.queryKey(),
            });
          }
        }
        if (!stopped) {
          throw new Error(
            'Failed to stop the machine after 3 attempts. Please try again or stop it manually first.'
          );
        }
        // Final wait to let status propagate
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Step 2: Update DO state
      setResizePhase('resizing');
      await resizeMachineMutation({ userId, instanceId: data.id, machineSize });

      // Step 3: Start with new size
      setResizePhase('starting');
      await machineStart({ userId, instanceId });

      // Step 4: Wait for running
      setResizePhase('waiting');
    } catch (err) {
      setResizePhase('error');
      setResizeError(err instanceof Error ? err.message : 'An unknown error occurred');
      toast.error(`Resize failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Reset the destroyed success state when the Fly machine ID changes (e.g. new machine created)
  useEffect(() => {
    resetDestroyFlyMachine();
  }, [flyMachineId, resetDestroyFlyMachine]);

  const { mutateAsync: forceRetryRecovery, isPending: isRetryingRecovery } = useMutation(
    trpc.admin.kiloclawInstances.forceRetryRecovery.mutationOptions({
      onSuccess: () => {
        toast.success('Metadata recovery retry requested');
        invalidateMachineQueries();
      },
      onError: err => {
        toast.error(`Failed to retry metadata recovery: ${err.message}`);
      },
    })
  );

  const { mutateAsync: cleanupRecoveryPreviousVolume, isPending: isCleaningRecoveryVolume } =
    useMutation(
      trpc.admin.kiloclawInstances.cleanupRecoveryPreviousVolume.mutationOptions({
        onSuccess: data => {
          toast.success(
            data.deletedVolumeId
              ? `Retained recovery volume deleted: ${data.deletedVolumeId}`
              : 'No retained recovery volume to delete'
          );
          invalidateMachineQueries();
          setCleanupRecoveryVolumeDialogOpen(false);
        },
        onError: err => {
          toast.error(`Failed to delete retained recovery volume: ${err.message}`);
        },
      })
    );

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

  const runDoctorMutation = useMutation(
    trpc.admin.kiloclawInstances.runDoctor.mutationOptions({
      onSuccess: () => {
        invalidateGatewayQueries();
      },
      onError: err => {
        toast.error(`Failed to run doctor: ${err.message}`);
      },
    })
  );

  const restoreConfigMutation = useMutation(
    trpc.admin.kiloclawInstances.restoreConfig.mutationOptions({
      onSuccess: data => {
        if (data.signaled) {
          toast.success('Config restored and gateway restarting');
        } else {
          toast.success(
            'Config restored, but the gateway was not running — restart the instance to apply'
          );
        }
        invalidateGatewayQueries();
        setRestoreConfigDialogOpen(false);
      },
      onError: err => {
        toast.error(`Failed to restore config: ${err.message}`);
      },
    })
  );

  const cycleInboundEmailMutation = useMutation(
    trpc.admin.kiloclawInstances.cycleInboundEmailAddress.mutationOptions({
      onSuccess: result => {
        toast.success(`New inbound email address: ${result.inboundEmailAddress}`);
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.get.queryKey(),
        });
        setInboundEmailCycleDialogOpen(false);
      },
      onError: err => {
        toast.error(`Failed to cycle inbound email address: ${err.message}`);
      },
    })
  );

  const setInboundEmailEnabledMutation = useMutation(
    trpc.admin.kiloclawInstances.setInboundEmailEnabled.mutationOptions({
      onSuccess: () => {
        toast.success('Inbound email setting updated');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.get.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to update inbound email setting: ${err.message}`);
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
  const machineStatus = data.workerStatus?.status ?? null;
  const isRecovering = machineStatus === 'recovering';
  const machineRestartBlocked =
    machineStatus === 'provisioned' ||
    machineStatus === 'destroying' ||
    machineStatus === 'starting' ||
    machineStatus === 'restarting' ||
    machineStatus === 'recovering';
  const machineActionPending =
    isMachineStarting ||
    isMachineStopping ||
    isMachineRedeploying ||
    isMachineUpgrading ||
    isRetryingRecovery ||
    isDestroyingFlyMachine;
  const gatewayActionPending =
    isGatewayStarting ||
    isGatewayStopping ||
    isGatewayRestarting ||
    runDoctorMutation.isPending ||
    restoreConfigMutation.isPending;

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
                      disabled={
                        data.workerStatus?.status === 'restoring' ||
                        data.workerStatus?.status === 'recovering'
                      }
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
                  href={`/admin/users/${encodeURIComponent(data.user_id)}`}
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

            <div className="flex items-center gap-2">
              <HardDrive className="text-muted-foreground h-4 w-4 shrink-0" />
              <DetailField label="Volume Usage">
                {formatVolumeUsage(diskUsed, diskTotal, 'used-total')}
              </DetailField>
            </div>

            <DetailField label="Type">
              {data.organization_id ? (
                <Badge
                  variant="outline"
                  className="border-blue-500/30 bg-blue-500/15 text-blue-400"
                >
                  Org
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-gray-500/30 bg-gray-500/10 text-gray-400"
                >
                  Personal
                </Badge>
              )}
            </DetailField>

            <DetailField label="Instance ID">
              <code className="text-sm">{data.id}</code>
            </DetailField>

            <DetailField label="User ID">
              <code className="text-sm">{data.user_id}</code>
            </DetailField>

            {data.organization_id && (
              <DetailField label="Organization ID">
                <code className="text-sm">{data.organization_id}</code>
              </DetailField>
            )}

            {data.workerStatus?.flyAppName && (
              <DetailField label="Fly App">
                <a
                  href={`https://fly.io/apps/${data.workerStatus.flyAppName}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                >
                  <code className="text-sm">{data.workerStatus.flyAppName}</code>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </DetailField>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Inbound Email</CardTitle>
                <CardDescription>Generated alias routing for this instance</CardDescription>
              </div>
              <Badge variant={data.inbound_email_enabled ? 'default' : 'secondary'}>
                {data.inbound_email_enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              {data.inbound_email_address ? (
                <code className="bg-muted text-foreground block truncate rounded px-2 py-1 text-xs">
                  {data.inbound_email_address}
                </code>
              ) : (
                <span className="text-muted-foreground text-sm">No active inbound email alias</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!data.inbound_email_address}
                onClick={() => {
                  if (!data.inbound_email_address) return;
                  void navigator.clipboard
                    .writeText(data.inbound_email_address)
                    .then(() => toast.success('Inbound email address copied'))
                    .catch(() => toast.error('Failed to copy inbound email address'));
                }}
              >
                <Copy className="mr-1 h-4 w-4" />
                Copy
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!isActive || cycleInboundEmailMutation.isPending}
                onClick={() => setInboundEmailCycleDialogOpen(true)}
              >
                {cycleInboundEmailMutation.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1 h-4 w-4" />
                )}
                Cycle Address
              </Button>
              <Button
                size="sm"
                variant={data.inbound_email_enabled ? 'destructive' : 'outline'}
                disabled={!isActive || setInboundEmailEnabledMutation.isPending}
                onClick={() =>
                  setInboundEmailEnabledMutation.mutate({
                    id: data.id,
                    enabled: !data.inbound_email_enabled,
                  })
                }
              >
                {setInboundEmailEnabledMutation.isPending && (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                )}
                {data.inbound_email_enabled ? 'Disable Inbound Email' : 'Enable Inbound Email'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Dialog
          open={inboundEmailCycleDialogOpen}
          onOpenChange={
            cycleInboundEmailMutation.isPending ? () => {} : setInboundEmailCycleDialogOpen
          }
        >
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Cycle inbound email address?
              </DialogTitle>
              <DialogDescription className="pt-3">
                This cannot be undone. The current address will stop working immediately and cannot
                be reassigned later.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <DialogClose asChild>
                <Button variant="secondary" disabled={cycleInboundEmailMutation.isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={cycleInboundEmailMutation.isPending}
                onClick={() => cycleInboundEmailMutation.mutate({ id: data.id })}
              >
                {cycleInboundEmailMutation.isPending && (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                )}
                Cycle Address
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Registry Status */}
        {registryData?.registries.map(registry => (
          <Card key={registry.registryKey}>
            <CardHeader>
              <CardTitle>Registry Status</CardTitle>
              <CardDescription>
                <code className="text-xs">{registry.registryKey}</code>
                {' · '}
                <span className="text-xs">
                  {registry.migrated ? 'migrated' : 'pending migration'}
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {registry.entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">No registry entries</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 pr-4">Instance ID</th>
                        <th className="pb-2 pr-4">DO Key</th>
                        <th className="pb-2 pr-4">Created</th>
                        <th className="pb-2 pr-4">Destroyed</th>
                        <th className="pb-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {registry.entries.map(entry => {
                        const isCurrent = entry.instanceId === data?.id;
                        const isDestroyed = entry.destroyedAt !== null;
                        return (
                          <tr
                            key={entry.instanceId}
                            className={`border-b ${isCurrent ? 'bg-blue-500/10' : ''}`}
                          >
                            <td className="py-2 pr-4">
                              <code className="text-xs">{entry.instanceId.slice(0, 8)}...</code>
                              {isCurrent && (
                                <Badge variant="outline" className="ml-2 text-xs">
                                  current
                                </Badge>
                              )}
                            </td>
                            <td className="py-2 pr-4">
                              <code className="text-xs">
                                {entry.doKey === entry.instanceId
                                  ? 'instanceId'
                                  : entry.doKey.slice(0, 8) + '...'}
                              </code>
                            </td>
                            <td className="py-2 pr-4 text-xs text-muted-foreground">
                              {new Date(entry.createdAt).toLocaleString()}
                            </td>
                            <td className="py-2 pr-4 text-xs text-muted-foreground">
                              {entry.destroyedAt
                                ? new Date(entry.destroyedAt).toLocaleString()
                                : '—'}
                            </td>
                            <td className="py-2">
                              <Badge variant={isDestroyed ? 'secondary' : 'default'}>
                                {isDestroyed ? 'Destroyed' : 'Active'}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Live Worker Status</CardTitle>
                <CardDescription>Real-time status from the KiloClaw Durable Object</CardDescription>
              </div>
              {canRetryMetadataRecovery && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={machineActionPending}
                  onClick={() =>
                    void forceRetryRecovery({ userId: data.user_id, instanceId: data.id })
                  }
                >
                  {isRetryingRecovery ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCw className="mr-1 h-4 w-4" />
                  )}
                  Retry Metadata Recovery
                </Button>
              )}
            </div>
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

                <DetailField label="DO User ID">
                  <code className="text-xs">{data.workerStatus.userId ?? '—'}</code>
                </DetailField>

                <DetailField label="DO Sandbox ID">
                  <code className="text-xs">{data.workerStatus.sandboxId ?? '—'}</code>
                </DetailField>

                <DetailField label="DO Org ID">
                  <code className="text-xs">{data.workerStatus.orgId ?? '—'}</code>
                </DetailField>

                <DetailField label="Provider">
                  <code className="text-xs">{data.workerStatus.provider}</code>
                </DetailField>

                <div className="flex items-center gap-2">
                  <Server className="text-muted-foreground h-4 w-4 shrink-0" />
                  <DetailField label="Runtime ID">
                    {canShowFlySshCommand &&
                    data.workerStatus.runtimeId &&
                    data.workerStatus.flyAppName ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={`https://fly.io/apps/${data.workerStatus.flyAppName}/machines/${data.workerStatus.runtimeId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                        >
                          <code className="text-sm">{data.workerStatus.runtimeId}</code>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                        <CopySshCommandButton
                          flyAppName={data.workerStatus.flyAppName}
                          flyMachineId={data.workerStatus.runtimeId}
                        />
                      </div>
                    ) : (
                      <code className="text-sm">{data.workerStatus.runtimeId ?? '—'}</code>
                    )}
                  </DetailField>
                </div>

                <div className="flex items-center gap-2">
                  <Globe className="text-muted-foreground h-4 w-4 shrink-0" />
                  <DetailField label="Region">{data.workerStatus.region ?? '—'}</DetailField>
                </div>

                <div className="flex items-center gap-2">
                  <Server className="text-muted-foreground h-4 w-4 shrink-0" />
                  <DetailField label="Machine Size">
                    {data.workerStatus.machineSize ? (
                      <code className="text-sm">
                        {data.workerStatus.machineSize.cpu_kind ?? 'shared'}-cpu-
                        {data.workerStatus.machineSize.cpus}x,{' '}
                        {data.workerStatus.machineSize.memory_mb}MB
                      </code>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        default (performance-1x, 3072MB)
                      </span>
                    )}
                  </DetailField>
                </div>

                <div className="flex items-center gap-2">
                  <HardDrive className="text-muted-foreground h-4 w-4 shrink-0" />
                  <DetailField label="Storage ID">
                    <code className="text-sm">{data.workerStatus.storageId ?? '—'}</code>
                  </DetailField>
                </div>

                {isFlyProvider && (
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
                )}

                {isFlyProvider && data.workerStatus.flyAppName && data.workerStatus.runtimeId && (
                  <div className="flex items-center gap-2">
                    <BarChart className="text-muted-foreground h-4 w-4 shrink-0" />
                    <DetailField label="Metrics">
                      <a
                        href={`https://fly-metrics.net/d/fly-instance/fly-instance?from=now-1h&orgId=1480569&to=now&var-app=${data.workerStatus.flyAppName}&var-instance=${data.workerStatus.runtimeId}`}
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

                <DetailField label="OpenClaw Version">
                  {data.workerStatus.openclawVersion ?? '—'}
                </DetailField>

                <DetailField label="Image Variant">
                  {data.workerStatus.imageVariant ?? '—'}
                </DetailField>

                <DetailField label="Image Tag">
                  {data.workerStatus.trackedImageTag ? (
                    <code className="text-xs">{data.workerStatus.trackedImageTag}</code>
                  ) : (
                    '—'
                  )}
                </DetailField>

                <DetailField label="Image Digest">
                  {data.workerStatus.trackedImageDigest ? (
                    <code className="text-xs">{data.workerStatus.trackedImageDigest}</code>
                  ) : (
                    '—'
                  )}
                </DetailField>

                <DetailField label="Pending Machine Destroy ID">
                  <code className="text-xs">
                    {data.workerStatus.pendingDestroyMachineId ?? '—'}
                  </code>
                </DetailField>

                <DetailField label="Pending Volume Destroy ID">
                  <code className="text-xs">{data.workerStatus.pendingDestroyVolumeId ?? '—'}</code>
                </DetailField>

                <DetailField label="Pending Postgres Finalize Mark">
                  {data.workerStatus.pendingPostgresMarkOnFinalize ? 'true' : 'false'}
                </DetailField>

                <DetailField label="Last Destroy Error">
                  {data.workerStatus.lastDestroyErrorOp ? (
                    <span className="text-destructive text-xs">
                      <code>
                        {data.workerStatus.lastDestroyErrorOp}
                        {data.workerStatus.lastDestroyErrorStatus
                          ? ` ${data.workerStatus.lastDestroyErrorStatus}`
                          : ''}
                        {' — '}
                        {data.workerStatus.lastDestroyErrorMessage ?? 'unknown'}
                      </code>
                      <br />
                      <span className="text-muted-foreground">
                        {formatEpochTime(data.workerStatus.lastDestroyErrorAt)}
                      </span>
                    </span>
                  ) : (
                    '—'
                  )}
                </DetailField>

                <DetailField label="Instance Ready Email Sent">
                  {data.workerStatus.instanceReadyEmailSent ? 'true' : 'false'}
                </DetailField>

                <DetailField label="Last Metadata Recovery Attempt">
                  {formatEpochTime(data.workerStatus.lastMetadataRecoveryAt)}
                </DetailField>

                <DetailField label="Last Live Check Dispatch">
                  {formatEpochTime(data.workerStatus.lastLiveCheckAt)}
                </DetailField>

                <DetailField label="Next Alarm">
                  {formatEpochTime(data.workerStatus.alarmScheduledAt)}
                </DetailField>

                <DetailField label="App DO Key">
                  <code className="text-xs">{data.workerStatus.envKeyAppDOKey ?? '—'}</code>
                </DetailField>

                <DetailField label="App DO Fly App Name">
                  {data.workerStatus.envKeyAppDOFlyAppName ? (
                    <code className="text-xs">{data.workerStatus.envKeyAppDOFlyAppName}</code>
                  ) : (
                    <span className="text-destructive text-xs font-medium">
                      null (no Fly secret sync!)
                    </span>
                  )}
                </DetailField>

                <DetailField label="App DO envKeySet">
                  {data.workerStatus.envKeyAppDOKeySet === null
                    ? '—'
                    : data.workerStatus.envKeyAppDOKeySet
                      ? 'true'
                      : 'false'}
                </DetailField>

                {data.workerStatus.envKeyAppDOFlyAppName !== null &&
                  data.workerStatus.flyAppName !== null &&
                  data.workerStatus.envKeyAppDOFlyAppName !== data.workerStatus.flyAppName && (
                    <div className="bg-destructive/10 border-destructive/30 col-span-full rounded-md border p-3">
                      <p className="text-destructive text-sm font-medium">
                        Fly app name mismatch: App DO thinks it&apos;s{' '}
                        <code>{data.workerStatus.envKeyAppDOFlyAppName}</code> but Instance DO has{' '}
                        <code>{data.workerStatus.flyAppName}</code>. The App DO will set the Fly
                        secret on the wrong app.
                      </p>
                    </div>
                  )}

                {data.workerStatus.envKeyAppDOFlyAppName === null &&
                  data.workerStatus.flyAppName !== null && (
                    <div className="bg-destructive/10 border-destructive/30 col-span-full rounded-md border p-3">
                      <p className="text-destructive text-sm font-medium">
                        App DO has no flyAppName — ensureEnvKey() will not call setAppSecret().
                        Encrypted env vars will use the App DO&apos;s key but the Fly secret will be
                        stale or missing.
                      </p>
                    </div>
                  )}
              </div>
            ) : !data.workerStatusError ? (
              <p className="text-muted-foreground text-sm">No worker status available</p>
            ) : null}
          </CardContent>
        </Card>

        {data.workerStatus &&
          (data.workerStatus.lastStartErrorMessage ||
            data.workerStatus.lastRestartErrorMessage) && (
            <Card>
              <CardHeader>
                <CardTitle>Start / Restart Errors</CardTitle>
                <CardDescription>Most recent start or restart failure</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-2">
                  {data.workerStatus.lastStartErrorMessage && (
                    <DetailField label="Last Start Error">
                      <span className="text-destructive text-xs">
                        <code>{data.workerStatus.lastStartErrorMessage}</code>
                        <br />
                        <span className="text-muted-foreground">
                          {formatEpochTime(data.workerStatus.lastStartErrorAt)}
                        </span>
                      </span>
                    </DetailField>
                  )}
                  {data.workerStatus.lastRestartErrorMessage && (
                    <DetailField label="Last Restart Error">
                      <span className="text-destructive text-xs">
                        <code>{data.workerStatus.lastRestartErrorMessage}</code>
                        <br />
                        <span className="text-muted-foreground">
                          {formatEpochTime(data.workerStatus.lastRestartErrorAt)}
                        </span>
                      </span>
                    </DetailField>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

        {data.workerStatus && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>Unexpected Stop Recovery</CardTitle>
                  <CardDescription>
                    Alarm-driven relocation state and retained recovery volume cleanup
                  </CardDescription>
                </div>
                {data.workerStatus.recoveryPreviousVolumeId && (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isCleaningRecoveryVolume || isRecovering}
                    onClick={() => setCleanupRecoveryVolumeDialogOpen(true)}
                  >
                    {isCleaningRecoveryVolume ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1 h-4 w-4" />
                    )}
                    Delete Retained Volume
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {isRecovering && (
                <Alert className="border-orange-500/30 bg-orange-500/10">
                  <Loader2 className="h-4 w-4 animate-spin text-orange-500" />
                  <AlertDescription className="text-orange-700 dark:text-orange-300">
                    The instance is currently relocating after an unexpected Fly stop.
                    {data.workerStatus.recoveryStartedAt !== null &&
                      ` Recovery began ${formatEpochRelativeTime(
                        data.workerStatus.recoveryStartedAt
                      )}.`}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <DetailField label="Current Recovery State">
                  {isRecovering ? <StatusBadge status="recovering" /> : 'Idle'}
                </DetailField>
                <DetailField label="Recovery Started At">
                  {formatEpochTime(data.workerStatus.recoveryStartedAt)}
                </DetailField>
                <DetailField label="Pending Replacement Volume">
                  <code className="text-xs">
                    {data.workerStatus.pendingRecoveryVolumeId ?? '—'}
                  </code>
                </DetailField>
                <DetailField label="Retained Old Volume">
                  <code className="text-xs">
                    {data.workerStatus.recoveryPreviousVolumeId ?? '—'}
                  </code>
                </DetailField>
                <DetailField label="Retained Volume Cleanup Deadline">
                  {data.workerStatus.recoveryPreviousVolumeCleanupAfter !== null ? (
                    <span
                      title={formatEpochTime(data.workerStatus.recoveryPreviousVolumeCleanupAfter)}
                    >
                      {formatEpochRelativeTime(
                        data.workerStatus.recoveryPreviousVolumeCleanupAfter
                      )}
                    </span>
                  ) : (
                    '—'
                  )}
                </DetailField>
                <DetailField label="Last Recovery Error">
                  {data.workerStatus.lastRecoveryErrorMessage ? (
                    <span className="text-destructive text-xs">
                      <code>{data.workerStatus.lastRecoveryErrorMessage}</code>
                      <br />
                      <span className="text-muted-foreground">
                        {formatEpochTime(data.workerStatus.lastRecoveryErrorAt)}
                      </span>
                    </span>
                  ) : (
                    '—'
                  )}
                </DetailField>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Events */}
        {data.sandbox_id && (
          <InstanceEventsCard
            sandboxId={data.sandbox_id}
            flyAppName={data.workerStatus?.flyAppName}
            flyMachineId={data.workerStatus?.flyMachineId}
          />
        )}

        {/* Runtime Controls */}
        {isActive && machineControlsEnabled && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>Runtime Controls</CardTitle>
                  <CardDescription>
                    Start, stop, resize, or redeploy the provider runtime
                  </CardDescription>
                </div>
                <StatusBadge status={data.workerStatus?.status ?? null} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={machineActionPending}
                  onClick={() => void machineStart({ userId: data.user_id, instanceId: data.id })}
                >
                  {isMachineStarting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-1 h-4 w-4" />
                  )}
                  Start Runtime
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={machineActionPending || !hasRuntime}
                  onClick={() => void machineStop({ userId: data.user_id, instanceId: data.id })}
                >
                  {isMachineStopping ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="mr-1 h-4 w-4" />
                  )}
                  Stop Runtime
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={machineActionPending || machineRestartBlocked || !hasRuntime}
                  onClick={() => void machineRedeploy({ instanceId: data.id, imageTag: undefined })}
                >
                  {isMachineRedeploying ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCw className="mr-1 h-4 w-4" />
                  )}
                  Redeploy
                </Button>
                {isFlyProvider && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={machineActionPending || machineRestartBlocked || !hasRuntime}
                    onClick={() => void machineUpgrade({ instanceId: data.id, imageTag: 'latest' })}
                  >
                    {isMachineUpgrading ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUpCircle className="mr-1 h-4 w-4" />
                    )}
                    Upgrade to Latest
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={machineActionPending || isResizingMachine}
                  onClick={() => {
                    const ms = data?.workerStatus?.machineSize;
                    const key = ms
                      ? ms.cpu_kind === 'performance'
                        ? `performance-${ms.cpus}x`
                        : `shared-cpu-${ms.cpus}x`
                      : 'performance-1x';
                    setSelectedMachineSize(key);
                    setResizeMachineDialogOpen(true);
                  }}
                >
                  <ArrowUpDown className="mr-1 h-4 w-4" />
                  Resize Runtime
                </Button>
                {isFlyProvider && (
                  <Button
                    size="sm"
                    variant="outline"
                    className={
                      isFlyMachineDestroyed
                        ? 'border-green-500 text-green-500'
                        : 'border-orange-500 text-orange-500 hover:bg-orange-500/10'
                    }
                    disabled={machineActionPending || !hasFlyMachine || isFlyMachineDestroyed}
                    onClick={() => setDestroyMachineDialogOpen(true)}
                  >
                    {isDestroyingFlyMachine ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : isFlyMachineDestroyed ? (
                      <CheckCircle2 className="mr-1 h-4 w-4" />
                    ) : (
                      <Trash2 className="mr-1 h-4 w-4" />
                    )}
                    {isFlyMachineDestroyed ? 'Machine Destroyed' : 'Destroy Fly Machine'}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Destroy Fly Machine Confirmation Dialog */}
        <Dialog
          open={destroyMachineDialogOpen}
          onOpenChange={isDestroyingFlyMachine ? () => {} : setDestroyMachineDialogOpen}
        >
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Destroy Fly Machine
              </DialogTitle>
              <DialogDescription className="pt-3">
                This will force-destroy the Fly machine via the Machines API. Only the Fly machine
                is deleted — the KiloClaw instance and Fly volume will remain intact.
                <span className="text-foreground mt-2 block font-medium">
                  User: {data?.user_email ?? data?.user_id}
                </span>
                <span className="mt-2 block">
                  Machine ID: <code className="text-xs">{data?.workerStatus?.flyMachineId}</code>
                </span>
                <span className="block">
                  App: <code className="text-xs">{data?.workerStatus?.flyAppName}</code>
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <DialogClose asChild>
                <Button variant="secondary" disabled={isDestroyingFlyMachine}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={isDestroyingFlyMachine}
                onClick={() => {
                  if (data?.workerStatus?.flyMachineId && data?.workerStatus?.flyAppName) {
                    void destroyFlyMachine({
                      userId: data.user_id,
                      instanceId: data.id,
                      appName: data.workerStatus.flyAppName,
                      machineId: data.workerStatus.flyMachineId,
                    });
                  } else {
                    toast.error('Missing machine ID or app name');
                  }
                }}
              >
                {isDestroyingFlyMachine && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Destroy Machine
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Resize Machine Progress */}
        {isResizingMachine && (
          <Card className="border-orange-500/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 rounded border p-4">
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-orange-500" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {resizePhase === 'stopping' && 'Stopping machine...'}
                    {resizePhase === 'resizing' && 'Updating machine size...'}
                    {resizePhase === 'starting' && 'Starting machine with new size...'}
                    {resizePhase === 'waiting' && 'Waiting for machine to be ready...'}
                  </p>
                  <div className="text-muted-foreground flex items-center gap-2 text-xs">
                    {(['stopping', 'resizing', 'starting', 'waiting'] as const).map((step, i) => (
                      <span key={step} className="flex items-center gap-1">
                        {i > 0 && <span className="text-muted-foreground/50">&rarr;</span>}
                        <span
                          className={
                            resizePhase === step
                              ? 'font-medium text-orange-500'
                              : (['stopping', 'resizing', 'starting', 'waiting'] as const).indexOf(
                                    resizePhase as typeof step
                                  ) > i
                                ? 'text-foreground'
                                : ''
                          }
                        >
                          {step === 'stopping'
                            ? 'Stop'
                            : step === 'resizing'
                              ? 'Resize'
                              : step === 'starting'
                                ? 'Start'
                                : 'Health check'}
                        </span>
                      </span>
                    ))}
                  </div>
                  {currentStatus && (
                    <p className="text-muted-foreground text-xs">
                      Machine status: <StatusBadge status={currentStatus} />
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {resizePhase === 'done' && (
          <Card className="border-green-500/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 rounded border border-green-600/30 bg-green-600/5 p-4">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
                <div>
                  <p className="text-sm font-medium text-green-600">Machine resize complete</p>
                  <p className="text-muted-foreground text-xs">
                    Machine is running with the new size.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setResizePhase('idle')}
                >
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {resizePhase === 'error' && (
          <Card className="border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 rounded border border-red-600/30 bg-red-600/5 p-4">
                <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
                <div>
                  <p className="text-sm font-medium text-red-600">Machine resize failed</p>
                  <p className="text-muted-foreground text-xs">{resizeError}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => {
                    setResizePhase('idle');
                    setResizeError(null);
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Resize Machine Dialog */}
        <Dialog
          open={resizeMachineDialogOpen}
          onOpenChange={open => {
            if (isResizingMachine) return;
            setResizeMachineDialogOpen(open);
            if (!open) setResizeConfirmText('');
          }}
        >
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-orange-500">
                <AlertTriangle className="h-5 w-5" />
                Resize Machine
              </DialogTitle>
              <DialogDescription className="pt-3">
                This will stop the machine, update its CPU/memory spec, and restart it. The user
                will be disconnected during the restart.
                <span className="text-foreground mt-2 block font-medium">
                  User: {data?.user_email ?? data?.user_id}
                </span>
                {data?.workerStatus?.machineSize ? (
                  <span className="mt-2 block text-sm">
                    Current:{' '}
                    <code className="text-xs">
                      {data.workerStatus.machineSize.cpu_kind ?? 'shared'}-cpu-
                      {data.workerStatus.machineSize.cpus}x,{' '}
                      {data.workerStatus.machineSize.memory_mb}MB
                    </code>
                  </span>
                ) : (
                  <span className="text-muted-foreground mt-2 block text-sm">
                    Current: default (performance-1x, 3072MB)
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <label className="text-sm font-medium">New size</label>
                <select
                  className="bg-background border-input mt-1 w-full rounded-md border px-3 py-2 text-sm"
                  value={selectedMachineSize}
                  onChange={e => setSelectedMachineSize(e.target.value)}
                  disabled={isResizingMachine}
                >
                  <option value="shared-cpu-2x">shared-cpu-2x, 3GB (~$20/mo)</option>
                  <option value="shared-cpu-4x">shared-cpu-4x, 3GB (~$24/mo)</option>
                  <option value="performance-1x">performance-1x, 3GB (~$47/mo)</option>
                  <option value="performance-2x">performance-2x, 4GB (~$85/mo)</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">
                  Type <code className="text-destructive text-xs">RESIZE</code> to confirm
                </label>
                <input
                  type="text"
                  className="bg-background border-input mt-1 w-full rounded-md border px-3 py-2 text-sm"
                  value={resizeConfirmText}
                  onChange={e => setResizeConfirmText(e.target.value)}
                  placeholder="RESIZE"
                  disabled={isResizingMachine}
                />
              </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <DialogClose asChild>
                <Button variant="secondary" disabled={isResizingMachine}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={isResizingMachine || resizeConfirmText !== 'RESIZE'}
                onClick={() => void handleResize()}
              >
                Confirm Resize
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
                  Gateway process controls are available when the instance has a runtime ID.
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
                    {'data' in gatewayStatusError &&
                    (gatewayStatusError as { data?: { code?: string } }).data?.code === 'NOT_FOUND'
                      ? 'Gateway control unavailable. Redeploy to update instance to use this feature.'
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
                      onClick={() =>
                        void gatewayStart({ userId: data.user_id, instanceId: data.id })
                      }
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
                      onClick={() =>
                        void gatewayStop({ userId: data.user_id, instanceId: data.id })
                      }
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
                      onClick={() =>
                        void gatewayRestart({ userId: data.user_id, instanceId: data.id })
                      }
                    >
                      {isGatewayRestarting ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1 h-4 w-4" />
                      )}
                      Restart
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={gatewayActionPending}
                      onClick={() => {
                        runDoctorMutation.reset();
                        setDoctorDialogOpen(true);
                        runDoctorMutation.mutate({ userId: data.user_id, instanceId: data.id });
                      }}
                    >
                      <Stethoscope className="mr-1 h-4 w-4" />
                      Run Doctor
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={!supportsConfigRestore || gatewayActionPending}
                            onClick={() => setRestoreConfigDialogOpen(true)}
                          >
                            <RotateCcw className="mr-1 h-4 w-4" />
                            Restore Default Config
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {!supportsConfigRestore && (
                        <TooltipContent>Unavailable until redeploy</TooltipContent>
                      )}
                    </Tooltip>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {isActive && <KiloCliRunCard userId={data.user_id} instanceId={data.id} />}

        {/* Volume Reassociation (danger zone) */}
        {isActive &&
          isFlyProvider &&
          data.workerStatus &&
          data.workerStatus.status !== 'recovering' && (
            <VolumeReassociationCard
              userId={data.user_id}
              instanceId={data.id}
              currentStatus={data.workerStatus.status}
              currentMachineId={data.workerStatus.flyMachineId}
              previousVolumeId={data.workerStatus.previousVolumeId ?? null}
              onStatusChange={invalidateMachineQueries}
            />
          )}

        {/* Volume Snapshots */}
        {snapshotsEnabled && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
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
                <BumpVolumeTo15GbButton
                  userId={data.user_id}
                  instanceId={data.id}
                  appName={data.workerStatus?.flyAppName}
                  volumeId={volumeId}
                  userLabel={data.user_email ?? data.user_id}
                  disabled={
                    data.workerStatus?.status === 'recovering' ||
                    data.workerStatus?.status === 'restoring' ||
                    data.workerStatus?.status === 'destroying'
                  }
                />
              </div>
            </CardHeader>
            <CardContent>
              {data?.workerStatus?.status === 'restoring' && (
                <Alert className="mb-4 border-purple-500/30 bg-purple-500/10">
                  <Loader2 className="h-4 w-4 animate-spin text-purple-400" />
                  <AlertDescription className="text-purple-300">
                    Restoring from snapshot... (started{' '}
                    {formatRelativeTime(data.workerStatus.restoreStartedAt)})
                  </AlertDescription>
                </Alert>
              )}
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
                        <th className="pr-4 pb-2">ID</th>
                        <th className="pb-2"></th>
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
                          <td className="py-2 pr-4">
                            <code className="text-xs">{snap.id}</code>
                          </td>
                          <td className="py-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                (snap.status !== 'created' && snap.status !== 'complete') ||
                                data?.workerStatus?.status === 'restoring' ||
                                data?.workerStatus?.status === 'destroying' ||
                                data?.workerStatus?.status === 'recovering'
                              }
                              onClick={() => {
                                setRestoreSnapshotId(snap.id);
                                setRestoreReason('');
                                setRestoreSnapshotDialogOpen(true);
                              }}
                            >
                              <RotateCcw className="mr-1 h-3 w-3" />
                              Restore
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {restoreAuditLogs && restoreAuditLogs.length > 0 && (
                <details className="mt-4">
                  <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
                    Recent snapshot restores ({restoreAuditLogs.length})
                  </summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground border-b text-left">
                          <th className="pr-4 pb-1">When</th>
                          <th className="pr-4 pb-1">Admin</th>
                          <th className="pr-4 pb-1">Snapshot</th>
                          <th className="pr-4 pb-1">Previous Volume</th>
                          <th className="pb-1">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {restoreAuditLogs.map(log => {
                          const meta = log.metadata ?? {};
                          return (
                            <tr key={log.id} className="border-b last:border-0">
                              <td className="py-1.5 pr-4 whitespace-nowrap">
                                <span title={formatAbsoluteTime(log.created_at)}>
                                  {formatRelativeTime(log.created_at)}
                                </span>
                              </td>
                              <td className="py-1.5 pr-4 whitespace-nowrap">
                                {log.actor_email ?? '—'}
                              </td>
                              <td className="py-1.5 pr-4">
                                <code>
                                  {typeof meta.snapshotId === 'string' ? meta.snapshotId : '—'}
                                </code>
                              </td>
                              <td className="py-1.5 pr-4">
                                <code>
                                  {typeof meta.previousVolumeId === 'string'
                                    ? meta.previousVolumeId
                                    : '—'}
                                </code>
                              </td>
                              <td className="text-muted-foreground py-1.5">
                                {typeof meta.reason === 'string' ? meta.reason : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        )}

        {/* Version Pin Card */}
        <VersionPinCard userId={data.user_id} instanceId={data.id} />

        {/* Workspace File Editor */}
        {!data.destroyed_at && (
          <Card>
            <CardHeader>
              <CardTitle>Workspace Files</CardTitle>
              <CardDescription>
                Browse and edit all files in /root/.openclaw/ — no filtering applied. Machine must
                be running for file operations to succeed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AdminFileEditor userId={data.user_id} instanceId={data.id} />
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

        {/* Snapshot Restore Confirmation Dialog */}
        <Dialog
          open={restoreSnapshotDialogOpen}
          onOpenChange={isRestoring ? () => {} : setRestoreSnapshotDialogOpen}
        >
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-500">
                <RotateCcw className="h-5 w-5" />
                Restore from Snapshot
              </DialogTitle>
              <DialogDescription className="pt-3">
                This will create a new volume from snapshot{' '}
                <code className="text-xs">{restoreSnapshotId}</code> and replace the current volume.
                <span className="text-foreground mt-2 block font-medium">
                  User: {data?.user_email ?? data?.user_id}
                </span>
                <span className="mt-2 block">
                  The instance will be stopped during the restore. The current volume will be
                  retained and can be reverted to via Volume Reassociation if needed.
                </span>
              </DialogDescription>
            </DialogHeader>
            <div className="py-2">
              <label htmlFor="restore-reason" className="text-sm font-medium">
                Reason for restore (min 10 chars)
              </label>
              <Textarea
                id="restore-reason"
                placeholder="e.g., User reported corrupted workspace files from 2 days ago..."
                value={restoreReason}
                onChange={e => setRestoreReason(e.target.value)}
                maxLength={500}
                className="mt-1"
                rows={3}
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <DialogClose asChild>
                <Button variant="secondary" disabled={isRestoring}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="default"
                disabled={isRestoring || restoreReason.length < 10 || !restoreSnapshotId}
                onClick={() => {
                  if (!data?.user_id || !data?.id || !restoreSnapshotId) return;
                  void restoreSnapshot({
                    userId: data.user_id,
                    instanceId: data.id,
                    snapshotId: restoreSnapshotId,
                    reason: restoreReason,
                  });
                }}
              >
                {isRestoring ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    Restoring...
                  </>
                ) : (
                  'Restore Snapshot'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={cleanupRecoveryVolumeDialogOpen}
          onOpenChange={isCleaningRecoveryVolume ? () => {} : setCleanupRecoveryVolumeDialogOpen}
        >
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Delete Retained Recovery Volume
              </DialogTitle>
              <DialogDescription className="pt-3">
                This will permanently delete the retained old recovery volume.
                <span className="text-foreground mt-2 block font-medium">
                  Volume:{' '}
                  <code className="text-xs">
                    {data?.workerStatus?.recoveryPreviousVolumeId ?? '—'}
                  </code>
                </span>
                <span className="mt-2 block">
                  If Fly still reports an attached machine on that volume, the cleanup will
                  force-destroy that machine first.
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <DialogClose asChild>
                <Button variant="secondary" disabled={isCleaningRecoveryVolume}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={isCleaningRecoveryVolume || !data?.workerStatus?.recoveryPreviousVolumeId}
                onClick={() =>
                  void cleanupRecoveryPreviousVolume({
                    userId: data.user_id,
                    instanceId: data.id,
                  })
                }
              >
                {isCleaningRecoveryVolume && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Delete Volume
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Run Doctor Dialog */}
        <RunDoctorDialog
          open={doctorDialogOpen}
          onOpenChange={setDoctorDialogOpen}
          mutation={runDoctorMutation}
        />

        {/* Restore Default Config Confirmation Dialog */}
        <Dialog
          open={restoreConfigDialogOpen && supportsConfigRestore}
          onOpenChange={restoreConfigMutation.isPending ? () => {} : setRestoreConfigDialogOpen}
        >
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Restore Default Config
              </DialogTitle>
              <DialogDescription className="pt-3">
                This will rewrite openclaw.json to defaults based on the machine&apos;s current
                environment variables and restart the gateway process. Any manual config changes
                made via the Control UI will be lost.
                <span className="text-foreground mt-2 block font-medium">
                  User: {data.user_email ?? data.user_id}
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="secondary"
                onClick={() => setRestoreConfigDialogOpen(false)}
                disabled={gatewayActionPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  restoreConfigMutation.mutate({ userId: data.user_id, instanceId: data.id })
                }
                disabled={gatewayActionPending}
              >
                {restoreConfigMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    Restoring...
                  </>
                ) : (
                  <>
                    <RotateCcw className="mr-1 h-4 w-4" />
                    Restore &amp; Restart
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DetailPageWrapper>
  );
}

type DoctorMutationLike = {
  data: { success: boolean; output: string } | undefined;
  isPending: boolean;
  isError: boolean;
  error: { message: string } | null;
  reset: () => void;
};

function RunDoctorDialog({
  open,
  onOpenChange,
  mutation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mutation: DoctorMutationLike;
}) {
  const handleOpenChange = (nextOpen: boolean) => {
    if (mutation.isPending) {
      return;
    }

    onOpenChange(nextOpen);
    if (!nextOpen) {
      mutation.reset();
    }
  };

  const rawResult = mutation.data;
  const result = rawResult ? { ...rawResult, output: stripAnsi(rawResult.output) } : rawResult;

  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? () => {} : handleOpenChange}>
      <DialogContent className="sm:max-w-[750px]">
        <DialogHeader>
          <DialogTitle>OpenClaw Doctor</DialogTitle>
          <DialogDescription>
            Running diagnostics and applying fixes on this instance.
          </DialogDescription>
        </DialogHeader>

        {mutation.isPending && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
            <p className="text-muted-foreground text-sm">Running diagnostics...</p>
          </div>
        )}

        {mutation.isError && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <XCircle className="h-8 w-8 text-red-400" />
            <p className="text-sm text-red-400">
              {mutation.error?.message || 'Failed to run doctor'}
            </p>
          </div>
        )}

        {result && !mutation.isPending && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {result.success ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <XCircle className="h-4 w-4 text-red-400" />
              )}
              <span className="text-sm font-medium">
                {result.success ? 'Executed successfully' : 'Issues detected'}
              </span>
            </div>
            <div className="border-border bg-background max-h-[400px] overflow-auto rounded-md border">
              {/* prettier-ignore */}
              <pre
                className="p-3 text-xs leading-relaxed whitespace-pre"
                style={{ fontFamily: "'Courier New', Courier, monospace", tabSize: 8 }}
              >{result.output}</pre>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={mutation.isPending}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
