'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';
import { maxSupportDurationMinutes, parseSupportDurationMinutes } from './duration';
import {
  missingSupportRequestRequirements,
  SUPPORT_REASON_MIN_LENGTH,
} from './request-requirements';
import {
  SupportOrganizationPicker,
  type SelectedSupportOrganization,
} from './SupportOrganizationPicker';

type ActionClass = 'support_read' | 'support_write';

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function OrganizationCell({ id, name }: { id: string; name: string | null }) {
  return (
    <TableCell>
      <Link href={`/admin/organizations/${id}`} className="hover:underline">
        {name ?? <span className="font-mono text-xs">{id}</span>}
      </Link>
    </TableCell>
  );
}

function PersonCell({
  person,
}: {
  person: { id: string; name: string | null; email: string | null };
}) {
  return (
    <TableCell>
      <Link href={`/admin/users/${encodeURIComponent(person.id)}`} className="hover:underline">
        {person.name ?? person.email ?? <span className="font-mono text-xs">{person.id}</span>}
      </Link>
      {person.name && person.email && (
        <div className="text-muted-foreground text-xs">{person.email}</div>
      )}
    </TableCell>
  );
}

export function SupportAccessContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const currentUserId = session?.kiloUserId;
  // Until the session resolves, the viewer identity is unknown; every
  // actionable row fails closed so a requester's own pending grant can never
  // look actionable to its requester.
  const viewerIdentityKnown = currentUserId !== undefined;
  const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>({});
  const [organization, setOrganization] = useState<SelectedSupportOrganization | null>(null);
  const organizationId = organization?.id ?? '';
  const [actionClass, setActionClass] = useState<ActionClass>('support_read');
  const [durationMinutes, setDurationMinutes] = useState('');
  const [ticketReference, setTicketReference] = useState('');
  const [reason, setReason] = useState('');
  const [emergencyReason, setEmergencyReason] = useState('');

  const mineOptions = trpc.admin.supportAccess.listMine.queryOptions();
  const pendingOptions = trpc.admin.supportAccess.listPending.queryOptions();
  const activeOptions = trpc.admin.supportAccess.listActive.queryOptions();
  const emergencyOptions = trpc.admin.supportAccess.listUnreviewedEmergency.queryOptions();

  const mine = useQuery(mineOptions);
  const pending = useQuery({ ...pendingOptions, retry: false });
  const active = useQuery({ ...activeOptions, retry: false });
  const emergencies = useQuery({ ...emergencyOptions, retry: false });

  const refreshAll = () => {
    for (const options of [mineOptions, pendingOptions, activeOptions, emergencyOptions]) {
      void queryClient.invalidateQueries({ queryKey: options.queryKey });
    }
  };

  const request = useMutation(
    trpc.admin.supportAccess.request.mutationOptions({
      onSuccess: grant => {
        toast.success(grant.status === 'active' ? 'Read access active' : 'Write access requested');
        setReason('');
        setTicketReference('');
        setDurationMinutes('');
        refreshAll();
      },
      onError: error => toast.error(error.message || 'Failed to request support access'),
    })
  );

  const approve = useMutation(
    trpc.admin.supportAccess.approve.mutationOptions({
      onSuccess: () => {
        toast.success('Support write access approved');
        refreshAll();
      },
      onError: error => toast.error(error.message || 'Failed to approve'),
    })
  );

  const deny = useMutation(
    trpc.admin.supportAccess.deny.mutationOptions({
      onSuccess: () => {
        toast.success('Support access denied');
        refreshAll();
      },
      onError: error => toast.error(error.message || 'Failed to deny'),
    })
  );

  const cancel = useMutation(
    trpc.admin.supportAccess.cancel.mutationOptions({
      onSuccess: () => {
        toast.success('Support access request cancelled');
        refreshAll();
      },
      onError: error => toast.error(error.message || 'Failed to cancel'),
    })
  );

  const revoke = useMutation(
    trpc.admin.supportAccess.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Support access revoked');
        refreshAll();
      },
      onError: error => toast.error(error.message || 'Failed to revoke'),
    })
  );

  const emergency = useMutation(
    trpc.admin.supportAccess.emergencyIssue.mutationOptions({
      onSuccess: () => {
        toast.success('Emergency write access issued for review');
        setEmergencyReason('');
        refreshAll();
      },
      onError: error => toast.error(error.message || 'Failed to issue emergency access'),
    })
  );

  const review = useMutation(
    trpc.admin.supportAccess.review.mutationOptions({
      onSuccess: () => {
        toast.success('Emergency access reviewed');
        refreshAll();
      },
      onError: error => toast.error(error.message || 'Failed to review'),
    })
  );

  const parsedDuration = parseSupportDurationMinutes(durationMinutes, actionClass);
  const durationSeconds =
    parsedDuration.valid && parsedDuration.minutes !== undefined
      ? parsedDuration.minutes * 60
      : undefined;
  const maxDurationMinutes = maxSupportDurationMinutes(actionClass);
  const missingRequirements = missingSupportRequestRequirements({
    organizationId,
    reason,
    durationError: parsedDuration.valid ? undefined : parsedDuration.error,
  });
  const missingEmergencyRequirements = missingSupportRequestRequirements({
    organizationId,
    reason: emergencyReason,
  });

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Request access</CardTitle>
          <CardDescription>
            Read access activates immediately for up to 60 minutes. Write access needs a second
            approver and lasts at most 15 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <SupportOrganizationPicker selected={organization} onSelect={setOrganization} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="support-action-class">Action class</Label>
            <select
              id="support-action-class"
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              value={actionClass}
              onChange={event => setActionClass(event.target.value as ActionClass)}
            >
              <option value="support_read">Read (up to 60 minutes)</option>
              <option value="support_write">Write (up to 15 minutes, approval required)</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="support-duration">Duration (minutes, optional)</Label>
            <Input
              id="support-duration"
              inputMode="numeric"
              aria-invalid={!parsedDuration.valid}
              aria-describedby="support-duration-help"
              value={durationMinutes}
              onChange={event => setDurationMinutes(event.target.value)}
              placeholder={actionClass === 'support_read' ? '60' : '15'}
            />
            <p
              id="support-duration-help"
              className={
                parsedDuration.valid ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'
              }
            >
              {parsedDuration.valid
                ? `Optional; at most ${maxDurationMinutes} minutes. Longer values are clamped.`
                : parsedDuration.error}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="support-ticket">Ticket reference (optional)</Label>
            <Input
              id="support-ticket"
              value={ticketReference}
              onChange={event => setTicketReference(event.target.value)}
              placeholder="SUP-1234"
            />
          </div>
          <div className="flex flex-col gap-2 md:col-span-2">
            <Label htmlFor="support-reason">
              Reason (at least {SUPPORT_REASON_MIN_LENGTH} characters)
            </Label>
            <Textarea
              id="support-reason"
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="What are you investigating, and why does it need customer data?"
              rows={3}
            />
          </div>
          <div className="flex flex-col gap-2 md:col-span-2">
            <Button
              className="self-start"
              aria-describedby={
                missingRequirements.length > 0 ? 'support-request-missing' : undefined
              }
              disabled={request.isPending || missingRequirements.length > 0}
              onClick={() =>
                request.mutate({
                  organizationId,
                  actionClass,
                  reason: reason.trim(),
                  ticketReference: ticketReference.trim() || undefined,
                  durationSeconds,
                })
              }
            >
              {actionClass === 'support_read' ? 'Start read access' : 'Request write access'}
            </Button>
            {missingRequirements.length > 0 && (
              <ul
                id="support-request-missing"
                className="text-muted-foreground list-disc pl-5 text-xs"
              >
                {missingRequirements.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>My open grants</CardTitle>
          <CardDescription>Requests and grants you hold right now.</CardDescription>
        </CardHeader>
        <CardContent>
          {mine.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {mine.data?.length === 0 && (
            <p className="text-muted-foreground text-sm">No open support access grants.</p>
          )}
          {mine.data && mine.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {mine.data.map(grant => (
                  <TableRow key={grant.id}>
                    <OrganizationCell id={grant.organizationId} name={grant.organizationName} />
                    <TableCell>{grant.actionClass}</TableCell>
                    <TableCell>{grant.status}</TableCell>
                    <TableCell>{formatDate(grant.expiresAt)}</TableCell>
                    <TableCell className="max-w-80 truncate">{grant.reason}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        {grant.status === 'pending' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={cancel.isPending}
                            onClick={() => cancel.mutate({ grantId: grant.id })}
                          >
                            Cancel
                          </Button>
                        )}
                        {grant.status === 'active' && (
                          <div className="flex items-center gap-2">
                            <Input
                              aria-label="Revocation reason"
                              className="h-8 w-56"
                              value={revokeReasons[grant.id] ?? ''}
                              onChange={event =>
                                setRevokeReasons(values => ({
                                  ...values,
                                  [grant.id]: event.target.value,
                                }))
                              }
                              placeholder="Revocation reason"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                revoke.isPending ||
                                (revokeReasons[grant.id] ?? '').trim().length < 10
                              }
                              onClick={() =>
                                revoke.mutate({
                                  grantId: grant.id,
                                  reason: (revokeReasons[grant.id] ?? '').trim(),
                                })
                              }
                            >
                              Revoke
                            </Button>
                          </div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending write approvals</CardTitle>
          <CardDescription>
            A write request can be approved by another holder of the support-access permission or a
            superadmin, never by its requester.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.error && (
            <p className="text-muted-foreground text-sm">
              Approval list unavailable: {pending.error.message}
            </p>
          )}
          {pending.data?.length === 0 && (
            <p className="text-muted-foreground text-sm">No pending write requests.</p>
          )}
          {pending.data && pending.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.data.map(grant => (
                  <TableRow key={grant.id}>
                    <OrganizationCell id={grant.organizationId} name={grant.organizationName} />
                    <PersonCell person={grant.actor} />
                    <TableCell className="max-w-80 truncate">{grant.reason}</TableCell>
                    <TableCell>{formatDate(grant.requestedAt)}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={
                            approve.isPending ||
                            !viewerIdentityKnown ||
                            grant.actorKiloUserId === currentUserId
                          }
                          onClick={() => approve.mutate({ grantId: grant.id })}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            deny.isPending ||
                            !viewerIdentityKnown ||
                            grant.actorKiloUserId === currentUserId
                          }
                          onClick={() => deny.mutate({ grantId: grant.id })}
                        >
                          Deny
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active support access</CardTitle>
          <CardDescription>Grants currently valid across customer organizations.</CardDescription>
        </CardHeader>
        <CardContent>
          {active.error && (
            <p className="text-muted-foreground text-sm">
              Active list unavailable: {active.error.message}
            </p>
          )}
          {active.data?.length === 0 && (
            <p className="text-muted-foreground text-sm">No active support grants.</p>
          )}
          {active.data && active.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Holder</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {active.data.map(grant => (
                  <TableRow key={grant.id}>
                    <OrganizationCell id={grant.organizationId} name={grant.organizationName} />
                    <PersonCell person={grant.actor} />
                    <TableCell>{grant.actionClass}</TableCell>
                    <TableCell>{formatDate(grant.expiresAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Emergency access (superadmin)</CardTitle>
          <CardDescription>
            Issues a 15-minute write grant immediately. Every emergency grant requires a later
            review by a different superadmin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="support-emergency-reason">
              Reason (at least {SUPPORT_REASON_MIN_LENGTH} characters)
            </Label>
            <p className="text-muted-foreground text-xs">
              Uses the organization selected under Request access
              {organization ? `: ${organization.name}` : ''}.
            </p>
            <Textarea
              id="support-emergency-reason"
              value={emergencyReason}
              onChange={event => setEmergencyReason(event.target.value)}
              rows={2}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Button
              variant="destructive"
              className="self-start"
              aria-describedby={
                missingEmergencyRequirements.length > 0 ? 'support-emergency-missing' : undefined
              }
              disabled={emergency.isPending || missingEmergencyRequirements.length > 0}
              onClick={() =>
                emergency.mutate({
                  organizationId,
                  reason: emergencyReason.trim(),
                  ticketReference: ticketReference.trim() || undefined,
                })
              }
            >
              Issue emergency write access
            </Button>
            {missingEmergencyRequirements.length > 0 && (
              <ul
                id="support-emergency-missing"
                className="text-muted-foreground list-disc pl-5 text-xs"
              >
                {missingEmergencyRequirements.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>
          {emergencies.error && (
            <p className="text-muted-foreground text-sm">
              Review queue unavailable: {emergencies.error.message}
            </p>
          )}
          {emergencies.data && emergencies.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Holder</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {emergencies.data.map(grant => (
                  <TableRow key={grant.id}>
                    <OrganizationCell id={grant.organizationId} name={grant.organizationName} />
                    <PersonCell person={grant.actor} />
                    <TableCell>{formatDate(grant.issuedAt)}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          review.isPending ||
                          !viewerIdentityKnown ||
                          grant.actorKiloUserId === currentUserId
                        }
                        onClick={() => review.mutate({ grantId: grant.id })}
                      >
                        Mark reviewed
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
