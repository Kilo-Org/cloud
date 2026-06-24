'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import type { RootRouter } from '@/routers/root-router';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import { useTRPC } from '@/lib/trpc/utils';
import { buildConnectedWorkspaceAccessTokenStatus } from './BitbucketConnectSetup';

const REVOKE_WORKSPACE_TOKEN_URL =
  'https://support.atlassian.com/bitbucket-cloud/docs/revoke-a-workspace-access-token/';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type BitbucketStatus = RouterOutputs['organizations']['bitbucket']['getStatus'];
type RecoveryAction = 'replace_token' | 'disconnect_and_connect' | null;

type BitbucketIntegrationControlsProps = {
  organizationId: string;
  status: BitbucketStatus;
};

export function getBitbucketIntegrationControlsDescription(
  method: BitbucketStatus['method'],
  recoveryAction: RecoveryAction
): string | null {
  if (method === 'oauth') return null;
  if (recoveryAction === 'disconnect_and_connect') {
    return 'Disconnect this integration, then connect the workspace again with a new Workspace Access Token.';
  }
  return 'Replace the credential without changing the connected workspace, or disconnect the integration from Kilo.';
}

function ReplaceTokenDialog({
  organizationId,
  integrationId,
  workspaceSlug,
  available,
}: {
  organizationId: string;
  integrationId: string;
  workspaceSlug: string | null;
  available: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutationResetRef = useRef<() => void>(() => undefined);
  const statusInput = { organizationId };
  const statusQueryKey = trpc.organizations.bitbucket.getStatus.queryKey(statusInput);
  const repositoryQueryKey =
    trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey(statusInput);
  const mutation = useMutation(
    trpc.organizations.bitbucket.replaceToken.mutationOptions({
      gcTime: 0,
      onSuccess: result => {
        setToken('');
        setError(null);
        setOpen(false);
        queryClient.setQueryData<BitbucketStatus>(statusQueryKey, current =>
          current ? buildConnectedWorkspaceAccessTokenStatus(result, current.canManage) : current
        );
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: statusQueryKey }),
          queryClient.invalidateQueries({ queryKey: repositoryQueryKey }),
        ]);
        toast.success('Bitbucket token replaced');
      },
      onError: mutationError => {
        setError(mutationError.message);
        toast.error("Couldn't replace the Bitbucket token", {
          description: mutationError.message,
        });
      },
      onSettled: () => {
        setToken('');
        queueMicrotask(() => mutationResetRef.current());
      },
    })
  );
  mutationResetRef.current = mutation.reset;

  useEffect(() => {
    if (available || !open || mutation.isPending) return;
    setOpen(false);
    setToken('');
    setError(null);
    mutation.reset();
  }, [available, mutation.isPending, mutation.reset, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (mutation.isPending) return;
    setOpen(nextOpen);
    setToken('');
    setError(null);
    mutation.reset();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;

    setError(null);
    mutation.mutate({ organizationId, integrationId, accessToken: token });
    setToken('');
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {available && (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="min-h-control-touch w-full sm:h-9 sm:min-h-0 sm:w-auto"
          >
            Replace token
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        showCloseButton={!mutation.isPending}
        onEscapeKeyDown={event => mutation.isPending && event.preventDefault()}
        onPointerDownOutside={event => mutation.isPending && event.preventDefault()}
        onInteractOutside={event => mutation.isPending && event.preventDefault()}
      >
        <form autoComplete="off" className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Replace Workspace Access Token</DialogTitle>
            <DialogDescription>
              The workspace stays fixed. Kilo detects the workspace from the new token, validates
              that it matches, then encrypts the replacement.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="bitbucket-fixed-workspace">Workspace</Label>
            <Input
              id="bitbucket-fixed-workspace"
              value={workspaceSlug ?? 'Current connected workspace'}
              readOnly
              className="h-control-touch sm:h-9"
              aria-describedby="bitbucket-fixed-workspace-help"
            />
            <p id="bitbucket-fixed-workspace-help" className="text-muted-foreground text-xs">
              Disconnect Bitbucket to use a different workspace.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bitbucket-replacement-token">New Workspace Access Token</Label>
            <SecretTokenInput
              id="bitbucket-replacement-token"
              name="bitbucket-replacement-secret"
              value={token}
              onChange={event => {
                setToken(event.target.value);
                setError(null);
              }}
              required
              maxLength={8192}
              className="h-control-touch sm:h-9"
              aria-describedby="bitbucket-replacement-token-help"
            />
            <p id="bitbucket-replacement-token-help" className="text-muted-foreground text-xs">
              Kilo encrypts this token. It is never shown again after submission.
            </p>
          </div>

          {error && (
            <p className="text-status-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                className="min-h-control-touch sm:h-9 sm:min-h-0"
                disabled={mutation.isPending}
              >
                Keep current token
              </Button>
            </DialogClose>
            <Button
              type="submit"
              className="min-h-control-touch sm:h-9 sm:min-h-0"
              disabled={mutation.isPending || token.length === 0}
            >
              {mutation.isPending ? 'Replacing token...' : 'Replace token'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DisconnectDialog({
  organizationId,
  integrationId,
  method,
}: {
  organizationId: string;
  integrationId: string;
  method: BitbucketStatus['method'];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusInput = { organizationId };
  const statusQueryKey = trpc.organizations.bitbucket.getStatus.queryKey(statusInput);
  const repositoryQueryKey =
    trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey(statusInput);
  const mutation = useMutation(trpc.organizations.bitbucket.disconnect.mutationOptions());

  const handleOpenChange = (nextOpen: boolean) => {
    if (mutation.isPending) return;
    setOpen(nextOpen);
    setError(null);
    mutation.reset();
  };

  const handleDisconnect = () => {
    setError(null);
    mutation.mutate(
      { organizationId, integrationId },
      {
        onSuccess: () => {
          queryClient.setQueryData(repositoryQueryKey, { status: 'not_connected' });
          setOpen(false);
          setError(null);
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: statusQueryKey }),
            queryClient.invalidateQueries({ queryKey: repositoryQueryKey }),
          ]);
          toast.success('Bitbucket disconnected from Kilo');
        },
        onError: mutationError => {
          setError(mutationError.message);
          toast.error("Couldn't disconnect Bitbucket", { description: mutationError.message });
        },
        onSettled: () => queueMicrotask(() => mutation.reset()),
      }
    );
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          className="min-h-control-touch w-full sm:h-9 sm:min-h-0 sm:w-auto"
        >
          Disconnect Bitbucket
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onEscapeKeyDown={event => mutation.isPending && event.preventDefault()}
        onPointerDownOutside={event => mutation.isPending && event.preventDefault()}
        onInteractOutside={event => mutation.isPending && event.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect Bitbucket?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <span className="block">
              {method === 'oauth'
                ? "Disconnecting deletes Kilo's local OAuth credential and repository cache. It does not revoke Kilo's OAuth access in Bitbucket."
                : "Disconnecting deletes Kilo's local encrypted credential and repository cache. It does not revoke the Workspace Access Token in Bitbucket."}
            </span>
            {method === 'workspace_access_token' && (
              <a
                href={REVOKE_WORKSPACE_TOKEN_URL}
                target="_blank"
                rel="noreferrer"
                className="text-link hover:text-link-hover inline-flex items-center gap-1 underline underline-offset-4"
              >
                Revoke the workspace token in Bitbucket
                <ExternalLink className="size-icon-sm" />
              </a>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-status-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel
            className="min-h-control-touch sm:h-9 sm:min-h-0"
            disabled={mutation.isPending}
          >
            Keep Bitbucket connected
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant="destructive"
            className="min-h-control-touch sm:h-9 sm:min-h-0"
            disabled={mutation.isPending}
            onClick={event => {
              event.preventDefault();
              handleDisconnect();
            }}
          >
            {mutation.isPending ? 'Disconnecting Bitbucket...' : 'Disconnect Bitbucket'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function BitbucketIntegrationControls({
  organizationId,
  status,
}: BitbucketIntegrationControlsProps) {
  if (!status.integrationId || !status.canManage) return null;
  const replacementAvailable =
    status.method === 'workspace_access_token' &&
    (status.status === 'connected' || status.recoveryAction === 'replace_token');
  const controlsDescription = getBitbucketIntegrationControlsDescription(
    status.method,
    status.recoveryAction
  );

  return (
    <section
      className="border-border space-y-3 border-t pt-6"
      aria-labelledby="bitbucket-manager-controls-heading"
    >
      <div className="space-y-1">
        <h2 id="bitbucket-manager-controls-heading" className="type-heading">
          Integration controls
        </h2>
        {controlsDescription && (
          <p className="text-muted-foreground text-sm">{controlsDescription}</p>
        )}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {status.method === 'workspace_access_token' && (
          <ReplaceTokenDialog
            organizationId={organizationId}
            integrationId={status.integrationId}
            workspaceSlug={status.workspace?.slug ?? null}
            available={replacementAvailable}
          />
        )}
        <DisconnectDialog
          organizationId={organizationId}
          integrationId={status.integrationId}
          method={status.method}
        />
      </div>
    </section>
  );
}
