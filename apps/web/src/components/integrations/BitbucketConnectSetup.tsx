'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Key,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { BitbucketLogo } from '@/components/auth/BitbucketLogo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';

const CREATE_WORKSPACE_TOKEN_URL =
  'https://support.atlassian.com/bitbucket-cloud/docs/create-a-workspace-access-token/';
const BITBUCKET_CONNECT_RETURN_PATH = (organizationId: string) =>
  `/organizations/${organizationId}/integrations/bitbucket`;
const REQUIRED_PERMISSIONS = [
  'Account Read',
  'Repository Read',
  'Repository Write',
  'Pull request Read',
  'Webhooks Read and Write',
];

type BitbucketConnectSetupProps = {
  organizationId: string;
  canManage: boolean;
  statusRefetchFailed: boolean;
};

type RouterOutputs = inferRouterOutputs<RootRouter>;
type BitbucketStatus = RouterOutputs['organizations']['bitbucket']['getStatus'];
type BitbucketConnectResult = RouterOutputs['organizations']['bitbucket']['connect'];

export function buildConnectedWorkspaceAccessTokenStatus(
  result: BitbucketConnectResult,
  canManage: boolean
): BitbucketStatus {
  return {
    status: 'connected',
    recoveryAction: null,
    method: 'workspace_access_token',
    integrationId: result.integrationId,
    integrationStatus: 'active',
    workspace: result.workspace,
    invalidatedAt: null,
    invalidationReason: null,
    lastValidatedAt: result.validatedAt,
    unexpectedScopes: result.unexpectedScopes,
    repositoryCache: {
      status: 'uninitialized',
      repositories: [],
      syncedAt: null,
    },
    canManage,
  };
}

function CardHeaderContent() {
  return (
    <CardHeader>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <BitbucketLogo className="size-5" />
            Bitbucket Cloud
          </CardTitle>
          <CardDescription>
            Repository access for cloud agents and pull request workflows.
          </CardDescription>
        </div>
        <Badge variant="secondary" className="rounded-full">
          <XCircle />
          Not connected
        </Badge>
      </div>
    </CardHeader>
  );
}

