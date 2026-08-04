'use client';

import Link from 'next/link';
import {
  AlertTriangle,
  ChartColumnIncreasing,
  CreditCard,
  Layers,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useSubOrganizationsOverview } from '@/app/api/organizations/hooks';
import { formatDateOnly } from '@/lib/admin-utils';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';
import { SubOrganizationsSectionPlaceholder } from './SubOrganizationsSectionPlaceholder';

type Props = {
  organizationId: string;
};

function PlanBadge({ plan }: { plan: OrganizationPlan }) {
  return <Badge variant="secondary">{plan === 'enterprise' ? 'Enterprise' : 'Teams'}</Badge>;
}

export function SubOrganizationsPage({ organizationId }: Props) {
  const { data, isLoading, error } = useSubOrganizationsOverview(organizationId);
  const children = data?.children ?? [];

  return (
    <div className="flex w-full flex-col gap-y-6">
      <OrganizationPageHeader
        organizationId={organizationId}
        title="Sub-organizations"
        showBackButton
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Failed to load sub-organizations:{' '}
            {error instanceof Error ? error.message : 'Unknown error'}
          </AlertDescription>
        </Alert>
      ) : isLoading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ) : children.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Sub-organizations</CardTitle>
            <CardDescription>
              This organization does not have any child organizations.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Child organizations</CardTitle>
              <CardDescription>
                {children.length} child organization{children.length === 1 ? '' : 's'} belong to
                this organization
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Members</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {children.map(child => (
                    <TableRow key={child.id}>
                      <TableCell className="font-medium">
                        <Link
                          prefetch={false}
                          href={`/organizations/${encodeURIComponent(child.id)}`}
                          className="hover:text-primary underline-offset-4 hover:underline"
                        >
                          {child.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <PlanBadge plan={child.plan} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {child.memberCount}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateOnly(child.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Dimension sections. Each is a named slot: later convoy beads fill
              the placeholder body without restructuring this layout. */}
          <div className="flex flex-col gap-6">
            <SubOrganizationsSectionPlaceholder
              id="people"
              title="People"
              icon={Users}
              description="Members across every child organization, grouped by child, with each person's role in that child."
            />
            <SubOrganizationsSectionPlaceholder
              id="usage"
              title="Usage"
              icon={ChartColumnIncreasing}
              description="Per-child spend, requests, and tokens for the selected time range, with a deep link into each child's analytics."
            />
            <SubOrganizationsSectionPlaceholder
              id="credits"
              title="Credits"
              icon={CreditCard}
              description="Per-child credit balance, acquired, used, next expiration, and sub-org allocation, with a link to Distribute funds."
            />
            <SubOrganizationsSectionPlaceholder
              id="models"
              title="Models"
              icon={Layers}
              description="Each child's configured model access policy, including whether restrictions are inert due to a non-enterprise plan."
            />
            <SubOrganizationsSectionPlaceholder
              id="permissions"
              title="Permissions"
              icon={ShieldCheck}
              description="Each child's role distribution, SSO policy and its source, per-member spend limits, and inherited parent access."
            />
          </div>
        </>
      )}
    </div>
  );
}
