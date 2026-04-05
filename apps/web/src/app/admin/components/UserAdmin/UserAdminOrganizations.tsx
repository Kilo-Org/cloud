'use client';

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
import Link from 'next/link';
import type { UserDetailProps } from '@/types/admin';
import { formatDate } from 'date-fns';

type OrganizationMembershipsProps = Pick<UserDetailProps, 'organization_memberships'>;

export function UserAdminOrganizations({ organization_memberships }: OrganizationMembershipsProps) {
  if (organization_memberships.length === 0) {
    return (
      <Card className="col-span-1 lg:col-span-2">
        <CardHeader>
          <CardTitle>Organizations</CardTitle>
          <CardDescription>User is not a member of any organizations</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="col-span-1 lg:col-span-2">
      <CardHeader>
        <CardTitle>Organizations</CardTitle>
        <CardDescription>
          Organizations where this user is a member ({organization_memberships.length})
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Organization Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined At</TableHead>
              <TableHead>Plan</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {organization_memberships.map(({ membership, organization }) => {
              const organizationDetailUrl = `/admin/organizations/${organization.id}`;

              return (
                <TableRow
                  key={membership.id}
                  className="hover:bg-muted/50 group relative transition-colors"
                >
                  <TableCell>
                    <Link href={organizationDetailUrl} className="block h-full w-full py-1">
                      {organization.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={organizationDetailUrl} className="block h-full w-full py-1">
                      <Badge variant={membership.role === 'owner' ? 'default' : 'secondary'}>
                        {membership.role}
                      </Badge>
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <Link href={organizationDetailUrl} className="block h-full w-full py-1">
                      {formatDate(new Date(membership.joined_at), 'MMM d, yyyy')}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={organizationDetailUrl} className="block h-full w-full py-1">
                      <Badge variant="outline">{organization.plan}</Badge>
                    </Link>
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
