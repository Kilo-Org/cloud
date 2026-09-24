'use client';

import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type RemovalTarget = { organizationId: string; credentialId: string; acknowledged: boolean };

export function E2BComputeSettings({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removalTarget, setRemovalTarget] = useState<RemovalTarget | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const requestGeneration = useRef(0);

  const enrollmentQuery = useQuery({
    ...trpc.organizations.e2bCompute.getEnrollment.queryOptions({ organizationId }),
    retry: false,
  });
  const statusOptions = trpc.organizations.e2bCompute.getStatus.queryOptions({ organizationId });
  const statusQuery = useQuery({ ...statusOptions, retry: false });
  const status = statusQuery.data;
  const canConnect =
    enrollmentQuery.isSuccess && enrollmentQuery.data.enrolled && statusQuery.isSuccess && !status;

  const addMutation = useMutation(
    trpc.organizations.e2bCompute.add.mutationOptions({
      gcTime: 0,
      retry: false,
      networkMode: 'always',
    })
  );
  const removeMutation = useMutation(
    trpc.organizations.e2bCompute.remove.mutationOptions({
      gcTime: 0,
      retry: false,
      networkMode: 'always',
    })
  );
  const resetAdd = addMutation.reset;
  const resetRemove = removeMutation.reset;
  const isBusy = addMutation.isPending || removeMutation.isPending;
  const currentRemoval = removalTarget?.organizationId === organizationId ? removalTarget : null;

  useLayoutEffect(() => {
    setApiKey('');
    setAcknowledged(false);
    setSaveError(null);
    setRemovalTarget(null);
    setRemovalError(null);
    setRemoved(false);
    return () => {
      requestGeneration.current += 1;
      resetAdd();
      resetRemove();
    };
  }, [organizationId, resetAdd, resetRemove]);

  useLayoutEffect(() => {
    if (!canConnect) {
      setApiKey('');
      setAcknowledged(false);
      resetAdd();
    }
  }, [canConnect, resetAdd]);

  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: statusOptions.queryKey });

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canConnect || isBusy || !acknowledged || !apiKey.trim()) return;
    const generation = ++requestGeneration.current;
    setSaveError(null);
    try {
      await addMutation.mutateAsync({
        organizationId,
        apiKey: apiKey.trim(),
        acknowledgeDirectTokenAccess: true,
        consentVersion: 'e2b-direct-v1',
      });
      if (generation !== requestGeneration.current) return;
      setApiKey('');
      setAcknowledged(false);
      setRemoved(false);
      toast.success('E2B API key accepted. Sandbox creation has not been verified.');
    } catch (error) {
      if (generation === requestGeneration.current) {
        setSaveError(error instanceof Error ? error.message : 'Could not save the E2B API key.');
      }
    } finally {
      if (generation === requestGeneration.current) resetAdd();
      void invalidateStatus();
    }
  }

  async function remove() {
    if (!currentRemoval?.acknowledged || isBusy) return;
    const generation = ++requestGeneration.current;
    setRemovalError(null);
    try {
      await removeMutation.mutateAsync({
        organizationId: currentRemoval.organizationId,
        credentialId: currentRemoval.credentialId,
        acknowledgeRemoval: true,
      });
      if (generation !== requestGeneration.current) return;
      setRemovalTarget(null);
      setRemoved(true);
      toast.success('E2B connection removed. Existing resources and tokens are not revoked.');
    } catch (error) {
      if (generation === requestGeneration.current) {
        setRemovalError(
          error instanceof Error ? error.message : 'Could not remove the connection.'
        );
      }
    } finally {
      if (generation === requestGeneration.current) resetRemove();
      void invalidateStatus();
    }
  }

  return (
    <Card className="mx-auto w-full max-w-3xl" role="region" aria-labelledby="e2b-compute-title">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle id="e2b-compute-title" role="heading" aria-level={2}>
            E2B compute
          </CardTitle>
          {status && <Badge variant="secondary">API key accepted</Badge>}
        </div>
        <CardDescription>
          Run Cloud Agent on your organization&apos;s E2B account. E2B bills sandbox compute; Kilo
          subscriptions, model access, and inference billing stay unchanged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {enrollmentQuery.isPending && (
          <p className="text-muted-foreground text-sm" role="status">
            Checking pilot enrollment. Existing connections can still be removed.
          </p>
        )}
        {enrollmentQuery.isError && (
          <Alert variant="warning">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              Pilot enrollment could not be checked
            </AlertTitle>
            <AlertDescription>
              New connections are unavailable. Existing connections can still be removed.
              <Button
                variant="outline"
                size="sm"
                className="min-h-control-touch sm:min-h-0"
                onClick={() => void enrollmentQuery.refetch()}
                disabled={enrollmentQuery.isFetching}
              >
                Retry enrollment check
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {enrollmentQuery.isSuccess && !enrollmentQuery.data.enrolled && (
          <p className="text-muted-foreground text-sm">
            This organization is not enrolled in the E2B pilot. Existing connections can still be
            removed.
          </p>
        )}
        {statusQuery.isPending && (
          <p className="text-muted-foreground text-sm" role="status">
            Loading E2B connection.
          </p>
        )}
        {statusQuery.isError && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Could not load the E2B connection</AlertTitle>
            <AlertDescription>
              <Button
                variant="outline"
                size="sm"
                className="min-h-control-touch sm:min-h-0"
                onClick={() => void statusQuery.refetch()}
                disabled={statusQuery.isFetching}
              >
                Retry connection status
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {canConnect && (
          <form className="space-y-5" autoComplete="off" onSubmit={connect}>
            <div className="space-y-2">
              <Label htmlFor="e2b-api-key">E2B API key</Label>
              <Input
                id="e2b-api-key"
                name="e2b-access-secret"
                type="password"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                value={apiKey}
                onChange={event => {
                  setApiKey(event.target.value);
                  setSaveError(null);
                }}
                maxLength={4096}
                required
                disabled={isBusy}
                className="h-control-touch sm:h-9"
                aria-invalid={!!saveError}
                aria-describedby={saveError ? 'e2b-key-help e2b-save-error' : 'e2b-key-help'}
              />
              <p id="e2b-key-help" className="text-muted-foreground text-xs">
                Stored encrypted and never sent into the sandbox. Saving checks one sandbox list
                page only; it does not create a sandbox or verify quota, template access, or launch.
              </p>
            </div>
            <Alert variant="warning" role="note">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>Direct-token access</AlertTitle>
              <AlertDescription id="e2b-direct-token-disclosure">
                Sandbox code and E2B project administrators can read the Kilo token and managed
                GitHub, GitLab, and Bitbucket credentials supplied to sessions. Their full token
                scopes may grant access beyond one chat or session; they are not session-scoped.
              </AlertDescription>
            </Alert>
            <Label
              htmlFor="e2b-consent"
              className="min-h-control-touch items-start leading-relaxed"
            >
              <Checkbox
                id="e2b-consent"
                className="mt-1 shrink-0"
                checked={acknowledged}
                onCheckedChange={setAcknowledged}
                required
                disabled={isBusy}
                aria-describedby="e2b-direct-token-disclosure"
              />
              I understand and accept direct access to the full Kilo and source-control token scopes
              for this organization.
            </Label>
            {saveError && (
              <p id="e2b-save-error" className="text-destructive text-sm" role="alert">
                {saveError}
              </p>
            )}
            <Button
              type="submit"
              disabled={isBusy || !acknowledged || !apiKey.trim()}
              className="min-h-control-touch w-full sm:min-h-0 sm:w-auto"
            >
              {addMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {addMutation.isPending ? 'Checking API key...' : 'Save E2B connection'}
            </Button>
          </form>
        )}
        {status && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              API key accepted on{' '}
              <time dateTime={status.validatedAt}>
                {new Date(status.validatedAt).toLocaleString()}
              </time>
              . Sandbox creation, quota, and template access have not been verified. Direct-token
              consent is recorded as {status.consentVersion}. Replacing the key requires removal and
              fresh consent; existing sessions are not moved to the replacement.
            </p>
            <AlertDialog
              open={!!currentRemoval}
              onOpenChange={open => {
                if (!open && !removeMutation.isPending) setRemovalTarget(null);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  disabled={isBusy}
                  className="min-h-control-touch w-full sm:min-h-0 sm:w-auto"
                  onClick={() => {
                    setRemovalTarget({
                      organizationId,
                      credentialId: status.credentialId,
                      acknowledged: false,
                    });
                    setRemovalError(null);
                  }}
                >
                  <Trash2 aria-hidden="true" /> Remove E2B connection
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove this E2B connection?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Removal blocks future provider access, control, and restoration for sessions
                    bound to this connection. It does not stop existing sandboxes or revoke Kilo or
                    source-control tokens already available in them. Allocations retain only their
                    last bounded lease; an E2B administrator may need to stop them directly.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <p className="text-muted-foreground font-mono text-xs break-all">
                  {currentRemoval?.credentialId}
                </p>
                <Label
                  htmlFor="e2b-removal-consent"
                  className="min-h-control-touch items-start leading-relaxed"
                >
                  <Checkbox
                    id="e2b-removal-consent"
                    className="mt-1 shrink-0"
                    checked={currentRemoval?.acknowledged ?? false}
                    onCheckedChange={value =>
                      setRemovalTarget(current => current && { ...current, acknowledged: value })
                    }
                    disabled={removeMutation.isPending}
                  />
                  I understand that removal does not revoke existing resources or tokens.
                </Label>
                {removalError && (
                  <p className="text-destructive text-sm" role="alert">
                    {removalError}
                  </p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel
                    disabled={removeMutation.isPending}
                    className="min-h-control-touch sm:min-h-0"
                  >
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => void remove()}
                    disabled={!currentRemoval?.acknowledged || isBusy}
                    className="min-h-control-touch sm:min-h-0"
                  >
                    {removeMutation.isPending && (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    )}
                    {removeMutation.isPending ? 'Removing...' : 'Remove connection'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
        {removed && (
          <p className="text-muted-foreground text-sm" role="status">
            The connection was removed. Existing sandboxes and guest-held tokens are not revoked. An
            E2B administrator may need to stop old sandboxes directly.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
