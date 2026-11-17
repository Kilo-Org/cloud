'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useConfirm } from '@/components/ui/confirm';

const TOKEN_ERRORS: Record<string, string> = {
  invalid_token: 'GitHub rejected this token. Check the token and try again.',
  invalid_github_token_request:
    'Enter a personal access token or OAuth access token without spaces.',
  rate_limited: 'GitHub limited this request. Wait and try again.',
  connection_conflict: 'Your GitHub connection changed. Reload its status and try again.',
  already_connected_to_another_account: 'This GitHub account is connected to another Kilo account.',
  disconnect_existing_identity_first:
    'Disconnect the current GitHub account before connecting another account.',
};

export function GitHubIdentityCard({ isInstalled }: { isInstalled: boolean }) {
  const trpc = useTRPC();
  const client = useRawTRPCClient();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const {
    data: identity,
    isLoading,
    isError,
  } = useQuery(trpc.githubApps.getUserAuthorization.queryOptions());
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The password stays in the input element. React Query never retains it.
  const tokenInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = tokenInput.current;
    return () => {
      if (input) input.value = '';
    };
  }, [showToken]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: trpc.githubApps.getUserAuthorization.queryKey() });
  const connect = useMutation(
    trpc.githubApps.connectUserAuthorization.mutationOptions({
      onSuccess: result => {
        window.location.href = result.authorizationUrl;
      },
      onError: () => {
        setError('GitHub connection could not start. Reload its status and try again.');
        void invalidate();
      },
    })
  );
  const disconnect = useMutation(
    trpc.githubApps.disconnectUserAuthorization.mutationOptions({
      onSuccess: () => {
        setError(null);
        void invalidate();
        toast.success('GitHub identity disconnected');
      },
      onError: failure => {
        setError(
          failure.message === 'connection_conflict'
            ? TOKEN_ERRORS.connection_conflict
            : 'GitHub disconnect failed. Reload its status and try again.'
        );
        void invalidate();
      },
    })
  );
  const expected = identity
    ? {
        authorizationId: identity.authorizationId,
        credentialVersion: identity.credentialVersion,
      }
    : null;
  const busy = submitting || connect.isPending || disconnect.isPending;
  const provided = identity?.credentialSource === 'provided_token';

  async function submitToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tokenInput.current || !expected || busy) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.githubApps.provideUserToken.mutate(
        { token: tokenInput.current.value, expected },
        { context: { skipBatch: true } }
      );
      if (tokenInput.current) tokenInput.current.value = '';
      setShowToken(false);
      await invalidate();
      toast.success('GitHub identity connected');
    } catch (failure) {
      // Render fixed copy only. A transport error can retain submitted input.
      const message = failure instanceof Error ? failure.message : '';
      setError(TOKEN_ERRORS[message] ?? 'GitHub could not validate this token. Try again.');
      await invalidate();
    } finally {
      setSubmitting(false);
    }
  }

  async function disconnectIdentity() {
    if (!expected) return;
    if (
      await confirm({
        title: 'Disconnect your GitHub identity?',
        description: provided
          ? 'Kilo will remove its stored token. To revoke the original token, use its issuer.'
          : 'Kilo will revoke its GitHub App authorization for your account.',
        confirmLabel: 'Disconnect',
        destructive: true,
      })
    )
      disconnect.mutate(expected);
  }

  return (
    <Card id="github-identity">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <UserRound className="size-5" />
            Use your GitHub identity
          </CardTitle>
          <Badge variant={identity?.connected ? 'default' : 'secondary'}>
            {isLoading ? 'Loading…' : identity?.connected ? 'Connected' : 'Not connected'}
          </Badge>
        </div>
        <CardDescription>
          Connect your personal identity for eligible Cloud Agent actions where the Kilo GitHub App
          has repository access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {identity?.revoked && (
          <Alert variant="destructive">
            <AlertDescription>
              Your GitHub credential is no longer valid. Replace the token or reconnect through
              GitHub.
            </AlertDescription>
          </Alert>
        )}
        {isError && (
          <Alert variant="destructive">
            <AlertDescription>
              GitHub connection status is unavailable. Reload the page and try again.
            </AlertDescription>
          </Alert>
        )}
        {identity?.githubLogin && (
          <div className="space-y-1 text-sm">
            <p className="font-mono">@{identity.githubLogin}</p>
            <p className="text-muted-foreground">
              {/* App access tokens refresh automatically, so only a provided token shows expiry. */}
              {provided
                ? `Provided token · ${
                    identity.expiresAt
                      ? `Expires ${new Date(identity.expiresAt).toLocaleString()}`
                      : 'Expiry unknown'
                  }`
                : 'GitHub App'}
            </p>
          </div>
        )}
        {provided && (
          <p className="text-muted-foreground text-sm">
            Kilo cannot refresh a provided token. Replace it when it expires. Disconnect removes
            Kilo’s stored copy.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {!identity?.connected && (
            <Button variant="outline" disabled={!identity || busy} onClick={() => connect.mutate()}>
              {connect.isPending ? 'Connecting…' : 'Connect through GitHub'}
            </Button>
          )}
          {identity && !showToken && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setShowToken(true);
                setError(null);
              }}
            >
              {provided ? 'Replace token' : 'Provide a token'}
            </Button>
          )}
          {identity?.authorizationId && (
            <Button variant="outline" disabled={busy} onClick={() => void disconnectIdentity()}>
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          )}
        </div>
        {showToken && (
          <form
            onSubmit={event => void submitToken(event)}
            className="space-y-3"
            data-ph-no-capture
          >
            <Label htmlFor="github-identity-token">
              Personal access token or OAuth access token
            </Label>
            <Input
              id="github-identity-token"
              ref={tokenInput}
              type="password"
              autoComplete="off"
              autoFocus
              maxLength={10_000}
              required
              disabled={busy}
              aria-describedby="github-token-help github-token-error"
              data-private
              data-ph-no-capture
            />
            <p id="github-token-help" className="text-muted-foreground text-sm">
              Kilo checks your GitHub identity. Available actions depend on the token’s permissions.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy}>
                {submitting ? 'Validating…' : 'Connect token'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (tokenInput.current) tokenInput.current.value = '';
                  setShowToken(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p id="github-token-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {identity?.connected && (
          <p className="text-muted-foreground text-sm">
            {isInstalled
              ? 'Eligible sessions can use this identity.'
              : 'Cloud Agent also needs repository access through a personal or organization Kilo GitHub App installation.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
