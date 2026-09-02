'use client';

import Link from 'next/link';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Circle, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
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

const SETUP_STEPS = [
  ['validating_access', 'Validate Vercel access'],
  ['create_builder', 'Create a temporary builder'],
  ['install_system_dependencies', 'Install system dependencies'],
  ['install_node_dependencies', 'Install runtime dependencies'],
  ['upload_runtime_artifacts', 'Upload Kilo runtime'],
  ['verify_runtime_artifacts', 'Verify runtime artifacts'],
  ['snapshot_builder', 'Create runtime snapshot'],
  ['create_validator', 'Create a validation sandbox'],
  ['launch_validator_wrapper', 'Launch call-home validation'],
  ['verify_validator_call_home', 'Verify call-home connection'],
  ['stop_validator', 'Stop validation sandbox'],
  ['confirm_terminal', 'Confirm cleanup'],
] as const;

function dashboardUrl(teamSlug: string | null, projectSlug: string | null): string | null {
  if (!teamSlug || !projectSlug) return null;
  return `https://vercel.com/${encodeURIComponent(teamSlug)}/${encodeURIComponent(projectSlug)}`;
}

function projectLabel(
  teamSlug: string | null,
  projectSlug: string | null,
  projectId: string
): string {
  if (teamSlug && projectSlug) return `${teamSlug}/${projectSlug}`;
  return projectSlug || projectId;
}

function statusCopy(
  status: string,
  enrollment: 'enrolled' | 'not-enrolled' | 'unavailable' | 'checking'
): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive';
} {
  if (status === 'ready' && enrollment !== 'enrolled') {
    return {
      label:
        enrollment === 'checking'
          ? 'Checking enrollment'
          : enrollment === 'unavailable'
            ? 'Unavailable'
            : 'Not enrolled',
      variant: 'secondary',
    };
  }

  switch (status) {
    case 'ready':
      return { label: 'Ready', variant: 'default' };
    case 'failed':
      return { label: 'Setup failed', variant: 'destructive' };
    case 'building':
      return { label: 'Setting up', variant: 'secondary' };
    default:
      return { label: 'Not started', variant: 'secondary' };
  }
}

