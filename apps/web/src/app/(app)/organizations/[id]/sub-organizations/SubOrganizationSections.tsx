'use client';

import type { inferRouterOutputs } from '@trpc/server';
import { AlertTriangle, ExternalLink, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { FormEvent } from 'react';

import { CreateSubOrganizationButton } from '@/components/organizations/OrganizationChildOrganizationsCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatMicrodollars } from '@/lib/admin-utils';
import { formatLargeNumber } from '@/lib/utils';
import type { RootRouter } from '@/routers/root-router';
import type { Granularity, PeriodOption } from '@/components/usage-analytics/types';

type Outputs = inferRouterOutputs<RootRouter>;
type Overview = Outputs['organizations']['subOrganizations']['overview'];
type People = Outputs['organizations']['subOrganizations']['people'];
type Credits = Outputs['organizations']['subOrganizations']['credits'];
type ModelPolicy = Outputs['organizations']['subOrganizations']['modelPolicy'];
type Permissions = Outputs['organizations']['subOrganizations']['permissions'];

export type UsageByOrganization = Map<
  string,
  { costMicrodollars: number; requests: number; tokens: number }
>;

function OrganizationLink({ id, name }: { id: string; name: string }) {
  return (
    <Link
      className="text-blue-400 underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
      href={`/organizations/${encodeURIComponent(id)}`}
    >
      {name}
    </Link>
  );
}

export function SectionState({
  isLoading,
  error,
  children,
}: {
  isLoading: boolean;
  error: { message: string } | null;
  children: React.ReactNode;
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertDescription>
          We couldn't load this section. Refresh the page and try again.
        </AlertDescription>
      </Alert>
    );
  }
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }
  return children;
}

