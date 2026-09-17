'use client';

import { KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useMutation, useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';

/** The one route that mints registration options and verifies the attestation. */
const REGISTER_ROUTE = '/api/auth/passkey/register';

/**
 * Why a passkey creation attempt did not add a row.
 *
 * - `cancelled`: the user dismissed the creation sheet. Nothing was stored, and
 *   a fresh attempt is a new ceremony rather than a retry of this one.
 * - `failed`: the request or the verification failed. Nothing was stored, and
 *   the "Add a passkey" control is a working retry.
 */
export type PasskeyRegistrationFailure = 'cancelled' | 'failed';

export class PasskeyRegistrationError extends Error {
  readonly failure: PasskeyRegistrationFailure;

  constructor(failure: PasskeyRegistrationFailure) {
    super(failure);
    this.name = 'PasskeyRegistrationError';
    this.failure = failure;
  }
}

/**
 * Register a passkey for the signed-in user: mint options server-side, run the
 * browser ceremony, then let the server verify the attestation against the
 * challenge it stored. The row only exists once the server has accepted it.
 *
 * Exported without React state so the sequence, and every refusal it can map,
 * is unit-testable outside a browser.
 */
export async function registerNewPasskey(): Promise<void> {
  try {
    const optionsResponse = await fetch(REGISTER_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'options' }),
    });
    if (!optionsResponse.ok) {
      throw new PasskeyRegistrationError('failed');
    }

    const body = (await optionsResponse.json()) as { challengeId?: unknown; options?: unknown };
    if (typeof body.challengeId !== 'string' || !body.options) {
      throw new PasskeyRegistrationError('failed');
    }

    let attestation: Awaited<ReturnType<typeof startRegistration>>;
    try {
      attestation = await startRegistration({
        optionsJSON: body.options as PublicKeyCredentialCreationOptionsJSON,
      });
    } catch {
      // The sheet was dismissed, timed out, or the platform refused. No row was
      // written, so there is no half-added passkey to clean up.
      throw new PasskeyRegistrationError('cancelled');
    }

    const verifyResponse = await fetch(REGISTER_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'verify',
        challengeId: body.challengeId,
        response: attestation,
      }),
    });
    if (!verifyResponse.ok) {
      throw new PasskeyRegistrationError('failed');
    }
  } catch (error) {
    if (error instanceof PasskeyRegistrationError) {
      throw error;
    }
    throw new PasskeyRegistrationError('failed');
  }
}

export type PasskeySummary = {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  device_type: string | null;
  backed_up: boolean;
};

/** The list row's date, in one deterministic format for every locale. */
export function formatPasskeyDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return format(parsed, 'PP');
}

function passkeyLabel(passkey: PasskeySummary): string {
  return passkey.name?.trim() || 'Passkey';
}

/**
 * Passkeys for the signed-in user: the list, creation through the browser's
 * platform authenticator, rename and removal behind a confirmation.
 *
 * A failed request keeps whatever the list already showed — including a row
 * whose removal failed — and reports the failure inline beside a working retry.
 */