export function VercelComputeSettings({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const [removedDashboardUrl, setRemovedDashboardUrl] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const connectionTitleRef = useRef<HTMLDivElement>(null);

  const enrollmentQuery = useQuery(
    trpc.organizations.vercelCompute.getEnrollment.queryOptions({ organizationId })
  );
  const enrollmentState = enrollmentQuery.isPending
    ? 'checking'
    : enrollmentQuery.isError
      ? 'unavailable'
      : enrollmentQuery.data?.enrolled
        ? 'enrolled'
        : 'not-enrolled';
  const isEnrolled = enrollmentState === 'enrolled';

  const statusQuery = useQuery({
    ...trpc.organizations.vercelCompute.getStatus.queryOptions({ organizationId }),
    refetchInterval: query =>
      query.state.data?.setupStatus === 'pending' || query.state.data?.setupStatus === 'building'
        ? 2_000
        : false,
  });
  const status = statusQuery.data;
  const isSetupFormVisible = !status && statusQuery.isSuccess && isEnrolled;

  const invalidateStatus = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.organizations.vercelCompute.getStatus.queryKey({ organizationId }),
    });

  const discoverTeamsMutation = useMutation(
    trpc.organizations.vercelCompute.discoverTeams.mutationOptions({ gcTime: 0 })
  );
  const discoverProjectsMutation = useMutation(
    trpc.organizations.vercelCompute.discoverProjects.mutationOptions({ gcTime: 0 })
  );
  const addMutation = useMutation(
    trpc.organizations.vercelCompute.add.mutationOptions({ gcTime: 0 })
  );
  const retryMutation = useMutation(
    trpc.organizations.vercelCompute.retrySetup.mutationOptions({
      onSuccess: () => {
        toast.success('Vercel compute setup restarted');
        void invalidateStatus();
      },
      onError: error => toast.error(error.message || 'Could not retry setup'),
    })
  );
  const removeMutation = useMutation(
    trpc.organizations.vercelCompute.remove.mutationOptions({
      onSuccess: () => {
        setRemoveOpen(false);
        setCleanupFailed(false);
        setRemovedDashboardUrl(current => current ?? 'https://vercel.com/dashboard');
        toast.success('Vercel compute credentials removed');
        void invalidateStatus();
      },
      onError: error => {
        if (error.data?.code === 'PRECONDITION_FAILED') setCleanupFailed(true);
        toast.error(error.message || 'Could not remove credentials');
      },
    })
  );

  const resetTeamsMutation = discoverTeamsMutation.reset;
  const resetProjectsMutation = discoverProjectsMutation.reset;
  const resetAddMutation = addMutation.reset;

  useLayoutEffect(() => {
    setToken('');
    setTeamId('');
    setProjectId('');
    setSetupError(null);

    return () => {
      requestGeneration.current += 1;
      resetTeamsMutation();
      resetProjectsMutation();
      resetAddMutation();
    };
  }, [
    organizationId,
    isSetupFormVisible,
    resetTeamsMutation,
    resetProjectsMutation,
    resetAddMutation,
  ]);

  const isDiscovering = discoverTeamsMutation.isPending || discoverProjectsMutation.isPending;
  const isBusy = addMutation.isPending || retryMutation.isPending || removeMutation.isPending;
  const isFormBusy = isBusy || isDiscovering;
  const normalizedToken = token.trim();
  const teams =
    discoverTeamsMutation.variables?.organizationId === organizationId &&
    discoverTeamsMutation.variables.token === normalizedToken
      ? discoverTeamsMutation.data
      : undefined;
  const projects =
    discoverProjectsMutation.variables?.organizationId === organizationId &&
    discoverProjectsMutation.variables.token === normalizedToken &&
    discoverProjectsMutation.variables.teamId === teamId
      ? discoverProjectsMutation.data
      : undefined;
  const hasTeams = !!teams?.length;

  useLayoutEffect(() => {
    if (hasTeams) connectionTitleRef.current?.focus();
    else tokenInputRef.current?.focus();
  }, [hasTeams]);

  const selectedTeam = teams?.find(team => team.id === teamId);
  const selectedProject = projects?.find(
    project => project.id === projectId && project.teamId === teamId
  );
  const canStartSetup =
    !isFormBusy && isSetupFormVisible && !!normalizedToken && !!selectedTeam && !!selectedProject;

  function resetDiscovery() {
    requestGeneration.current += 1;
    setTeamId('');
    setProjectId('');
    resetTeamsMutation();
    resetProjectsMutation();
    resetAddMutation();
  }

  async function loadProjects(nextTeamId: string) {
    if (isFormBusy || !isSetupFormVisible || !normalizedToken || !nextTeamId) return;

    const generation = ++requestGeneration.current;
    setTeamId(nextTeamId);
    setProjectId('');
    setSetupError(null);
    resetProjectsMutation();
    resetAddMutation();

    try {
      const discoveredProjects = await discoverProjectsMutation.mutateAsync({
        organizationId,
        token: normalizedToken,
        teamId: nextTeamId,
      });
      if (generation !== requestGeneration.current) return;

      const onlyProject = discoveredProjects.length === 1 ? discoveredProjects[0] : undefined;
      if (onlyProject) setProjectId(onlyProject.id);
    } catch {
      return;
    }
  }

  async function discoverTeams() {
    if (isFormBusy || !isSetupFormVisible || !normalizedToken) return;

    resetDiscovery();
    const generation = requestGeneration.current;
    setSetupError(null);

    try {
      const discoveredTeams = await discoverTeamsMutation.mutateAsync({
        organizationId,
        token: normalizedToken,
      });
      if (generation !== requestGeneration.current) return;

      const onlyTeam = discoveredTeams.length === 1 ? discoveredTeams[0] : undefined;
      if (onlyTeam) await loadProjects(onlyTeam.id);
    } catch {
      return;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasTeams) {
      await discoverTeams();
      return;
    }
    if (!canStartSetup || !selectedTeam || !selectedProject) return;

    const generation = ++requestGeneration.current;
    setSetupError(null);

    try {
      await addMutation.mutateAsync({
        organizationId,
        token: normalizedToken,
        teamId: selectedTeam.id,
        projectId: selectedProject.id,
      });
    } catch (error) {
      if (generation === requestGeneration.current) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : 'Could not start Vercel compute setup';
        setSetupError(message);
        toast.error(message);
      }
      return;
    } finally {
      if (generation === requestGeneration.current) resetAddMutation();
      void invalidateStatus();
    }

    if (generation !== requestGeneration.current) return;

    setToken('');
    resetDiscovery();
    setSetupError(null);
    toast.success('Vercel compute setup started');
  }

  function requestRemove() {
    setCleanupFailed(false);
    setRemovedDashboardUrl(dashboardUrl(status?.teamSlug ?? null, status?.projectSlug ?? null));
    setRemoveOpen(true);
  }

  const setupStatus = status ? statusCopy(status.setupStatus, enrollmentState) : null;
  const currentStep = status?.setupStep
    ? SETUP_STEPS.findIndex(([step]) => step === status.setupStep)
    : -1;
  const projectLink = dashboardUrl(status?.teamSlug ?? null, status?.projectSlug ?? null);

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Vercel compute</h1>
          <p className="text-muted-foreground text-sm">
            Run Cloud Agent on your team&apos;s Vercel account.
          </p>
        </header>

        {enrollmentState === 'checking' && (
          <Alert>
            <Loader2 className="animate-spin" />
            <AlertTitle>Checking Vercel compute availability</AlertTitle>
            <AlertDescription>
              Setup stays unavailable until organization enrollment is confirmed.
            </AlertDescription>
          </Alert>
        )}

        {enrollmentState === 'unavailable' && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Vercel compute availability could not be verified</AlertTitle>
            <AlertDescription>
              Setup is temporarily unavailable. Try again later. Existing credentials can still be
              removed.
            </AlertDescription>
          </Alert>
        )}

        {enrollmentState === 'not-enrolled' && (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>Customer-paid Vercel is not enabled</AlertTitle>
            <AlertDescription>
              This organization is not enrolled in customer-paid Vercel compute. Existing
              credentials can still be removed.
            </AlertDescription>
          </Alert>
        )}

        {isSetupFormVisible ? (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle
                ref={connectionTitleRef}
                className="text-base"
                role="heading"
                aria-level={2}
                tabIndex={-1}
              >
                {hasTeams ? 'Choose a project' : 'Connect your account'}
              </CardTitle>
              {hasTeams && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-control-touch sm:min-h-0"
                  disabled={isFormBusy}
                  onClick={() => {
                    setToken('');
                    resetDiscovery();
                    setSetupError(null);
                  }}
                >
                  Change token
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <form className="space-y-5" autoComplete="off" onSubmit={submit}>
                {!hasTeams ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="vercel-token">Vercel token</Label>
                      <Button
                        variant="link"
                        size="sm"
                        className="min-h-control-touch px-0 sm:min-h-0"
                        asChild
                      >
                        <Link
                          href="https://vercel.com/account/tokens"
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="Create a Vercel token (opens in a new tab)"
                        >
                          Create token <ExternalLink aria-hidden="true" />
                        </Link>
                      </Button>
                    </div>
                    <Input
                      ref={tokenInputRef}
                      id="vercel-token"
                      name="vercel-access-secret"
                      type="password"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-1p-ignore="true"
                      data-lpignore="true"
                      data-form-type="other"
                      value={token}
                      onChange={event => {
                        if (isFormBusy) return;
                        setToken(event.target.value);
                        resetDiscovery();
                        setSetupError(null);
                      }}
                      placeholder="Paste your access token"
                      required
                      disabled={isFormBusy}
                      className="h-control-touch sm:h-9"
                      aria-invalid={discoverTeamsMutation.isError}
                      aria-describedby={
                        discoverTeamsMutation.isError
                          ? 'vercel-token-help vercel-teams-error'
                          : 'vercel-token-help vercel-teams-status'
                      }
                    />
                    <p id="vercel-token-help" className="text-muted-foreground text-xs">
                      Use a team- or project-scoped Vercel token.
                    </p>
                    <p
                      id="vercel-teams-status"
                      className={teams?.length === 0 ? 'text-muted-foreground text-sm' : 'sr-only'}
                      role="status"
                      aria-atomic="true"
                    >
                      {discoverTeamsMutation.isPending
                        ? 'Finding your Vercel teams.'
                        : teams?.length === 0
                          ? 'No teams found. Check the token’s team access and try again.'
                          : null}
                    </p>
                    {discoverTeamsMutation.isError && (
                      <p id="vercel-teams-error" className="text-destructive text-sm" role="alert">
                        {discoverTeamsMutation.error.message ||
                          'Could not connect to Vercel. Check your token and try again.'}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor="vercel-team">Team</Label>
                        <Select
                          value={teamId}
                          onValueChange={loadProjects}
                          required
                          disabled={isFormBusy}
                        >
                          <SelectTrigger
                            id="vercel-team"
                            className="min-h-control-touch w-full min-w-0 sm:min-h-0"
                          >
                            <SelectValue placeholder="Select a team">
                              {selectedTeam && (
                                <span className="truncate">{selectedTeam.name}</span>
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="max-w-(--radix-select-trigger-width)">
                            {teams?.map(team => (
                              <SelectItem
                                key={team.id}
                                value={team.id}
                                textValue={`${team.name} ${team.slug} ${team.id}`}
                              >
                                <span className="flex min-w-0 flex-col items-start gap-1 whitespace-normal">
                                  <span className="break-all">{team.name}</span>
                                  <span className="text-muted-foreground text-xs break-all">
                                    {team.slug} · <span className="font-mono">{team.id}</span>
                                  </span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor="vercel-project">Project</Label>
                        <Select
                          value={projectId}
                          onValueChange={value => {
                            if (isFormBusy || !value) return;
                            setProjectId(value);
                            setSetupError(null);
                          }}
                          required
                          disabled={isFormBusy || !projects?.length}
                        >
                          <SelectTrigger
                            id="vercel-project"
                            className="min-h-control-touch w-full min-w-0 sm:min-h-0"
                            aria-invalid={discoverProjectsMutation.isError}
                            aria-describedby={
                              discoverProjectsMutation.isError
                                ? 'vercel-projects-error'
                                : 'vercel-projects-status'
                            }
                          >
                            <SelectValue
                              placeholder={
                                !selectedTeam
                                  ? 'Choose a team first'
                                  : discoverProjectsMutation.isPending
                                    ? 'Loading projects...'
                                    : projects?.length === 0
                                      ? 'No projects available'
                                      : 'Select a project'
                              }
                            >
                              {selectedProject && (
                                <span className="truncate">{selectedProject.name}</span>
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="max-w-(--radix-select-trigger-width)">
                            {projects?.map(project => (
                              <SelectItem
                                key={project.id}
                                value={project.id}
                                textValue={`${project.name} ${project.slug} ${project.id}`}
                              >
                                <span className="flex min-w-0 flex-col items-start gap-1 whitespace-normal">
                                  <span className="break-all">{project.name}</span>
                                  <span className="text-muted-foreground text-xs break-all">
                                    {project.slug} · <span className="font-mono">{project.id}</span>
                                  </span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p
                          id="vercel-projects-status"
                          className={
                            projects?.length === 0 ? 'text-muted-foreground text-sm' : 'sr-only'
                          }
                          role="status"
                          aria-atomic="true"
                        >
                          {discoverProjectsMutation.isPending
                            ? 'Loading projects for the selected team.'
                            : projects?.length === 0
                              ? 'No projects found. Choose another team or check token access.'
                              : null}
                        </p>
                        {discoverProjectsMutation.isError && (
                          <p
                            id="vercel-projects-error"
                            className="text-destructive text-sm"
                            role="alert"
                          >
                            {discoverProjectsMutation.error.message ||
                              'Could not load projects. Try again.'}
                          </p>
                        )}
                        {(discoverProjectsMutation.isError || projects?.length === 0) && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => loadProjects(teamId)}
                            disabled={isFormBusy || !selectedTeam}
                            className="min-h-control-touch w-full sm:min-h-0 sm:w-auto"
                          >
                            {discoverProjectsMutation.isError
                              ? 'Retry projects'
                              : 'Reload projects'}
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="text-muted-foreground space-y-2 border-t pt-4 text-xs leading-relaxed">
                      <p id="vercel-setup-notice">
                        Vercel bills your team for setup and sessions. Project admins may access the
                        Kilo token used by sessions.
                      </p>
                      <details>
                        <summary className="text-foreground focus-visible:ring-ring min-h-control-touch cursor-pointer content-center rounded-sm focus-visible:ring-2 sm:min-h-0">
                          Setup details
                        </summary>
                        <p className="mt-2">
                          Kilo creates temporary build and validation sandboxes, then saves a
                          runtime snapshot for future sessions. Your Vercel token is stored
                          encrypted when you start setup.
                        </p>
                      </details>
                    </div>
                  </>
                )}
                {setupError && (
                  <p className="text-destructive text-sm" role="alert">
                    {setupError}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={
                      hasTeams
                        ? !canStartSetup
                        : isFormBusy || !isSetupFormVisible || !normalizedToken
                    }
                    className="min-h-control-touch w-full sm:min-h-0 sm:w-auto"
                    aria-describedby={hasTeams ? 'vercel-setup-notice' : undefined}
                  >
                    {(discoverTeamsMutation.isPending || addMutation.isPending) && (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    )}
                    {hasTeams
                      ? addMutation.isPending
                        ? 'Starting setup...'
                        : 'Start setup'
                      : discoverTeamsMutation.isPending
                        ? 'Finding teams...'
                        : 'Continue'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : status ? (
          <>
            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base">Vercel runtime</CardTitle>
                  <CardDescription>
                    {status.setupStatus === 'ready'
                      ? isEnrolled
                        ? 'New sessions are ready to use this customer-paid project.'
                        : enrollmentState === 'checking'
                          ? 'Checking whether new sessions can use this configured project.'
                          : enrollmentState === 'unavailable'
                            ? 'Enrollment could not be verified. This project cannot be confirmed as active.'
                            : 'This organization is not enrolled. New sessions will not use this project.'
                      : 'Setup status is updated automatically while the runtime is built.'}
                  </CardDescription>
                </div>
                {setupStatus && <Badge variant={setupStatus.variant}>{setupStatus.label}</Badge>}
              </CardHeader>
              <CardContent className="space-y-5">
                {status.setupStatus === 'ready' ? (
                  <div className="bg-muted/40 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-medium">
                        {projectLabel(status.teamSlug, status.projectSlug, status.projectId)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Runtime snapshot {status.runtimeSnapshotId}
                      </p>
                    </div>
                    {projectLink && (
                      <Button variant="outline" size="sm" asChild>
                        <Link href={projectLink} target="_blank" rel="noreferrer">
                          Open Vercel project <ExternalLink className="ml-2 size-3.5" />
                        </Link>
                      </Button>
                    )}
                  </div>
                ) : status.setupStatus === 'failed' ? (
                  <Alert variant="destructive">
                    <AlertTriangle />
                    <AlertTitle>Setup could not finish</AlertTitle>
                    <AlertDescription>
                      {status.setupError === 'byoc_vercel_forbidden'
                        ? 'The token cannot access this team or project.'
                        : status.setupError === 'byoc_vercel_capacity'
                          ? 'Vercel rejected the request because of a capacity or spend limit.'
                          : status.setupError === 'byoc_vercel_snapshot_missing'
                            ? 'The runtime snapshot expired or was deleted. Retry setup to rebuild it.'
                            : 'Check the token, team, and project access, then retry setup.'}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="space-y-3">
                    {SETUP_STEPS.map(([step, label], index) => {
                      const complete = status.setupStatus === 'ready' || index < currentStep;
                      const active = status.setupStatus !== 'failed' && index === currentStep;
                      return (
                        <div key={step} className="flex items-center gap-3 text-sm">
                          <span
                            className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${complete ? 'border-primary bg-primary text-primary-foreground' : active ? 'border-primary text-primary' : 'text-muted-foreground'}`}
                          >
                            {complete ? (
                              <Check className="size-3.5" />
                            ) : active ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Circle className="size-2.5 fill-current" />
                            )}
                          </span>
                          <span className={active ? 'font-medium' : 'text-muted-foreground'}>
                            {label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {status.setupStatus === 'failed' && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      disabled={isBusy || !isEnrolled}
                      onClick={() => retryMutation.mutate({ organizationId })}
                    >
                      {retryMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                      Retry setup
                    </Button>
                    <Button variant="destructive" disabled={isBusy} onClick={requestRemove}>
                      <Trash2 className="mr-2 size-4" /> Remove credentials
                    </Button>
                  </div>
                )}
                {status.setupStatus === 'ready' && (
                  <div className="flex justify-end">
                    <Button variant="destructive" disabled={isBusy} onClick={requestRemove}>
                      <Trash2 className="mr-2 size-4" /> Remove credentials
                    </Button>
                  </div>
                )}
                {(status.setupStatus === 'pending' || status.setupStatus === 'building') && (
                  <div className="flex justify-end">
                    <Button variant="destructive" disabled={isBusy} onClick={requestRemove}>
                      <Trash2 className="mr-2 size-4" /> Remove credentials
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {status.setupStatus !== 'ready' && status.setupStatus !== 'failed' && (
              <p className="text-muted-foreground text-center text-xs">
                You can leave this page open. Setup will continue in the background.
              </p>
            )}
          </>
        ) : null}

        {removedDashboardUrl !== null && !status && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Credentials removed</CardTitle>
              <CardDescription>
                Kilo no longer has authority over existing Vercel sandboxes or snapshots. Review or
                remove them in Vercel before starting another Cloud Agent session.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" asChild>
                <Link
                  href={removedDashboardUrl ?? 'https://vercel.com/dashboard'}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Vercel dashboard <ExternalLink className="ml-2 size-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <AlertDialog
        open={removeOpen}
        onOpenChange={open => {
          if (removeMutation.isPending) return;
          setRemoveOpen(open);
          if (!open) setCleanupFailed(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Vercel credentials?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">
                Kilo first attempts to remove the runtime snapshot and setup resources. Once the
                credentials are deleted, Kilo can no longer start, inspect, extend, or stop your
                Vercel sandboxes. Existing Cloud Agent sessions using this project will stop
                working.
              </span>
              <span className="block">
                Review remaining snapshots and running sandboxes in Vercel before continuing. Open{' '}
                <strong>Observability → Sandboxes</strong> in the project after removal. You may
                also revoke the token directly in Vercel.
              </span>
              {cleanupFailed && (
                <span className="text-destructive block font-medium">
                  Automatic cleanup could not be confirmed. Removing credentials now may leave
                  billable Vercel snapshots or sandboxes that Kilo can no longer remove.
                </span>
              )}
              {removedDashboardUrl && (
                <Link
                  href={removedDashboardUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary inline-flex items-center gap-1 underline underline-offset-4"
                >
                  Open the configured Vercel project <ExternalLink className="size-3" />
                </Link>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removeMutation.isPending}
              onClick={() =>
                removeMutation.mutate({
                  organizationId,
                  acknowledgeCleanupFailure: cleanupFailed,
                })
              }
            >
              {removeMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              {cleanupFailed ? 'Remove without cleanup' : 'Remove credentials'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