export function BitbucketConnectSetup({
  organizationId,
  canManage,
  statusRefetchFailed,
}: BitbucketConnectSetupProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [accessToken, setAccessToken] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const mutationResetRef = useRef<() => void>(() => undefined);
  const statusInput = { organizationId };
  const statusQueryKey = trpc.organizations.bitbucket.getStatus.queryKey(statusInput);
  const repositoryQueryKey =
    trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey(statusInput);
  const oauthConnectHref = `/api/integrations/bitbucket/connect?organizationId=${encodeURIComponent(
    organizationId
  )}&returnTo=${encodeURIComponent(BITBUCKET_CONNECT_RETURN_PATH(organizationId))}`;

  const connectMutation = useMutation(
    trpc.organizations.bitbucket.connect.mutationOptions({
      gcTime: 0,
      onSuccess: result => {
        setConnectError(null);
        queryClient.setQueryData(
          statusQueryKey,
          buildConnectedWorkspaceAccessTokenStatus(result, canManage)
        );
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: statusQueryKey }),
          queryClient.invalidateQueries({ queryKey: repositoryQueryKey }),
        ]);
        toast.success('Bitbucket workspace connected');
      },
      onError: error => {
        setConnectError(error.message);
        toast.error("Couldn't connect the Bitbucket workspace", { description: error.message });
      },
      onSettled: () => {
        setAccessToken('');
        queueMicrotask(() => mutationResetRef.current());
      },
    })
  );
  mutationResetRef.current = connectMutation.reset;

  const handleConnect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;

    setConnectError(null);
    connectMutation.mutate({
      organizationId,
      accessToken,
    });
    setAccessToken('');
  };

  const clearError = () => setConnectError(null);

  return (
    <Card>
      <CardHeaderContent />
      <CardContent className="space-y-6">
        {statusRefetchFailed && (
          <Alert>
            <AlertCircle />
            <AlertTitle>Bitbucket status could not be refreshed</AlertTitle>
            <AlertDescription>
              Showing the last loaded integration status. Try again in a minute.
            </AlertDescription>
          </Alert>
        )}

        {!canManage ? (
          <Alert>
            <ShieldCheck />
            <AlertTitle>Bitbucket is not connected</AlertTitle>
            <AlertDescription>
              An organization owner or billing manager can connect a Bitbucket Premium workspace
              with a Workspace Access Token, or connect Bitbucket with OAuth.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="border-border space-y-2 rounded-lg border p-4">
              <h4 className="text-sm font-medium">What happens when you connect:</h4>
              <ul className="text-muted-foreground space-y-2 text-sm">
                <li className="flex gap-2">
                  <CheckCircle2
                    className="text-status-success-icon mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span>Access repositories in the connected Bitbucket workspace</span>
                </li>
                <li className="flex gap-2">
                  <CheckCircle2
                    className="text-status-success-icon mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span>Listen for pull request events through Bitbucket webhooks</span>
                </li>
                <li className="flex gap-2">
                  <CheckCircle2
                    className="text-status-success-icon mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span>Enable cloud agents to clone and work with selected repositories</span>
                </li>
              </ul>
            </div>

            <Tabs defaultValue="workspace-access-token" className="space-y-4">
              <TabsList
                aria-label="Bitbucket connection method"
                className="flex h-auto flex-col items-stretch justify-start gap-2 bg-transparent p-0 sm:flex-row"
              >
                <TabsTrigger
                  value="workspace-access-token"
                  className="border-input bg-input-background min-h-control-touch w-full gap-2 rounded-md border px-3 py-2 text-center leading-tight whitespace-normal data-[state=active]:border-border-strong data-[state=active]:bg-surface-selected data-[state=active]:shadow-none sm:h-8 sm:min-h-0 sm:w-auto"
                >
                  <Key className="size-4" />
                  Workspace Access Token
                </TabsTrigger>
                <TabsTrigger
                  value="oauth"
                  className="border-input bg-input-background min-h-control-touch w-full gap-2 rounded-md border px-3 py-2 data-[state=active]:border-border-strong data-[state=active]:bg-surface-selected data-[state=active]:shadow-none sm:h-8 sm:min-h-0 sm:w-auto"
                >
                  <GitBranch className="size-4" />
                  OAuth
                </TabsTrigger>
              </TabsList>

              <TabsContent value="workspace-access-token" className="mt-0 space-y-5">
                <section className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-muted-foreground type-body">
                      Bitbucket Premium is required. Create a token for the workspace you want this
                      Kilo organization to use. Kilo detects the workspace from the token.
                    </p>
                    <a
                      href={CREATE_WORKSPACE_TOKEN_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="text-link hover:text-link-hover inline-flex items-center gap-1 text-sm underline underline-offset-4"
                    >
                      Create a workspace access token in Bitbucket
                      <ExternalLink className="size-icon-sm" />
                    </a>
                  </div>
                  <div className="border-border space-y-2 rounded-lg border p-4">
                    <p className="text-sm font-medium">Required permissions</p>
                    <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                      {REQUIRED_PERMISSIONS.map(permission => (
                        <li key={permission}>{permission}</li>
                      ))}
                    </ul>
                  </div>
                </section>

                <form autoComplete="off" className="space-y-5" onSubmit={handleConnect}>
                  <div className="space-y-2">
                    <Label htmlFor="bitbucket-workspace-token">Workspace Access Token</Label>
                    <SecretTokenInput
                      id="bitbucket-workspace-token"
                      name="bitbucket-workspace-secret"
                      value={accessToken}
                      onChange={event => {
                        setAccessToken(event.target.value);
                        clearError();
                      }}
                      required
                      maxLength={8192}
                      className="h-control-touch sm:h-9"
                      aria-describedby="bitbucket-workspace-token-help"
                    />
                    <p
                      id="bitbucket-workspace-token-help"
                      className="text-muted-foreground text-xs"
                    >
                      Kilo encrypts this token and detects the connected Bitbucket workspace. The
                      token is never shown again after submission.
                    </p>
                  </div>

                  {connectError && (
                    <p className="text-status-destructive text-sm" role="alert">
                      {connectError}
                    </p>
                  )}
                  <Button
                    type="submit"
                    className="min-h-control-touch w-full sm:h-9 sm:min-h-0"
                    disabled={connectMutation.isPending || accessToken.length === 0}
                  >
                    {connectMutation.isPending ? 'Connecting workspace...' : 'Connect workspace'}
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="oauth" className="mt-0 space-y-4">
                <section className="space-y-3">
                  <Alert variant="warning">
                    <ShieldCheck />
                    <AlertDescription className="gap-2">
                      <p>Prefer Workspace Access Token. Use OAuth only when it is not available.</p>
                      <ul className="list-disc space-y-1 pl-5">
                        <li>
                          Authorize with a dedicated Bitbucket service bot account, not a regular
                          user account.
                        </li>
                        <li>This connection is shared with everyone in the organization.</li>
                      </ul>
                      <p>
                        After authorizing Bitbucket, choose the workspace this organization uses.
                      </p>
                    </AlertDescription>
                  </Alert>
                  <Button asChild className="min-h-control-touch w-full sm:h-9 sm:min-h-0">
                    <a href={oauthConnectHref}>
                      <GitBranch className="size-4" />
                      Connect with Bitbucket OAuth
                    </a>
                  </Button>
                </section>
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}