export function OverviewSection({
  organizationId,
  data,
  spendByOrganization,
}: {
  organizationId: string;
  data: Overview;
  spendByOrganization: Map<string, number>;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>Organization overview</CardTitle>
          <CardDescription>
            Compare membership, seats, available credits, and 30-day spend across direct
            sub-organizations.
          </CardDescription>
        </div>
        {data.canCreateSubOrganizations && (
          <CreateSubOrganizationButton organizationId={organizationId} />
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {data.children.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No sub-organizations yet. Create one to start managing it separately.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sub-organization</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead className="text-right">Seats</TableHead>
                <TableHead className="text-right">Credit balance</TableHead>
                <TableHead className="text-right">Spend (30 days)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.children.map(child => (
                <TableRow key={child.id}>
                  <TableCell className="font-medium">
                    <OrganizationLink id={child.id} name={child.name} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {child.plan}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{child.memberCount}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {child.requireSeats
                      ? `${child.seatCount.used} / ${child.seatCount.total}`
                      : 'Not required'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMicrodollars(child.balanceMicrodollars)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMicrodollars(spendByOrganization.get(child.id) ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function PeopleSection({ data }: { data: People }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filterKeys = ['search', 'subOrganization', 'role', 'status', 'assignment'] as const;
  const hasFilters = filterKeys.some(key => searchParams.has(key));

  function updateQuery(updates: Record<string, string | null>, preservePage = false) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!preservePage) next.delete('page');
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    updateQuery({ search: String(formData.get('search') ?? '').trim() || null });
  }

  const sortValue = `${searchParams.get('sort') ?? 'identity'}:${searchParams.get('direction') ?? 'asc'}`;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>People by sub-organization</CardTitle>
          <CardDescription>
            Direct memberships remain independent in every organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sub-organization</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead className="text-right">Pending invites</TableHead>
                <TableHead className="text-right">Seats</TableHead>
                <TableHead>Owners</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.children.map(child => (
                <TableRow key={child.id}>
                  <TableCell className="font-medium">{child.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{child.memberCount}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {child.pendingInvitationCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {child.seatCount.used} / {child.seatCount.total}
                  </TableCell>
                  <TableCell className="max-w-64 truncate">
                    {child.owners.map(owner => owner.name).join(', ') || 'No owner'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>
            Parent members, sub-organization members, and pending invitations appear once per
            identity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3">
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={submitSearch}>
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="people-search">Name or email</Label>
                <Input
                  key={searchParams.get('search') ?? ''}
                  id="people-search"
                  name="search"
                  type="search"
                  defaultValue={searchParams.get('search') ?? ''}
                  placeholder="Search people"
                />
              </div>
              <Button type="submit">
                <Search /> Search
              </Button>
            </form>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1.5">
                <Label htmlFor="people-organization">Sub-organization</Label>
                <Select
                  value={searchParams.get('subOrganization') ?? 'all'}
                  onValueChange={value =>
                    updateQuery({ subOrganization: value === 'all' ? null : value })
                  }
                >
                  <SelectTrigger id="people-organization" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sub-organizations</SelectItem>
                    {data.children.map(child => (
                      <SelectItem key={child.id} value={child.id}>
                        {child.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="people-role">Role</Label>
                <Select
                  value={searchParams.get('role') ?? 'all'}
                  onValueChange={value => updateQuery({ role: value === 'all' ? null : value })}
                >
                  <SelectTrigger id="people-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All roles</SelectItem>
                    <SelectItem value="owner">Owner</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="billing_manager">Billing manager</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="people-status">Status</Label>
                <Select
                  value={searchParams.get('status') ?? 'all'}
                  onValueChange={value => updateQuery({ status: value === 'all' ? null : value })}
                >
                  <SelectTrigger id="people-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="accepted">Accepted</SelectItem>
                    <SelectItem value="pending">Pending invitation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="people-assignment">Assignment</Label>
                <Select
                  value={searchParams.get('assignment') ?? 'all'}
                  onValueChange={value =>
                    updateQuery({ assignment: value === 'all' ? null : value })
                  }
                >
                  <SelectTrigger id="people-assignment" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All people</SelectItem>
                    <SelectItem value="assigned">Has sub-organization</SelectItem>
                    <SelectItem value="unassigned">No sub-organization</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="people-sort">Sort</Label>
                <Select
                  value={sortValue}
                  onValueChange={value => {
                    const [sort, direction] = value.split(':');
                    updateQuery({ sort, direction });
                  }}
                >
                  <SelectTrigger id="people-sort" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="identity:asc">Identity, A-Z</SelectItem>
                    <SelectItem value="identity:desc">Identity, Z-A</SelectItem>
                    <SelectItem value="parentRole:asc">Parent role</SelectItem>
                    <SelectItem value="membershipCount:desc">Most memberships</SelectItem>
                    <SelectItem value="membershipCount:asc">Fewest memberships</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {hasFilters && (
              <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
                {filterKeys.flatMap(key => {
                  const value = searchParams.get(key);
                  return value
                    ? [
                        <Button
                          key={key}
                          variant="outline"
                          size="sm"
                          onClick={() => updateQuery({ [key]: null })}
                        >
                          {key === 'subOrganization'
                            ? (data.children.find(child => child.id === value)?.name ?? value)
                            : value.replaceAll('_', ' ')}
                          <X />
                        </Button>,
                      ]
                    : [];
                })}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    updateQuery(Object.fromEntries(filterKeys.map(key => [key, null])))
                  }
                >
                  Clear filters
                </Button>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Parent role</TableHead>
                  <TableHead>Sub-organization memberships</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.people.map(person => (
                  <TableRow key={person.identityKey}>
                    <TableCell className="font-medium">{person.name}</TableCell>
                    <TableCell className="text-muted-foreground">{person.email}</TableCell>
                    <TableCell className="capitalize">
                      {person.parentMembership?.role.replace('_', ' ') ?? 'Not a parent member'}
                    </TableCell>
                    <TableCell className="min-w-72">
                      <div className="flex flex-wrap gap-2">
                        {person.memberships.map(membership => (
                          <Badge key={membership.organizationId} variant="secondary">
                            {membership.organizationName}: {membership.role.replace('_', ' ')}
                          </Badge>
                        ))}
                        {person.memberships.length === 0 && (
                          <span className="text-muted-foreground">No sub-organization</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {person.statuses.map(status => (
                          <Badge
                            key={status}
                            variant={status === 'pending' ? 'outline' : 'secondary'}
                          >
                            {status === 'pending' ? 'Pending invitation' : 'Accepted'}
                          </Badge>
                        ))}
                        {person.invitations.map(invitation => (
                          <span
                            key={`${invitation.organizationId}-${invitation.role}`}
                            className="text-muted-foreground text-xs"
                          >
                            {invitation.organizationName}: {invitation.role.replace('_', ' ')}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {data.people.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground py-10 text-center">
                      No people match the current filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-sm tabular-nums">
              {data.pageInfo.total} {data.pageInfo.total === 1 ? 'person' : 'people'}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={data.pageInfo.page <= 1}
                onClick={() => updateQuery({ page: String(data.pageInfo.page - 1) }, true)}
              >
                Previous
              </Button>
              <span className="text-muted-foreground flex items-center px-2 text-sm tabular-nums">
                Page {data.pageInfo.page} of {Math.max(1, data.pageInfo.pageCount)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={data.pageInfo.page >= data.pageInfo.pageCount}
                onClick={() => updateQuery({ page: String(data.pageInfo.page + 1) }, true)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function usageDetailsHref(
  parentId: string,
  childId: string,
  period: PeriodOption,
  granularity: Granularity
) {
  const params = new URLSearchParams({ scope: childId, period, granularity });
  return `/organizations/${encodeURIComponent(parentId)}/usage-details?${params.toString()}`;
}

export function UsageSection({
  organizationId,
  children,
  usage,
  period,
  granularity,
}: {
  organizationId: string;
  children: Overview['children'];
  usage: UsageByOrganization;
  period: PeriodOption;
  granularity: Granularity;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage by sub-organization</CardTitle>
        <CardDescription>
          Billable usage for the selected period, excluding personal usage.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sub-organization</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Analytics</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {children.map(child => {
              const row = usage.get(child.id) ?? { costMicrodollars: 0, requests: 0, tokens: 0 };
              return (
                <TableRow key={child.id}>
                  <TableCell className="font-medium">{child.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMicrodollars(row.costMicrodollars)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatLargeNumber(row.requests)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatLargeNumber(row.tokens)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={usageDetailsHref(organizationId, child.id, period, granularity)}>
                        View <ExternalLink />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function CreditsSection({
  organizationId,
  data,
  thirtyDaySpend,
}: {
  organizationId: string;
  data: Credits;
  thirtyDaySpend: Map<string, number>;
}) {
  return (
    <div className="space-y-4">
      {data.kiloPassStatus === 'unavailable' && (
        <Alert variant="notice">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Kilo Pass allocation data is temporarily unavailable. Credit balances and usage remain
            current.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Credits and runway</CardTitle>
            <CardDescription>
              Balances are shown after processing due credit expirations.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/organizations/${encodeURIComponent(organizationId)}/sub-organizations/distribute-funds`}
            >
              Distribute funds
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sub-organization</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Acquired</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead>Next expiry</TableHead>
                <TableHead>Auto top-up</TableHead>
                <TableHead className="text-right">Kilo Pass</TableHead>
                <TableHead className="text-right">30-day burn</TableHead>
                <TableHead className="text-right">Runway</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.children.map(child => {
                const spend = thirtyDaySpend.get(child.id) ?? 0;
                const dailyBurn = spend / 30;
                const runway =
                  dailyBurn > 0 ? Math.max(0, child.balanceMicrodollars) / dailyBurn : null;
                const belowMinimum =
                  child.minimumBalanceMicrodollars !== null &&
                  child.balanceMicrodollars < child.minimumBalanceMicrodollars;
                return (
                  <TableRow key={child.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {child.name}
                        {belowMinimum && <Badge variant="destructive">Below minimum</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMicrodollars(child.balanceMicrodollars)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMicrodollars(child.totalMicrodollarsAcquired)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMicrodollars(child.microdollarsUsed)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {child.nextCreditExpirationAt
                        ? new Date(child.nextCreditExpirationAt).toLocaleDateString()
                        : 'None'}
                    </TableCell>
                    <TableCell>{child.autoTopUpEnabled ? 'Enabled' : 'Disabled'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {data.kiloPassStatus === 'unavailable'
                        ? 'Unavailable'
                        : child.kiloPassAllocation
                          ? child.kiloPassAllocation.nextPassCount === null ||
                            child.kiloPassAllocation.nextPassCount ===
                              child.kiloPassAllocation.currentPassCount
                            ? child.kiloPassAllocation.currentPassCount
                            : `${child.kiloPassAllocation.currentPassCount} to ${child.kiloPassAllocation.nextPassCount}`
                          : 'None'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMicrodollars(spend)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {runway === null ? 'No observed burn' : `${Math.floor(runway)} days`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function restrictionList(values: string[] | null, unrestrictedLabel: string) {
  if (values === null) return unrestrictedLabel;
  if (values.length === 0) return 'None';
  return values.join(', ');
}

export function ModelsSection({ data }: { data: ModelPolicy }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="notice">
        <AlertDescription>
          Parent and child model policies are independent. This comparison does not enforce parent
          settings as a ceiling over children.
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>Model policy</CardTitle>
          <CardDescription>
            {data.catalog.status === 'available'
              ? `Divergence uses the current catalog (${data.catalog.distinctModelCount} models).`
              : 'Catalog divergence is unavailable; configured policy is still shown.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sub-organization</TableHead>
                <TableHead>Default model</TableHead>
                <TableHead>Providers</TableHead>
                <TableHead>Denied models</TableHead>
                <TableHead>Default access</TableHead>
                <TableHead>Org Auto</TableHead>
                <TableHead>Groups</TableHead>
                <TableHead>Data collection</TableHead>
                <TableHead>Divergence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.children.map(child => {
                const inactive = child.organizationRestrictions.enforcement === 'inactive_plan';
                const delta = child.divergence?.organizationCeiling;
                return (
                  <TableRow key={child.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-col items-start gap-1">
                        <OrganizationLink id={child.id} name={child.name} />
                        {inactive && <Badge variant="outline">Inactive on Teams</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-48 truncate">
                      {child.defaultModel ?? 'Not set'}
                    </TableCell>
                    <TableCell className="max-w-64 truncate">
                      {restrictionList(
                        child.organizationRestrictions.configured.providerAllowList,
                        'All providers'
                      )}
                    </TableCell>
                    <TableCell className="max-w-64 truncate">
                      {child.organizationRestrictions.configured.modelDenyList.join(', ') || 'None'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      Configured: {child.defaultPolicy.configured?.mode ?? 'not configured'} /
                      Effective: {child.defaultPolicy.effectiveGrant.mode}
                    </TableCell>
                    <TableCell>
                      {child.orgAutoModel
                        ? `${child.orgAutoModel.routeCount} routes / fallback ${child.orgAutoModel.fallbackModel} / ${child.orgAutoModel.status.replaceAll('_', ' ')}`
                        : 'Not configured'}
                    </TableCell>
                    <TableCell className="max-w-72">
                      {child.groupPolicies.groups.length === 0
                        ? 'None'
                        : child.groupPolicies.groups
                            .map(group =>
                              group.modelAccessPolicy?.mode === 'selected'
                                ? `${group.groupName}: selected (${group.modelAccessPolicy.selectedModelCount} models, ${group.modelAccessPolicy.selectedProviderCount} providers)`
                                : `${group.groupName}: ${group.modelAccessPolicy?.mode ?? 'not configured'}`
                            )
                            .join(', ')}
                    </TableCell>
                    <TableCell className="capitalize">
                      {child.dataCollection ?? 'Default'}
                    </TableCell>
                    <TableCell className="min-w-64">
                      {delta ? (
                        <details>
                          <summary className="cursor-pointer text-sm">
                            {delta.models.parentOnly.length} parent-only /{' '}
                            {delta.models.childOnly.length} child-only models
                          </summary>
                          <div className="text-muted-foreground mt-2 space-y-1 text-xs">
                            <p>
                              Parent-only models: {delta.models.parentOnly.join(', ') || 'None'}
                            </p>
                            <p>Child-only models: {delta.models.childOnly.join(', ') || 'None'}</p>
                            <p>
                              Parent-only providers:{' '}
                              {delta.providers.parentOnly.join(', ') || 'None'}
                            </p>
                            <p>
                              Child-only providers: {delta.providers.childOnly.join(', ') || 'None'}
                            </p>
                          </div>
                        </details>
                      ) : (
                        'Unavailable'
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ssoSummary(policy: Permissions['children'][number]['effectiveSsoPolicy']) {
  if (policy.status === 'not_required') return 'Not required';
  if (policy.status === 'misconfigured')
    return `Misconfigured: ${policy.reason.replaceAll('_', ' ')}`;
  return `${policy.domain} (${policy.source.replace('_', ' ')})`;
}

export function PermissionsSection({ data }: { data: Permissions }) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Inherited parent access</CardTitle>
          <CardDescription>
            These parent owners and billing managers can read every direct child without becoming
            child members.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {data.inheritedAccess.users.map(user => (
            <Badge key={user.kiloUserId} variant="secondary">
              {user.name}: {user.parentRole.replace('_', ' ')}
              {user.isBot ? ' / bot' : ''}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Permissions and policy</CardTitle>
          <CardDescription>
            Child ownership, SSO, feature settings, and configured spend limits.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sub-organization</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Configured SSO</TableHead>
                <TableHead>SSO policy</TableHead>
                <TableHead>Company domain</TableHead>
                <TableHead>Features</TableHead>
                <TableHead>Daily spend limits</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.children.map(child => (
                <TableRow key={child.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col items-start gap-1">
                      <OrganizationLink id={child.id} name={child.name} />
                      {!child.hasIndependentOwner && (
                        <Badge variant="destructive">No independent owner</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {child.roleBreakdown.owner} owners / {child.roleBreakdown.billing_manager}{' '}
                    billing / {child.roleBreakdown.member} members
                  </TableCell>
                  <TableCell>{child.ssoDomain ?? 'Not set'}</TableCell>
                  <TableCell className="max-w-72">{ssoSummary(child.effectiveSsoPolicy)}</TableCell>
                  <TableCell>{child.companyDomain ?? 'Not set'}</TableCell>
                  <TableCell className="max-w-72">
                    Usage limits: {child.featureSettings.enableUsageLimits === true ? 'on' : 'off'}{' '}
                    / Indexing: {child.featureSettings.codeIndexingEnabled === true ? 'on' : 'off'}{' '}
                    / Projects: {child.featureSettings.projectsUiEnabled === true ? 'on' : 'off'} /
                    Data: {child.featureSettings.dataCollection ?? 'default'}
                  </TableCell>
                  <TableCell>
                    {child.dailyUserLimits.length === 0
                      ? 'None'
                      : child.dailyUserLimits
                          .map(limit => {
                            const active = limit.enforcedForRole && limit.enforcedForSeatMode;
                            const reason = !limit.enforcedForRole
                              ? 'billing role'
                              : !limit.enforcedForSeatMode
                                ? 'seat mode'
                                : null;
                            return `${limit.name}: ${formatMicrodollars(limit.limitMicrodollars)} (${active ? 'active' : `inactive: ${reason}`})`;
                          })
                          .join(', ')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
