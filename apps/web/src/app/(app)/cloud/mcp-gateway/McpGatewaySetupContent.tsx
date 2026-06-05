'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTRPC } from '@/lib/trpc/utils';
import { getMcpGatewayRoutes } from '@/lib/mcp-gateway/routes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { ArrowLeft, ArrowRight, Check, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

type McpGatewaySetupContentProps = {
  organizationId?: string;
};

type SetupDraft = {
  name: string;
  remoteUrl: string;
  authMode: 'none' | 'static_headers' | 'oauth_dynamic' | 'oauth_static';
  providerIssuer: string;
  providerScopes: string;
  staticProviderClientId: string;
  staticProviderClientSecret: string;
  staticHeaderName: string;
  staticHeaderValue: string;
  pathPassthrough: boolean;
};

const STEPS = [
  { id: 1, label: 'Server' },
  { id: 2, label: 'Access' },
] as const;

const DISCOVERY_DEBOUNCE_MS = 600;

function isAuthMode(value: string): value is SetupDraft['authMode'] {
  return ['none', 'static_headers', 'oauth_dynamic', 'oauth_static'].includes(value);
}

function authModeLabel(authMode: SetupDraft['authMode']) {
  switch (authMode) {
    case 'oauth_dynamic':
      return 'Automatic provider sign-in';
    case 'oauth_static':
      return 'Manual provider credentials';
    case 'static_headers':
      return 'Static headers';
    case 'none':
      return 'No provider sign-in';
  }
}

