'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTRPC } from '@/lib/trpc/utils';
import { getMcpGatewayRoutes } from '@/lib/mcp-gateway/routes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

type McpGatewaySetupContentProps = {
  organizationId?: string;
};

type SetupDraft = {
  name: string;
  remoteUrl: string;
  authMode: 'none' | 'static_headers' | 'oauth_dynamic' | 'oauth_static';
  sharingMode: 'single_user' | 'multi_user';
  initialAssignedUserId: string;
  providerIssuer: string;
  staticProviderClientId: string;
  staticProviderClientSecret: string;
  pathPassthrough: boolean;
};

function isAuthMode(value: string): value is SetupDraft['authMode'] {
  return ['none', 'static_headers', 'oauth_dynamic', 'oauth_static'].includes(value);
}

function isSharingMode(value: string): value is SetupDraft['sharingMode'] {
  return value === 'single_user' || value === 'multi_user';
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
    sharingMode: organizationId ? 'multi_user' : 'single_user',
    initialAssignedUserId: '',
    providerIssuer: '',
    staticProviderClientId: '',
    staticProviderClientSecret: '',
    pathPassthrough: false,
  });
  const discoveryMutation = useMutation(
    trpc.mcpGateway.discover.mutationOptions({
      onError: error =>
        toast.error(
          error.message ||
            "We couldn't discover that remote MCP server. Check the URL and try again."
        ),
    })
  );
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
  const defaultProvider =
    discovery?.providerCandidates.find(candidate => candidate.hasRegistrationEndpoint) ??
    discovery?.providerCandidates[0];
  const selectedProvider =
    discovery?.providerCandidates.find(candidate => candidate.issuer === draft.providerIssuer) ??
    defaultProvider;
  const selectedProviderIssuer = selectedProvider?.issuer ?? '';
  const dynamicAvailable = selectedProvider?.hasRegistrationEndpoint ?? false;
  const selectedAuthMode = useMemo(() => {
    if (draft.authMode === 'oauth_dynamic' && !dynamicAvailable && discovery) return 'oauth_static';
    return draft.authMode;
  }, [draft.authMode, discovery, dynamicAvailable]);

  function updateDraft(values: Partial<SetupDraft>) {
    setDraft(current => ({ ...current, ...values }));
  }

  function runDiscovery() {
    if (!draft.name || !draft.remoteUrl) {
      toast.error('Please enter a connection name and remote MCP URL.');
      return;
    }
    discoveryMutation.mutate({ remoteUrl: draft.remoteUrl });
  }

  function createConnection() {
    if (organizationId) {
      createOrganizationMutation.mutate({
        organizationId,
        name: draft.name,
        remoteUrl: draft.remoteUrl,
        authMode: selectedAuthMode,
        providerIssuer: selectedProviderIssuer || undefined,
        staticProviderClientId: draft.staticProviderClientId || undefined,
        staticProviderClientSecret: draft.staticProviderClientSecret || undefined,
        sharingMode: draft.sharingMode,
        initialAssignedUserId:
          draft.sharingMode === 'single_user'
            ? draft.initialAssignedUserId || undefined
            : undefined,
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
      pathPassthrough: draft.pathPassthrough,
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <Link
          href={routes.list}
          className="text-muted-foreground inline-flex items-center gap-2 text-sm hover:text-foreground"
        >
          <ArrowLeft />
          Back to connections
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Create connection</h1>
        <p className="text-muted-foreground text-sm">
          Connect Kilo Code to a remote MCP server. We check the remote server before asking for
          provider sign-in details.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Step {step} of 3</CardTitle>
          <CardDescription>
            {step === 1 && 'Connection details'}
            {step === 2 && 'Remote discovery'}
            {step === 3 && 'Access and credentials'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="connection-name">Connection name</Label>
                <Input
                  id="connection-name"
                  value={draft.name}
                  onChange={event => updateDraft({ name: event.target.value })}
                  placeholder="Production tools"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="remote-url">Remote MCP URL</Label>
                <Input
                  id="remote-url"
                  type="url"
                  value={draft.remoteUrl}
                  onChange={event => {
                    discoveryMutation.reset();
                    updateDraft({ remoteUrl: event.target.value, providerIssuer: '' });
                  }}
                  placeholder="https://mcp.example.com"
                />
                <p className="text-muted-foreground text-xs">
                  The server must be publicly reachable over HTTPS.
                </p>
              </div>
              {organizationId && (
                <div className="space-y-2">
                  <Label htmlFor="sharing-mode">Sharing mode</Label>
                  <Select
                    value={draft.sharingMode}
                    onValueChange={value => {
                      if (isSharingMode(value)) updateDraft({ sharingMode: value });
                    }}
                  >
                    <SelectTrigger id="sharing-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="multi_user">Shared endpoint</SelectItem>
                      <SelectItem value="single_user">Single user</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {organizationId && draft.sharingMode === 'single_user' && (
                <div className="space-y-2">
                  <Label htmlFor="initial-user">Initial assigned user ID</Label>
                  <Input
                    id="initial-user"
                    value={draft.initialAssignedUserId}
                    onChange={event => updateDraft({ initialAssignedUserId: event.target.value })}
                    placeholder="User ID"
                  />
                </div>
              )}
              <label className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={draft.pathPassthrough}
                  onCheckedChange={checked => updateDraft({ pathPassthrough: checked === true })}
                />
                Allow descendant paths from the remote MCP server
              </label>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <div className="rounded-lg border p-4">
                <p className="text-sm font-medium">{draft.remoteUrl || 'Remote MCP URL not set'}</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Discovery checks the remote server and provider metadata.
                </p>
              </div>
              {discovery && (
                <div className="space-y-3 text-sm">
                  <div className="flex items-center justify-between border-b pb-2">
                    <span className="text-muted-foreground">Provider discovery</span>
                    <span>{discovery.providerCandidates.length > 0 ? 'Found' : 'Not found'}</span>
                  </div>
                  <div className="flex items-center justify-between border-b pb-2">
                    <span className="text-muted-foreground">Dynamic registration</span>
                    <span>{dynamicAvailable ? 'Available' : 'Not available'}</span>
                  </div>
                  {discovery.providerCandidates.length > 1 && (
                    <div className="space-y-2">
                      <Label htmlFor="provider-issuer">Provider</Label>
                      <Select
                        value={selectedProviderIssuer}
                        onValueChange={value => updateDraft({ providerIssuer: value })}
                      >
                        <SelectTrigger id="provider-issuer" className="w-full">
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
                    </div>
                  )}
                  {!dynamicAvailable && (
                    <p className="text-muted-foreground text-xs">
                      This provider does not advertise automatic registration. Add manual provider
                      credentials before creating the connection.
                    </p>
                  )}
                </div>
              )}
              {!discovery && (
                <p className="text-muted-foreground text-sm">Run discovery to continue.</p>
              )}
            </div>
          )}
          {step === 3 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="auth-mode">Provider sign-in</Label>
                <Select
                  value={selectedAuthMode}
                  onValueChange={value => {
                    if (isAuthMode(value)) updateDraft({ authMode: value });
                  }}
                >
                  <SelectTrigger id="auth-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oauth_dynamic" disabled={!dynamicAvailable}>
                      Automatic provider sign-in
                    </SelectItem>
                    <SelectItem value="oauth_static">Manual provider credentials</SelectItem>
                    <SelectItem value="static_headers">Static headers</SelectItem>
                    <SelectItem value="none">No provider sign-in</SelectItem>
                  </SelectContent>
                </Select>
                {selectedAuthMode === 'oauth_static' && (
                  <div className="space-y-2">
                    <p className="text-muted-foreground text-xs">
                      Stored provider credentials are not shown again after saving.
                    </p>
                    <SecretTokenInput
                      value={draft.staticProviderClientId}
                      onChange={event =>
                        updateDraft({ staticProviderClientId: event.target.value })
                      }
                      placeholder="Provider client ID"
                      aria-label="Provider client ID"
                      toggleLabel="Show provider client ID"
                    />
                    <SecretTokenInput
                      value={draft.staticProviderClientSecret}
                      onChange={event =>
                        updateDraft({ staticProviderClientSecret: event.target.value })
                      }
                      placeholder="Provider client secret"
                      aria-label="Provider client secret"
                      toggleLabel="Show provider client secret"
                    />
                  </div>
                )}
              </div>
              <div className="rounded-lg border p-4 text-sm">
                <p className="font-medium">Review</p>
                <dl className="mt-3 space-y-2 text-muted-foreground">
                  <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-4">
                    <dt>Name</dt>
                    <dd className="text-foreground">{draft.name}</dd>
                  </div>
                  <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-4">
                    <dt>Remote server</dt>
                    <dd className="min-w-0 break-all text-foreground">{draft.remoteUrl}</dd>
                  </div>
                  <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-4">
                    <dt>Provider sign-in</dt>
                    <dd className="text-foreground">{selectedAuthMode.replaceAll('_', ' ')}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-3 border-t pt-4">
            <Button
              variant="outline"
              onClick={() => setStep(current => Math.max(1, current - 1))}
              disabled={step === 1}
            >
              Back
            </Button>
            <div className="flex gap-2">
              {step === 2 && (
                <Button
                  variant="outline"
                  onClick={runDiscovery}
                  disabled={discoveryMutation.isPending}
                >
                  Run discovery
                </Button>
              )}
              {step < 3 && (
                <Button
                  onClick={() => setStep(current => Math.min(3, current + 1))}
                  disabled={step === 2 && !discovery}
                >
                  <ArrowRight />
                  Continue
                </Button>
              )}
              {step === 3 && (
                <Button
                  onClick={createConnection}
                  disabled={
                    createPersonalMutation.isPending ||
                    createOrganizationMutation.isPending ||
                    (selectedAuthMode === 'oauth_static' &&
                      (!draft.staticProviderClientId || !draft.staticProviderClientSecret))
                  }
                >
                  <Check />
                  Create connection
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
