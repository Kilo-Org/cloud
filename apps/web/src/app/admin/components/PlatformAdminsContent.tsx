'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';
import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UserAvatarLink } from './UserAvatarLink';
import { UserSearchInput } from './UserSearchInput';

type RouterOutputs = inferRouterOutputs<RootRouter>;
// Both procedures share the same server-side column projection
// (`platformAdminUserColumns` in admin-router.ts), so their outputs have the
// same shape; deriving from the roster's output type here means this type
// can't drift from the server contract the way a hand-copied literal could.
type PlatformAdminUser = RouterOutputs['admin']['users']['listPlatformAdmins']['admins'][number];

type ConfirmAction =
  | { type: 'grant'; user: PlatformAdminUser }
  | { type: 'revoke'; user: PlatformAdminUser };

function AccountStatusBadge({ user }: { user: PlatformAdminUser }) {
  if (user.blocked_reason) {
    return <Badge variant="destructive">Blocked</Badge>;
  }
  return <Badge variant="secondary">Active</Badge>;
}

export function PlatformAdminsContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  // The dialog is controlled and has no DialogTrigger, so Radix has no trigger
  // ref to restore focus to on close and would leave focus on <body>. We track
  // the element that opened the dialog (the clicked Grant/Revoke button) and
  // restore focus to it on cancel/Escape/close-button/no-op closes.
  //
  // For a state-changing mutation we must NOT rely on `opener.isConnected` at
  // close time: onCloseAutoFocus fires right after the ~200ms Radix close
  // animation, but the opener row only unmounts once the invalidated queries
  // refetch (a network round trip that typically outlasts the animation). So
  // the opener is usually still connected at close time, we'd focus it, and
  // then the later refetch would drop focus to <body>. Instead we decide
  // deterministically in onSuccess: a changed result means the row is going
  // away, so redirect focus to the stable container.
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const redirectFocusToContainerRef = useRef(false);

  const trimmedSearchTerm = searchTerm.trim();

  const {
    data: rosterData,
    isLoading: isRosterLoading,
    error: rosterError,
  } = useQuery(trpc.admin.users.listPlatformAdmins.queryOptions());

  const canGrantAdmins = rosterData?.canGrantAdmins ?? false;

  const {
    data: candidates,
    isFetching: isSearching,
    isError: isSearchError,
    error: searchError,
  } = useQuery({
    ...trpc.admin.users.searchPlatformAdminCandidates.queryOptions({ query: trimmedSearchTerm }),
    enabled: canGrantAdmins && trimmedSearchTerm.length > 0,
  });

  function invalidateAfterChange() {
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.users.listPlatformAdmins.queryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.users.searchPlatformAdminCandidates.queryKey(),
    });
  }

  const setAccessMutation = useMutation(
    trpc.admin.users.setPlatformAdminAccess.mutationOptions({
      onSuccess: (result, variables) => {
        invalidateAfterChange();
        // A changed result unmounts the opener row once the refetch settles, so
        // send focus to the stable container rather than the doomed button. A
        // no-op leaves the row in place, so keep focus on the opener.
        redirectFocusToContainerRef.current = result.changed;
        setConfirmAction(null);
        if (!result.changed) {
          toast.message(
            variables.isAdmin
              ? `${result.user.google_user_email} already has platform admin access.`
              : `${result.user.google_user_email} already does not have platform admin access.`
          );
          return;
        }
        if (variables.isAdmin) {
          setSearchTerm('');
          toast.success(`Granted platform admin access to ${result.user.google_user_email}.`);
        } else {
          toast.success(`Revoked platform admin access from ${result.user.google_user_email}.`);
        }
      },
      onError: error => {
        toast.error(error.message || 'Failed to update platform admin access');
      },
    })
  );

  const pendingUserId =
    setAccessMutation.isPending && setAccessMutation.variables
      ? setAccessMutation.variables.userId
      : null;

  const admins = rosterData?.admins ?? [];
  const currentUserId = rosterData?.currentUserId;

  const candidateRows = useMemo(() => candidates ?? [], [candidates]);

  function requestRevoke(user: PlatformAdminUser, event: React.MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    setConfirmAction({ type: 'revoke', user });
  }

  function requestGrant(user: PlatformAdminUser, event: React.MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    setConfirmAction({ type: 'grant', user });
  }

  function confirmPendingAction() {
    if (!confirmAction) return;
    setAccessMutation.mutate({
      userId: confirmAction.user.id,
      isAdmin: confirmAction.type === 'grant',
    });
  }

  return (
    <div ref={contentRef} tabIndex={-1} className="flex flex-col gap-y-6 outline-none">
      <Card>
        <CardHeader>
          <CardTitle>Current admins</CardTitle>
          <CardDescription>
            Everyone with platform admin access today. Revoking a credit manager also removes
            credit-management permission.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isRosterLoading ? (
            <div className="text-muted-foreground py-8 text-center text-sm">Loading admins...</div>
          ) : rosterError ? (
            <div className="text-destructive py-8 text-center text-sm">
              {rosterError.message || 'Failed to load admins'}
            </div>
          ) : admins.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center text-sm">
              No platform admins found.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Hosted domain</TableHead>
                    <TableHead>Account status</TableHead>
                    <TableHead>Credit management</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {admins.map(admin => (
                    <TableRow key={admin.id}>
                      <TableCell>
                        <UserAvatarLink user={admin} displayFormat="email-name" className="flex" />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {admin.hosted_domain ?? '—'}
                      </TableCell>
                      <TableCell>
                        <AccountStatusBadge user={admin} />
                      </TableCell>
                      <TableCell>
                        {admin.can_manage_credits ? (
                          <Badge variant="secondary">Credit manager</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {admin.id === currentUserId ? (
                          <span className="text-muted-foreground text-sm">You</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingUserId === admin.id}
                            onClick={event => requestRevoke(admin, event)}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Grant admin access</CardTitle>
          <CardDescription>
            {isRosterLoading
              ? 'Checking your permissions…'
              : rosterError
                ? 'Could not determine your permissions. Reload to try again.'
                : canGrantAdmins
                  ? 'Search registered kilocode.ai users who are not already admins.'
                  : 'Only a qualifying kilocode.ai admin can grant platform admin access. You can still revoke other admins from the roster above.'}
          </CardDescription>
        </CardHeader>
        {!isRosterLoading && !rosterError && canGrantAdmins && (
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="platform-admin-candidate-search">Search for a user to grant</Label>
              <UserSearchInput
                id="platform-admin-candidate-search"
                value={searchTerm}
                onChange={setSearchTerm}
                isLoading={isSearching}
                placeholder="Search by email or name..."
                aria-describedby="platform-admin-candidate-search-hint"
              />
              <p
                id="platform-admin-candidate-search-hint"
                className="text-muted-foreground text-xs"
              >
                Only registered kilocode.ai users who are not already admins can be granted access.
              </p>
            </div>

            {trimmedSearchTerm.length === 0 ? (
              <div className="text-muted-foreground py-4 text-center text-sm">
                Enter an email or name to search for eligible users.
              </div>
            ) : isSearchError ? (
              <div className="text-destructive py-4 text-center text-sm">
                {searchError instanceof Error
                  ? searchError.message
                  : 'Something went wrong while searching. Try again.'}
              </div>
            ) : candidateRows.length === 0 && !isSearching ? (
              <div className="text-muted-foreground py-4 text-center text-sm">
                No eligible kilocode.ai users matched that search.
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Hosted domain</TableHead>
                      <TableHead>Account status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {candidateRows.map(candidate => (
                      <TableRow key={candidate.id}>
                        <TableCell>
                          <UserAvatarLink
                            user={candidate}
                            displayFormat="email-name"
                            className="flex"
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {candidate.hosted_domain ?? '—'}
                        </TableCell>
                        <TableCell>
                          <AccountStatusBadge user={candidate} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            disabled={pendingUserId === candidate.id}
                            onClick={event => requestGrant(candidate, event)}
                          >
                            Grant
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <Dialog
        open={confirmAction !== null}
        onOpenChange={open => {
          // Ignore Escape/backdrop/close-button dismissal while a mutation is
          // in flight: this is the single mutation shared by every row in both
          // tables, so letting the dialog close mid-request would let an admin
          // open a second confirmation for a different user before the first
          // request resolves, defeating the "one action at a time" intent of
          // `pendingUserId`-based row disabling below.
          if (!open && !setAccessMutation.isPending) {
            setConfirmAction(null);
          }
        }}
      >
        <DialogContent
          showCloseButton={!setAccessMutation.isPending}
          onCloseAutoFocus={event => {
            // Controlled dialog with no DialogTrigger: Radix can't restore focus
            // on its own. A state-changing mutation (flagged deterministically in
            // onSuccess) will unmount the opener row after its refetch settles, so
            // send focus to the stable container. Otherwise (cancel/Escape/close/
            // no-op) the opener still exists — restore focus to it, falling back
            // to the container only if it has somehow already been removed.
            event.preventDefault();
            const opener = openerRef.current;
            if (redirectFocusToContainerRef.current || !opener || !opener.isConnected) {
              contentRef.current?.focus();
            } else {
              opener.focus();
            }
            openerRef.current = null;
            redirectFocusToContainerRef.current = false;
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {confirmAction
                ? confirmAction.type === 'grant'
                  ? 'Grant platform admin access'
                  : 'Revoke platform admin access'
                : ''}
            </DialogTitle>
            <DialogDescription>
              {confirmAction && confirmAction.type === 'grant' ? (
                <>
                  Are you sure you want to grant platform admin access to{' '}
                  <span className="font-medium">{confirmAction.user.google_user_email}</span>? This
                  will not grant credit-management permission. Their current browser sessions will
                  be signed out.
                </>
              ) : confirmAction ? (
                <>
                  Are you sure you want to revoke platform admin access from{' '}
                  <span className="font-medium">{confirmAction.user.google_user_email}</span>? Their
                  current browser sessions will be signed out.
                  {confirmAction.user.can_manage_credits && (
                    <> Credit-management permission will also be removed.</>
                  )}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={setAccessMutation.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={confirmAction?.type === 'revoke' ? 'destructive' : 'default'}
              onClick={confirmPendingAction}
              disabled={setAccessMutation.isPending}
            >
              {setAccessMutation.isPending
                ? 'Saving...'
                : confirmAction?.type === 'grant'
                  ? 'Grant Access'
                  : 'Revoke Access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