function hostOf(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-3" aria-label="Setup progress">
      {STEPS.map((step, index) => {
        const isDone = current > step.id;
        const isCurrent = current === step.id;
        return (
          <li
            key={step.id}
            aria-current={isCurrent ? 'step' : undefined}
            className="flex items-center gap-3"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  'flex size-6 items-center justify-center rounded-full border text-xs font-medium tabular-nums transition-colors',
                  isDone && 'border-foreground/30 text-muted-foreground',
                  isCurrent && 'border-foreground bg-foreground text-background',
                  !isDone && !isCurrent && 'border-border text-muted-foreground'
                )}
              >
                {isDone ? <Check className="size-3.5" /> : step.id}
              </span>
              <span
                className={cn(
                  'text-sm transition-colors',
                  isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground'
                )}
              >
                <span className="sr-only">Step {step.id} of 2: </span>
                {step.label}
                <span className="sr-only">
                  {isCurrent ? ', current step' : isDone ? ', completed' : ', not started'}
                </span>
              </span>
            </div>
            {index < STEPS.length - 1 && (
              <span aria-hidden className="bg-border h-px w-8 sm:w-12" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function McpGatewaySetupContent({ organizationId }: McpGatewaySetupContentProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const routes = getMcpGatewayRoutes(organizationId);
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<SetupDraft>({
    name: '',
    remoteUrl: '',
    authMode: 'oauth_dynamic',
    providerIssuer: '',
    providerScopes: '',
    staticProviderClientId: '',
    staticProviderClientSecret: '',
    staticHeaderName: 'Authorization',
    staticHeaderValue: '',
    pathPassthrough: false,
  });
  const [discoveryAttemptedUrl, setDiscoveryAttemptedUrl] = useState<string | null>(null);
  const discoveryMutation = useMutation(trpc.mcpGateway.discover.mutationOptions());
  const createPersonalMutation = useMutation(
    trpc.mcpGateway.createPersonal.mutationOptions({
      onSuccess: data => {
        toast.success('Connection created');
        router.push(routes.detail(data.configId));
      },
      onError: error =>
        toast.error(
          error.message || "We couldn't create the connection. Check the details and try again."
        ),
    })
  );
  const createOrganizationMutation = useMutation(
    trpc.mcpGateway.createOrganization.mutationOptions({
      onSuccess: data => {
        toast.success('Connection created');
        router.push(routes.detail(data.configId));
      },
      onError: error =>
        toast.error(
          error.message || "We couldn't create the connection. Check the details and try again."
        ),
    })
  );

  const currentRemoteUrl = (() => {
    try {
      return new URL(draft.remoteUrl).toString();
    } catch {
      return null;
    }
  })();
  const discovery =
    discoveryMutation.data && discoveryMutation.data.remoteUrl === currentRemoteUrl
      ? discoveryMutation.data
      : undefined;
  const discoveryPendingForCurrent =
    discoveryMutation.isPending && discoveryAttemptedUrl === currentRemoteUrl;
  const discoveryFailedForCurrent =
    discoveryMutation.isError && discoveryAttemptedUrl === currentRemoteUrl;
  const defaultProvider =
    discovery?.providerCandidates.find(candidate => candidate.hasRegistrationEndpoint) ??
    discovery?.providerCandidates[0];
  const hasProvider = (discovery?.providerCandidates.length ?? 0) > 0;
  const selectedProvider =
    discovery?.providerCandidates.find(candidate => candidate.issuer === draft.providerIssuer) ??
    defaultProvider;
  const selectedProviderIssuer = selectedProvider?.issuer ?? '';
  const dynamicAvailable = selectedProvider?.hasRegistrationEndpoint ?? false;
  const discoveredProviderScopes = discovery?.providerScopes?.join(' ') ?? '';
  const selectedAuthMode = useMemo(() => {
    if (!discovery) return draft.authMode;
    if (!hasProvider && (draft.authMode === 'oauth_dynamic' || draft.authMode === 'oauth_static')) {
      return 'static_headers';
    }
    if (draft.authMode === 'oauth_dynamic' && !dynamicAvailable) return 'oauth_static';
    return draft.authMode;
  }, [draft.authMode, discovery, dynamicAvailable, hasProvider]);

  function updateDraft(values: Partial<SetupDraft>) {
    setDraft(current => ({ ...current, ...values }));
  }

  function runDiscovery(remoteUrl: string) {
    setDiscoveryAttemptedUrl(remoteUrl);
    discoveryMutation.mutate({ remoteUrl });
  }

  // Auto-probe a valid URL shortly after the user stops typing. Triggering
  // discovery (onBlur / Re-check) sets discoveryAttemptedUrl, which makes this
  // effect re-run, hit the early return, and cancel the pending debounce.
  useEffect(() => {
    if (!discoveredProviderScopes || draft.providerScopes) return;
    updateDraft({ providerScopes: discoveredProviderScopes });
  }, [discoveredProviderScopes, draft.providerScopes]);

  useEffect(() => {
    if (!currentRemoteUrl) return;
    if (discovery || discoveryAttemptedUrl === currentRemoteUrl) return;
    const handle = setTimeout(() => {
      setDiscoveryAttemptedUrl(currentRemoteUrl);
      discoveryMutation.mutate({ remoteUrl: currentRemoteUrl });
    }, DISCOVERY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [currentRemoteUrl, discovery, discoveryAttemptedUrl, discoveryMutation]);

  function checkNow() {
    if (!currentRemoteUrl) {
      toast.error('Enter a valid HTTPS MCP URL first.');
      return;
    }
    runDiscovery(currentRemoteUrl);
  }

  const canLeaveServerStep = Boolean(draft.name.trim() && currentRemoteUrl && discovery);
  const credentialsIncomplete =
    selectedAuthMode === 'oauth_static' &&
    (!selectedProviderIssuer || !draft.staticProviderClientId || !draft.staticProviderClientSecret);
  const staticHeaderIncomplete =
    selectedAuthMode === 'static_headers' &&
    (draft.staticHeaderName.trim().length === 0 || draft.staticHeaderValue.trim().length === 0);
  const accessIncomplete = credentialsIncomplete || staticHeaderIncomplete;
  const isCreating = createPersonalMutation.isPending || createOrganizationMutation.isPending;

  const staticHeaders =
    selectedAuthMode === 'static_headers' &&
    draft.staticHeaderName.trim() &&
    draft.staticHeaderValue.trim()
      ? { [draft.staticHeaderName.trim()]: draft.staticHeaderValue }
      : undefined;
  const providerScopes = draft.providerScopes.trim()
    ? draft.providerScopes.trim().split(/\s+/)
    : undefined;

  function createConnection() {
    if (organizationId) {
      createOrganizationMutation.mutate({
        organizationId,
        name: draft.name,
        remoteUrl: draft.remoteUrl,
        authMode: selectedAuthMode,
        providerIssuer: selectedProviderIssuer || undefined,
        providerScopes,
        staticProviderClientId: draft.staticProviderClientId || undefined,
        staticProviderClientSecret: draft.staticProviderClientSecret || undefined,
        staticHeaders,
        sharingMode: 'multi_user',
        pathPassthrough: draft.pathPassthrough,
      });
      return;
    }
    createPersonalMutation.mutate({
      name: draft.name,
      remoteUrl: draft.remoteUrl,
      authMode: selectedAuthMode,
      providerIssuer: selectedProviderIssuer || undefined,
      staticProviderClientId: draft.staticProviderClientId || undefined,
      staticProviderClientSecret: draft.staticProviderClientSecret || undefined,
      staticHeaders,
      pathPassthrough: draft.pathPassthrough,
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (step === 1) {
      if (canLeaveServerStep) setStep(2);
      return;
    }
    if (!accessIncomplete && !isCreating) createConnection();
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="space-y-1.5">
        <Link
          href={routes.list}
          className="text-muted-foreground inline-flex min-h-11 items-center gap-2 text-sm hover:text-foreground sm:min-h-0"
        >
          <ArrowLeft className="size-4" />
          Back to connections
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Create connection</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Connect Kilo Code to a remote MCP server and choose how it signs in.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b pb-4">
          <Stepper current={step} />
        </CardHeader>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-6" noValidate>
            {step === 1 && (
              <div
                key="step-server"
                className="max-w-3xl space-y-5 motion-safe:animate-in motion-safe:fade-in-0"
              >
                <div className="space-y-2">
                  <Label htmlFor="remote-url">Remote MCP URL</Label>
                  <Input
                    id="remote-url"
                    type="url"
                    inputMode="url"
                    autoFocus
                    className="h-11 sm:h-9"
                    value={draft.remoteUrl}
                    onChange={event => {
                      discoveryMutation.reset();
                      setDiscoveryAttemptedUrl(null);
                      updateDraft({
                        remoteUrl: event.target.value,
                        providerIssuer: '',
                        providerScopes: '',
                      });
                    }}
                    onBlur={() => {
                      if (currentRemoteUrl && discoveryAttemptedUrl !== currentRemoteUrl) {
                        runDiscovery(currentRemoteUrl);
                      }
                    }}
                    placeholder="https://mcp.example.com/mcp"
                    aria-describedby="remote-url-hint"
                  />
                  <p id="remote-url-hint" className="text-muted-foreground text-xs">
                    Public HTTPS endpoint. We check it automatically and detect how it signs in.
                  </p>
                  <DiscoveryStatus
                    hasUrl={Boolean(currentRemoteUrl)}
                    host={currentRemoteUrl ? hostOf(currentRemoteUrl) : ''}
                    pending={discoveryPendingForCurrent}
                    failed={discoveryFailedForCurrent}
                    errorMessage={discoveryMutation.error?.message}
                    providerCount={discovery?.providerCandidates.length ?? null}
                    dynamicAvailable={dynamicAvailable}
                    providerHost={selectedProviderIssuer ? hostOf(selectedProviderIssuer) : ''}
                    onRetry={checkNow}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="connection-name">Connection name</Label>
                  <Input
                    id="connection-name"
                    className="h-11 sm:h-9"
                    value={draft.name}
                    onChange={event => updateDraft({ name: event.target.value })}
                    placeholder="Production tools"
                    aria-describedby="connection-name-hint"
                  />
                  <p id="connection-name-hint" className="text-muted-foreground text-xs">
                    Shown in the connections list and to teammates who use it.
                  </p>
                </div>

                {organizationId && (
                  <p className="text-muted-foreground text-xs">
                    Assign teammates after the connection is created. How each one authenticates
                    depends on the sign-in method you choose next.
                  </p>
                )}

                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <Checkbox
                    className="mt-1"
                    checked={draft.pathPassthrough}
                    onCheckedChange={checked => updateDraft({ pathPassthrough: checked === true })}
                  />
                  <span className="space-y-1">
                    <span className="block font-medium">Allow descendant paths</span>
                    <span className="text-muted-foreground block">
                      Forward requests to paths beneath this URL, not just the exact endpoint.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {step === 2 && (
              <div
                key="step-access"
                className="max-w-3xl space-y-5 motion-safe:animate-in motion-safe:fade-in-0"
              >
                {discovery && discovery.providerCandidates.length > 1 && (
                  <div className="space-y-2">
                    <Label htmlFor="provider-issuer">Provider</Label>
                    <Select
                      value={selectedProviderIssuer}
                      onValueChange={value => updateDraft({ providerIssuer: value })}
                    >
                      <SelectTrigger id="provider-issuer" className="h-11 w-full sm:h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {discovery.providerCandidates.map(candidate => (
                          <SelectItem key={candidate.issuer} value={candidate.issuer}>
                            {candidate.issuer}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">
                      {hostOf(currentRemoteUrl ?? '')} advertises more than one sign-in provider.
                    </p>
                  </div>
                )}

                {(selectedAuthMode === 'oauth_dynamic' || selectedAuthMode === 'oauth_static') && (
                  <div className="space-y-2">
                    <Label htmlFor="provider-scopes">Provider scopes</Label>
                    <Input
                      id="provider-scopes"
                      className="h-11 sm:h-9"
                      value={draft.providerScopes}
                      onChange={event => updateDraft({ providerScopes: event.target.value })}
                      placeholder="openid email"
                    />
                    <p className="text-muted-foreground text-xs">
                      Optional upstream provider scopes. Leave blank when the server does not
                      advertise a required scope set.
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="auth-mode">Provider sign-in</Label>
                  <Select
                    value={selectedAuthMode}
                    onValueChange={value => {
                      if (isAuthMode(value)) updateDraft({ authMode: value });
                    }}
                  >
                    <SelectTrigger
                      id="auth-mode"
                      aria-describedby={
                        discovery && (!hasProvider || (hasProvider && !dynamicAvailable))
                          ? 'auth-mode-hint'
                          : undefined
                      }
                      className="h-11 w-full sm:h-9"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="oauth_dynamic" disabled={!dynamicAvailable}>
                        Automatic provider sign-in
                      </SelectItem>
                      <SelectItem value="oauth_static" disabled={!hasProvider}>
                        Manual provider credentials
                      </SelectItem>
                      <SelectItem value="static_headers">Static headers</SelectItem>
                      <SelectItem value="none">No provider sign-in</SelectItem>
                    </SelectContent>
                  </Select>
                  {discovery && !hasProvider && (
                    <p id="auth-mode-hint" className="text-muted-foreground text-xs">
                      This server did not advertise an OAuth provider, so use static headers or no
                      provider sign-in.
                    </p>
                  )}
                  {discovery && hasProvider && !dynamicAvailable && (
                    <p id="auth-mode-hint" className="text-muted-foreground text-xs">
                      Automatic provider sign-in is unavailable because this provider does not
                      advertise dynamic registration.
                    </p>
                  )}
                  {selectedAuthMode === 'oauth_dynamic' && (
                    <p className="text-muted-foreground text-xs">
                      {selectedProviderIssuer
                        ? `${hostOf(selectedProviderIssuer)} registers Kilo Code automatically. ${
                            organizationId
                              ? 'Each assigned user signs in with their own provider account after the connection is created.'
                              : 'You sign in with your provider account after the connection is created.'
                          }`
                        : organizationId
                          ? 'The server registers Kilo Code automatically. Each assigned user signs in with their own provider account after the connection is created.'
                          : 'The server registers Kilo Code automatically. You sign in with your provider account after the connection is created.'}
                    </p>
                  )}
                  {selectedAuthMode === 'oauth_static' && (
                    <div className="space-y-2 pt-1">
                      <p className="text-muted-foreground text-xs">
                        {dynamicAvailable
                          ? organizationId
                            ? 'Use a provider app you registered yourself. Each assigned user still signs in with their own account.'
                            : 'Use a provider app you registered yourself. You still sign in with your own account.'
                          : organizationId
                            ? "This server doesn't advertise automatic registration, so register a provider app and add its credentials here. Each assigned user still signs in with their own account."
                            : "This server doesn't advertise automatic registration, so register a provider app and add its credentials here. You still sign in with your own account."}{' '}
                        Credentials are encrypted and not shown again after saving.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="static-provider-client-id">Provider client ID</Label>
                          <SecretTokenInput
                            id="static-provider-client-id"
                            className="h-11 sm:h-9"
                            value={draft.staticProviderClientId}
                            onChange={event =>
                              updateDraft({ staticProviderClientId: event.target.value })
                            }
                            placeholder="Client ID"
                            toggleLabel="Show provider client ID"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="static-provider-client-secret">
                            Provider client secret
                          </Label>
                          <SecretTokenInput
                            id="static-provider-client-secret"
                            className="h-11 sm:h-9"
                            value={draft.staticProviderClientSecret}
                            onChange={event =>
                              updateDraft({ staticProviderClientSecret: event.target.value })
                            }
                            placeholder="Client secret"
                            toggleLabel="Show provider client secret"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                  {selectedAuthMode === 'static_headers' && (
                    <div className="space-y-2 pt-1">
                      <p className="text-muted-foreground text-xs">
                        {organizationId
                          ? 'Sent on every upstream request and shared by all assigned users.'
                          : 'Sent on every upstream request.'}{' '}
                        Encrypted and not shown again after saving.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="static-header-name">Header name</Label>
                          <Input
                            id="static-header-name"
                            className="h-11 sm:h-9"
                            value={draft.staticHeaderName}
                            onChange={event =>
                              updateDraft({ staticHeaderName: event.target.value })
                            }
                            placeholder="Authorization"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="static-header-value">Header value</Label>
                          <SecretTokenInput
                            id="static-header-value"
                            className="h-11 sm:h-9"
                            value={draft.staticHeaderValue}
                            onChange={event =>
                              updateDraft({ staticHeaderValue: event.target.value })
                            }
                            placeholder="Header value"
                            toggleLabel="Show header value"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                  {selectedAuthMode === 'none' && (
                    <p className="text-muted-foreground text-xs">
                      Kilo Code forwards requests without any credentials. Nobody signs in.
                    </p>
                  )}
                </div>

                <dl className="rounded-lg border text-sm">
                  <ReviewRow label="Name" value={draft.name} />
                  <ReviewRow label="Remote server" value={draft.remoteUrl} mono />
                  <ReviewRow label="Provider sign-in" value={authModeLabel(selectedAuthMode)} />
                  {organizationId && (
                    <ReviewRow label="Org access" value="Assign members later" last />
                  )}
                  {!organizationId && <ReviewRow label="Owner" value="Personal" last />}
                </dl>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t pt-5">
              {step === 1 ? (
                <Button variant="ghost" type="button" className="h-11 sm:h-9" asChild>
                  <Link href={routes.list}>Cancel</Link>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  type="button"
                  className="h-11 sm:h-9"
                  onClick={() => setStep(1)}
                >
                  <ArrowLeft className="size-4" />
                  Back
                </Button>
              )}
              {step === 1 ? (
                <Button type="submit" className="h-11 sm:h-9" disabled={!canLeaveServerStep}>
                  Continue
                  <ArrowRight className="size-4" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  className="h-11 sm:h-9"
                  disabled={accessIncomplete || isCreating}
                >
                  <Check className="size-4" />
                  {isCreating ? 'Creating...' : 'Create connection'}
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewRow({
  label,
  value,
  mono,
  last,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4',
        !last && 'border-b'
      )}
    >
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('text-foreground min-w-0 break-words', mono && 'font-mono text-xs')}>
        {value || <span className="text-muted-foreground">Not set</span>}
      </dd>
    </div>
  );
}

function DiscoveryStatus({
  hasUrl,
  host,
  pending,
  failed,
  errorMessage,
  providerCount,
  dynamicAvailable,
  providerHost,
  onRetry,
}: {
  hasUrl: boolean;
  host: string;
  pending: boolean;
  failed: boolean;
  errorMessage?: string;
  providerCount: number | null;
  dynamicAvailable: boolean;
  providerHost: string;
  onRetry: () => void;
}) {
  if (!hasUrl) return null;

  if (pending) {
    return (
      <div className="rounded-lg border p-4" aria-live="polite">
        <p className="text-muted-foreground mb-3 text-xs">Checking {host}...</p>
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
    );
  }

  if (failed) {
    return (
      <div
        className="border-destructive/30 bg-destructive/5 rounded-lg border p-4"
        aria-live="polite"
      >
        <div className="flex items-start gap-2">
          <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
          <div className="space-y-2">
            <p className="text-foreground text-sm font-medium">Couldn't reach {host}</p>
            <p className="text-muted-foreground text-xs">
              {errorMessage || 'Check that the server uses public HTTPS, then try again.'}
            </p>
            <Button variant="outline" size="sm" type="button" onClick={onRetry}>
              <RotateCcw className="size-4" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (providerCount === null) return null;

  const hasProvider = providerCount > 0;
  return (
    <div className="rounded-lg border p-4" aria-live="polite">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-foreground flex min-w-0 items-center gap-2 text-sm font-medium">
          <ShieldCheck className="size-4 shrink-0 text-green-400" />
          <span className="min-w-0 break-all">{host} is reachable</span>
        </p>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={onRetry}
          className="text-muted-foreground hover:text-foreground -mr-2 shrink-0"
        >
          <RotateCcw className="size-4" />
          Re-check
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hasProvider ? (
          <>
            <Badge variant="secondary">
              {providerCount > 1 ? `${providerCount} sign-in providers` : 'Sign-in provider found'}
            </Badge>
            <Badge variant={dynamicAvailable ? 'secondary' : 'outline'}>
              {dynamicAvailable ? 'Automatic sign-in' : 'Manual credentials'}
            </Badge>
            {providerHost && (
              <span className="text-muted-foreground font-mono text-xs">{providerHost}</span>
            )}
          </>
        ) : (
          <Badge variant="outline">No OAuth provider advertised</Badge>
        )}
      </div>
      {!hasProvider && (
        <p className="text-muted-foreground mt-2 text-xs">
          Choose static headers or no sign-in on the next step.
        </p>
      )}
    </div>
  );
}
