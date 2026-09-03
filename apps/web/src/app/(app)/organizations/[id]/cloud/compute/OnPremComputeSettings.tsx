'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type {
  OnPremEnrollmentResponse,
  OnPremInstallationStatus,
  OnPremStatus,
} from '@cloud-agent-shared/onprem-protocol';
import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OnPremSetupGuide } from './OnPremSetupGuide';

type Enrollment = Omit<OnPremEnrollmentResponse, 'bootstrapToken'> & {
  name: string;
  bootstrapToken: string | null;
};

type RevokeTarget = { installationId: string; name: string; organizationId: string };

const STATUS_LABELS: Record<OnPremInstallationStatus['state'], string> = {
  pending: 'Waiting for provisioner',
  ready: 'Ready',
  offline: 'Offline',
  failed: 'Failed',
  revoked: 'Revoked',
};

export function OnPremComputeSettings({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  const statusOptions = trpc.organizations.onPremCompute.getStatus.queryOptions({ organizationId });
  const statusQuery = useQuery({
    ...statusOptions,
    staleTime: 0,
    retry: false,
    refetchInterval: 10_000,
  });
  const status = statusQuery.data;
  const installation = status?.installation;
  const currentEnrollment = enrollment?.organizationId === organizationId ? enrollment : null;
  const currentRevokeTarget = revokeTarget?.organizationId === organizationId ? revokeTarget : null;

  const enrollmentMutation = useMutation(
    trpc.organizations.onPremCompute.createEnrollment.mutationOptions({
      gcTime: 0,
      retry: false,
      networkMode: 'always',
    })
  );
  const selectMutation = useMutation(
    trpc.organizations.onPremCompute.selectTarget.mutationOptions({
      gcTime: 0,
      retry: false,
      networkMode: 'always',
    })
  );
  const revokeMutation = useMutation(
    trpc.organizations.onPremCompute.revoke.mutationOptions({
      gcTime: 0,
      retry: false,
      networkMode: 'always',
    })
  );
  const resetEnrollment = enrollmentMutation.reset;
  const resetSelection = selectMutation.reset;
  const resetRevocation = revokeMutation.reset;

  useLayoutEffect(() => {
    setName('');
    setEnrollment(null);
    setRevokeTarget(null);
    setActionError(null);

    return () => {
      requestGeneration.current += 1;
      resetEnrollment();
      resetSelection();
      resetRevocation();
    };
  }, [organizationId, resetEnrollment, resetSelection, resetRevocation]);

  useEffect(() => {
    if (!enrollment?.bootstrapToken) return;
    const timeout = window.setTimeout(
      () => {
        setEnrollment(current =>
          current === enrollment ? { ...current, bootstrapToken: null } : current
        );
      },
      Math.max(0, Date.parse(enrollment.expiresAt) - Date.now())
    );
    return () => window.clearTimeout(timeout);
  }, [enrollment]);

  useEffect(() => {
    if (
      enrollment?.installationId === installation?.id &&
      (installation?.enrolledAt || installation?.state === 'revoked')
    ) {
      setEnrollment(null);
    }
  }, [enrollment?.installationId, installation?.id, installation?.enrolledAt, installation?.state]);

  useLayoutEffect(() => {
    if (currentEnrollment?.bootstrapToken) tokenInputRef.current?.focus();
  }, [currentEnrollment?.bootstrapToken]);

  const isBusy =
    enrollmentMutation.isPending || selectMutation.isPending || revokeMutation.isPending;
  const hasUnconfirmedEnrollment =
    currentEnrollment && currentEnrollment.installationId !== installation?.id;
  const canEnroll =
    statusQuery.isSuccess &&
    !hasUnconfirmedEnrollment &&
    (!installation ||
      (installation.state === 'revoked' &&
        !installation.cleanupPending &&
        installation.activeAllocations === 0 &&
        !status?.selected));
  const canSelect =
    statusQuery.isSuccess &&
    installation?.state === 'ready' &&
    installation.profile &&
    !status?.selected;
  const revocableTarget: RevokeTarget | null = hasUnconfirmedEnrollment
    ? {
        installationId: currentEnrollment.installationId,
        name: currentEnrollment.name,
        organizationId,
      }
    : installation && installation.state !== 'revoked'
      ? { installationId: installation.id, name: installation.name, organizationId }
      : null;

  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: statusOptions.queryKey });

  async function updateStatus(nextStatus: OnPremStatus, generation: number) {
    await queryClient.cancelQueries({ queryKey: statusOptions.queryKey });
    if (generation !== requestGeneration.current) return;
    queryClient.setQueryData(statusOptions.queryKey, nextStatus);
    void invalidateStatus();
  }

  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const installationName = name.trim();
    if (!canEnroll || isBusy || !installationName) return;
    const generation = ++requestGeneration.current;
    setActionError(null);
    setEnrollment(null);

    try {
      const result = await enrollmentMutation.mutateAsync({
        organizationId,
        name: installationName,
      });
      if (generation !== requestGeneration.current) return;
      setEnrollment({ ...result, name: installationName });
      setName('');
      void invalidateStatus();
    } catch {
      if (generation === requestGeneration.current) {
        setActionError('Could not create enrollment. Refresh the status before trying again.');
        void invalidateStatus();
      }
    } finally {
      if (generation === requestGeneration.current) resetEnrollment();
    }
  }

  async function selectTarget(selected: boolean) {
    if (isBusy || !installation?.profile || (selected && !canSelect)) return;
    const generation = ++requestGeneration.current;
    setActionError(null);

    try {
      const result = await selectMutation.mutateAsync({
        organizationId,
        installationId: installation.id,
        profileId: installation.profile.id,
        selected,
      });
      if (generation !== requestGeneration.current) return;
      await updateStatus(result, generation);
      if (generation === requestGeneration.current) toast.success('Compute selection updated');
    } catch {
      if (generation === requestGeneration.current) {
        setActionError('Could not change compute selection. Refresh the status and try again.');
        void invalidateStatus();
      }
    } finally {
      if (generation === requestGeneration.current) resetSelection();
    }
  }

  async function revoke() {
    if (!currentRevokeTarget || isBusy) return;
    const generation = ++requestGeneration.current;
    setActionError(null);

    try {
      const result = await revokeMutation.mutateAsync({
        organizationId,
        installationId: currentRevokeTarget.installationId,
      });
      if (generation !== requestGeneration.current) return;
      setEnrollment(null);
      await updateStatus(result, generation);
      if (generation !== requestGeneration.current) return;
      setRevokeTarget(null);
      toast.success('Revocation requested. Check physical cleanup status separately.');
    } catch {
      if (generation === requestGeneration.current) {
        setActionError(
          'Revocation was not confirmed. Try again and keep the provisioner connected for cleanup.'
        );
        void invalidateStatus();
      }
    } finally {
      if (generation === requestGeneration.current) resetRevocation();
    }
  }

  async function copyBootstrapToken() {
    if (!currentEnrollment?.bootstrapToken) return;
    if (Date.parse(currentEnrollment.expiresAt) <= Date.now()) {
      setEnrollment({ ...currentEnrollment, bootstrapToken: null });
      return;
    }
    const generation = requestGeneration.current;
    try {
      await navigator.clipboard.writeText(currentEnrollment.bootstrapToken);
      if (generation === requestGeneration.current) toast.success('Bootstrap token copied');
    } catch {
      if (generation === requestGeneration.current) {
        setActionError(
          'Could not copy the bootstrap token. Check clipboard permissions and try again.'
        );
      }
    }
  }

  return (
    <AlertDialog
      open={!!currentRevokeTarget}
      onOpenChange={open => {
        if (!open && !revokeMutation.isPending) {
          setRevokeTarget(null);
          setActionError(null);
        }
      }}
    >
      <section
        aria-labelledby="onprem-compute-title"
        className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6"
      >
        <header className="space-y-2">
          <h2 id="onprem-compute-title" className="text-2xl font-semibold tracking-tight">
            On-prem Kubernetes compute
          </h2>
          <p className="text-muted-foreground text-sm">
            Kilo hosts coordination and session history. Your organization supplies Kubernetes
            compute through the Kilo provisioner.
          </p>
        </header>

        <OnPremSetupGuide />

        {statusQuery.isPending && (
          <Alert role="status">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <AlertTitle>Loading on-prem compute status</AlertTitle>
          </Alert>
        )}

        {statusQuery.isError && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>On-prem status is unavailable</AlertTitle>
            <AlertDescription>
              <p>
                The compute selection has not been changed. Any status below is the last known
                state. Existing installations can still be revoked.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="min-h-control-touch sm:min-h-0"
                disabled={statusQuery.isFetching}
                onClick={() => void statusQuery.refetch()}
              >
                <RefreshCw aria-hidden="true" />
                Refresh status
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {actionError && !currentRevokeTarget && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Action could not be completed</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}

        {status?.selected &&
          (installation?.state !== 'ready' || !installation?.profile || statusQuery.isError) && (
            <Alert variant="warning">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>On-prem compute is still selected</AlertTitle>
              <AlertDescription>
                New workspaces will not fall back to existing compute while this installation is
                unavailable. Restore the installation or explicitly return to existing compute
                below.
              </AlertDescription>
            </Alert>
          )}

        {installation && (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="min-w-0 break-words text-base" role="heading" aria-level={3}>
                  {installation.name}
                </CardTitle>
                <Badge
                  variant={
                    installation.state === 'failed' || installation.state === 'revoked'
                      ? 'destructive'
                      : 'secondary'
                  }
                >
                  {STATUS_LABELS[installation.state]}
                </Badge>
              </div>
              <CardDescription className="break-all font-mono">{installation.id}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Last connection</dt>
                  <dd>
                    {installation.lastSeenAt ? (
                      <time dateTime={installation.lastSeenAt}>
                        {new Date(installation.lastSeenAt).toLocaleString()}
                      </time>
                    ) : (
                      'Not connected yet'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Runner version</dt>
                  <dd className="break-all font-mono">
                    {installation.runnerVersion ?? 'Not reported'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Runtime class</dt>
                  <dd className="break-all font-mono">
                    {installation.profile?.runtimeClass ?? 'Not reported'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Runtime profile</dt>
                  <dd className="break-all font-mono">
                    {installation.profile
                      ? `${installation.profile.id} (revision ${installation.profile.revision})`
                      : 'Not reported'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Active allocations</dt>
                  <dd className="tabular-nums">{installation.activeAllocations}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Physical cleanup</dt>
                  <dd>
                    {installation.cleanupPending ? 'Pending confirmation' : 'No cleanup pending'}
                  </dd>
                </div>
                {installation.profile && (
                  <div>
                    <dt className="text-muted-foreground">Maximum workspace lifetime</dt>
                    <dd className="tabular-nums">
                      {Math.round(installation.profile.maxLifetimeMs / 60_000)} minutes
                    </dd>
                  </div>
                )}
              </dl>
              {installation.diagnosticCode && (
                <p className="text-muted-foreground text-sm">
                  Diagnostic: <code className="break-all">{installation.diagnosticCode}</code>
                </p>
              )}
              {installation.cleanupPending && (
                <Alert variant="warning">
                  <AlertTriangle aria-hidden="true" />
                  <AlertTitle>Physical cleanup is not confirmed</AlertTitle>
                  <AlertDescription>
                    Keep the provisioner connected so it can stop and report owned workloads.
                    Revoked authority does not mean that Kubernetes resources have been removed.
                  </AlertDescription>
                </Alert>
              )}
              {installation.state === 'pending' && !currentEnrollment?.bootstrapToken && (
                <p className="text-muted-foreground text-sm">
                  Waiting for the provisioner to enroll. If the one-time bootstrap token was lost or
                  expired, revoke this enrollment before creating another.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {canEnroll && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base" role="heading" aria-level={3}>
                Enroll a Kubernetes installation
              </CardTitle>
              <CardDescription>
                Review <code>install-preview.json</code> first, then create this ten-minute
                enrollment. Creating enrollment does not install resources; run{' '}
                <code>install:local</code> with{' '}
                <code className="break-all">{'--approve <reviewed-hash>'}</code> from your machine.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={enroll}>
                <div className="space-y-2">
                  <Label htmlFor="onprem-installation-name">Installation name</Label>
                  <Input
                    id="onprem-installation-name"
                    value={name}
                    onChange={event => setName(event.target.value)}
                    placeholder="Dedicated local Kubernetes cluster"
                    autoComplete="off"
                    maxLength={128}
                    required
                    disabled={isBusy}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={isBusy || !name.trim()}
                  className="min-h-control-touch sm:min-h-0"
                >
                  {enrollmentMutation.isPending && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  {enrollmentMutation.isPending ? 'Creating enrollment…' : 'Create enrollment'}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {currentEnrollment && !currentEnrollment.bootstrapToken && (
          <Alert>
            <AlertTitle>Bootstrap token cleared or expired</AlertTitle>
            <AlertDescription>
              This token cannot be retrieved again. If the provisioner has not enrolled, revoke this
              enrollment before creating another.
            </AlertDescription>
          </Alert>
        )}

        {currentEnrollment?.bootstrapToken && (
          <Card className="ph-no-capture">
            <CardHeader>
              <CardTitle className="text-base" role="heading" aria-level={3}>
                Connect the provisioner
              </CardTitle>
              <CardDescription>
                Save these fields in the private enrollment file from the setup guide, then run{' '}
                <code>install:local</code> with{' '}
                <code className="break-all">{'--approve <reviewed-hash>'}</code>. Keep the one-time
                token out of shell arguments, source control, and logs.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Organization ID</dt>
                  <dd className="break-all font-mono">{currentEnrollment.organizationId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Installation ID</dt>
                  <dd className="break-all font-mono">{currentEnrollment.installationId}</dd>
                </div>
              </dl>
              <Label htmlFor="onprem-bootstrap-token">One-time bootstrap token</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  ref={tokenInputRef}
                  id="onprem-bootstrap-token"
                  type="password"
                  readOnly
                  value={currentEnrollment.bootstrapToken}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="onprem-bootstrap-expiry"
                  className="ph-no-capture min-w-0 font-mono"
                  data-1p-ignore
                  data-lpignore="true"
                  data-sentry-mask
                />
                <Button
                  variant="outline"
                  onClick={copyBootstrapToken}
                  className="min-h-control-touch sm:min-h-0"
                >
                  <Copy aria-hidden="true" />
                  Copy token
                </Button>
              </div>
              <p id="onprem-bootstrap-expiry" className="text-muted-foreground text-sm">
                Expires{' '}
                <time dateTime={currentEnrollment.expiresAt}>
                  <code className="break-all">{currentEnrollment.expiresAt}</code>
                </time>
                . Use this exact ISO expiry and protocolVersion 1 in the enrollment file. The token
                cannot be retrieved after leaving this page.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-control-touch sm:min-h-0"
                onClick={() => setEnrollment({ ...currentEnrollment, bootstrapToken: null })}
              >
                Clear token from this page
              </Button>
            </CardContent>
          </Card>
        )}

        {(status || currentEnrollment) && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {status
                ? status.selected
                  ? 'On-prem compute is selected for new workspaces.'
                  : 'New workspaces use existing compute routing, including customer Vercel when configured.'
                : 'Compute selection is unavailable. Refresh status to verify the current target.'}{' '}
              Changing the target affects only new workspaces. Existing workspaces stay pinned to
              their original compute.
            </p>
            <div className="flex flex-wrap gap-3">
              {canSelect && (
                <Button
                  disabled={isBusy}
                  onClick={() => selectTarget(true)}
                  className="min-h-control-touch sm:min-h-0"
                >
                  {selectMutation.isPending && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  Use for new workspaces
                </Button>
              )}
              {status?.selected && (
                <Button
                  variant="outline"
                  disabled={isBusy || !installation?.profile}
                  onClick={() => selectTarget(false)}
                  className="min-h-control-touch sm:min-h-0"
                >
                  {selectMutation.isPending && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  Return to existing compute
                </Button>
              )}
              {revocableTarget && (
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    disabled={isBusy}
                    className="min-h-control-touch sm:min-h-0"
                    onClick={() => {
                      setActionError(null);
                      setRevokeTarget(revocableTarget);
                    }}
                  >
                    Revoke installation
                  </Button>
                </AlertDialogTrigger>
              )}
            </div>
            {status?.selected && !installation?.profile && (
              <p className="text-muted-foreground text-sm">
                The selected runtime profile is unavailable. Refresh status before changing the
                target. Revocation does not require a ready profile.
              </p>
            )}
            {installation &&
              installation.state !== 'ready' &&
              installation.state !== 'revoked' &&
              !status?.selected && (
                <p className="text-muted-foreground text-sm">
                  Selection becomes available when the provisioner reports a ready runtime profile.
                </p>
              )}
          </div>
        )}
      </section>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            Revoke {currentRevokeTarget?.name}?
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <span className="block">
              This removes launch and credential authority and requests termination of owned
              workloads. Keep the provisioner connected for stop and cleanup reports.
            </span>
            <span className="block">
              Revocation does not confirm physical cleanup. Check Kubernetes resources and the
              cleanup status separately. On-prem selection stays unchanged; there is no automatic
              fallback.
            </span>
            <span className="block break-all font-mono">{currentRevokeTarget?.installationId}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {actionError && (
          <p role="alert" className="text-destructive text-sm">
            {actionError}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isBusy || !currentRevokeTarget}
            onClick={revoke}
          >
            {revokeMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {revokeMutation.isPending ? 'Revoking…' : 'Revoke installation'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