export function PasskeysCard() {
  const trpc = useTRPC();
  const passkeysQuery = useQuery(trpc.user.getPasskeys.queryOptions());

  // The credential API is a browser global, so support starts unknown (`null`)
  // and is only ever `true`/`false` after the client has read it. The unsupported
  // notice below waits for an explicit `false`, so a capable browser is never
  // briefly reported as unable to create passkeys.
  const [canCreatePasskeys, setCanCreatePasskeys] = useState<boolean | null>(null);
  useEffect(() => {
    setCanCreatePasskeys(browserSupportsWebAuthn());
  }, []);

  const [isAdding, setIsAdding] = useState(false);
  const [addFailure, setAddFailure] = useState<PasskeyRegistrationFailure | null>(null);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);
  const [renameFailure, setRenameFailure] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<PasskeySummary | null>(null);
  const [renameName, setRenameName] = useState('');
  const [removeTarget, setRemoveTarget] = useState<PasskeySummary | null>(null);

  const passkeys = passkeysQuery.data?.passkeys ?? [];

  const renameMutation = useMutation(
    trpc.user.renamePasskey.mutationOptions({
      onSuccess: async () => {
        setRenameTarget(null);
        setRenameFailure(null);
        await passkeysQuery.refetch();
      },
      onError: () => {
        // The row keeps its old name, and the dialog stays open for another try.
        setRenameFailure('Could not rename that passkey. Try again.');
      },
    })
  );

  const removeMutation = useMutation(
    trpc.user.deletePasskey.mutationOptions({
      onSuccess: async () => {
        setRemoveTarget(null);
        setRemoveFailure(null);
        await passkeysQuery.refetch();
      },
      onError: () => {
        // The row is still there, so the same control is a working retry.
        setRemoveTarget(null);
        setRemoveFailure('Could not remove that passkey. Try again.');
      },
    })
  );

  const handleAddPasskey = useCallback(async () => {
    if (isAdding) return;
    setIsAdding(true);
    setAddFailure(null);
    try {
      await registerNewPasskey();
      await passkeysQuery.refetch();
    } catch (error) {
      setAddFailure(error instanceof PasskeyRegistrationError ? error.failure : 'failed');
    } finally {
      setIsAdding(false);
    }
  }, [isAdding, passkeysQuery]);

  const addControl = canCreatePasskeys ? (
    <Button variant="outline" onClick={() => void handleAddPasskey()} disabled={isAdding}>
      <Plus className="mr-2 h-4 w-4" />
      {isAdding ? 'Waiting for your passkey…' : 'Add a passkey'}
    </Button>
  ) : null;

  const addFailureMessage =
    addFailure === 'failed'
      ? 'Could not add a passkey. Try again.'
      : addFailure === 'cancelled'
        ? 'Passkey creation was cancelled. No passkey was added.'
        : null;

  return (
    <Card className="h-full w-full rounded-xl shadow-sm">
      <CardContent className="space-y-6 pt-6">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            <span className="font-medium">Passkeys</span>
          </div>

          {passkeysQuery.isLoading ? (
            // Sized like the rows it replaces, so loading→content does not move
            // anything around the card.
            <div
              className="space-y-2"
              role="status"
              aria-busy="true"
              aria-label="Loading your passkeys"
            >
              <Skeleton className="h-[62px] w-full rounded-lg" />
              <Skeleton className="h-[62px] w-full rounded-lg" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : passkeysQuery.isError && passkeysQuery.data === undefined ? (
            // The first load failed with nothing to keep on screen.
            <div className="space-y-3">
              <p role="alert" className="text-muted-foreground text-sm leading-relaxed">
                Could not load your passkeys. Try again.
              </p>
              <Button variant="outline" onClick={() => void passkeysQuery.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              {passkeysQuery.isError && (
                // A background refresh failed with a list already on screen.
                // Whatever was rendered stays, and the retry re-runs the same
                // request while the rows remain visible.
                <div className="space-y-3">
                  <p role="alert" className="text-muted-foreground text-sm leading-relaxed">
                    Could not load your passkeys. Try again.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => void passkeysQuery.refetch()}
                    disabled={passkeysQuery.isFetching}
                  >
                    {passkeysQuery.isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Try again
                  </Button>
                </div>
              )}
              {passkeys.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-muted-foreground text-sm">No passkeys yet</p>
                  {addControl}
                </div>
              ) : (
                <div className="space-y-2" role="list" aria-label="Your passkeys">
                  {passkeys.map(passkey => (
                    <div
                      key={passkey.id}
                      role="listitem"
                      className="flex items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{passkeyLabel(passkey)}</div>
                        <div className="text-muted-foreground text-sm">
                          Added {formatPasskeyDate(passkey.created_at)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={removeMutation.isPending}
                          onClick={() => {
                            setRenameTarget(passkey);
                            setRenameName(passkey.name ?? '');
                            setRenameFailure(null);
                          }}
                        >
                          <Pencil className="mr-1 h-4 w-4" />
                          Rename
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={removeMutation.isPending}
                          onClick={() => {
                            setRemoveTarget(passkey);
                            setRemoveFailure(null);
                          }}
                        >
                          <Trash2 className="mr-1 h-4 w-4" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                  {addControl}
                </div>
              )}
            </>
          )}

          {canCreatePasskeys === false && !passkeysQuery.isLoading && (
            <p role="alert" className="text-muted-foreground text-sm leading-relaxed">
              This browser cannot create passkeys.
            </p>
          )}

          {addFailureMessage && (
            <p role="alert" className="text-muted-foreground text-sm leading-relaxed">
              {addFailureMessage}
            </p>
          )}

          {removeFailure && (
            <p role="alert" className="text-muted-foreground text-sm leading-relaxed">
              {removeFailure}
            </p>
          )}
        </div>
      </CardContent>

      <Dialog open={!!renameTarget} onOpenChange={open => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename passkey</DialogTitle>
            <DialogDescription>
              Give this passkey a name you will recognise on this device.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameName}
            maxLength={64}
            placeholder="My laptop"
            onChange={event => setRenameName(event.target.value)}
          />
          {renameFailure && (
            <p role="alert" className="text-muted-foreground text-sm leading-relaxed">
              {renameFailure}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!renameName.trim() || renameMutation.isPending}
              onClick={() => {
                if (renameTarget) {
                  renameMutation.mutate({ id: renameTarget.id, name: renameName.trim() });
                }
              }}
            >
              {renameMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removeTarget} onOpenChange={open => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove passkey</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove{' '}
              {removeTarget ? passkeyLabel(removeTarget) : 'this passkey'}? You will no longer be
              able to sign in with it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removeMutation.isPending}
              onClick={() => setRemoveTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removeMutation.isPending}
              onClick={() => {
                if (removeTarget) {
                  removeMutation.mutate({ id: removeTarget.id });
                }
              }}
            >
              {removeMutation.isPending ? 'Removing…' : 'Yes, remove passkey'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
