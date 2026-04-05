import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Users, PiggyBank } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  getRoleIcon,
  getRoleBadgeVariant,
  getRoleLabel,
} from '@/lib/organizations/organization-shared-utils';
import { formatMicrodollars } from '@/lib/admin-utils';
import Link from 'next/link';
import type { UserOrganizationWithSeats } from '@/lib/organizations/organization-types';

type ProfileOrganizationsSectionProps = {
  orgs: UserOrganizationWithSeats[];
};

export function ProfileOrganizationsSection({ orgs }: ProfileOrganizationsSectionProps) {
  return (
    <Card className="w-full rounded-xl shadow-sm">
      {orgs.length > 0 ? (
        <>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Your Organizations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {orgs.map(org => (
              <Link
                key={org.organizationId}
                href={`/organizations/${encodeURIComponent(org.organizationId)}`}
                className="block"
              >
                <Card className="hover:border-primary/20 transition-shadow duration-200 hover:shadow-md">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="shrink-0">
                          <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-lg">
                            <Building2 className="text-primary h-5 w-5" />
                          </div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex items-center gap-3">
                            <h4 className="text-foreground truncate text-lg font-semibold">
                              {org.organizationName}
                            </h4>
                            <Badge
                              variant={getRoleBadgeVariant(org.role)}
                              className="flex items-center gap-1"
                            >
                              {getRoleIcon(org.role)}
                              {getRoleLabel(org.role)}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-muted-foreground flex items-center gap-1 text-sm">
                              <Users className="h-4 w-4" />
                              <span>
                                {org.memberCount} member{org.memberCount !== 1 ? 's' : ''}
                              </span>
                            </div>
                            {org.role === 'owner' && (
                              <div className="text-muted-foreground flex items-center gap-1 text-sm">
                                <PiggyBank className="h-4 w-4" />
                                <span className="font-mono">{formatMicrodollars(org.balance)}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-muted-foreground flex items-center">
                          <span className="text-sm">View details →</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </CardContent>
        </>
      ) : (
        <CardContent className="p-8 text-center">
          <h3 className="text-md mb-2 font-semibold">Invite Team Members</h3>
          <p className="text-muted-foreground mb-6 text-sm">
            Centralized billing. Shared modes. Security you can trust.
          </p>
          <Link
            href="/organizations/new"
            className="focus-visible:ring-ring border-input bg-background relative inline-flex h-9 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-md border px-4 py-2 text-sm font-medium whitespace-nowrap shadow-sm transition-all hover:border-blue-400 hover:bg-gray-900 hover:text-blue-300 hover:shadow-md focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
          >
            Invite your team
          </Link>
        </CardContent>
      )}
    </Card>
  );
}
