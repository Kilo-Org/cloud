import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Building2, Users, PiggyBank } from 'lucide-react';
import {
  getRoleIcon,
  getRoleBadgeVariant,
  getRoleLabel,
} from '@/lib/organizations/organization-shared-utils';
import { formatMicrodollars } from '@/lib/admin-utils';

export type OrganizationCardOrg = {
  organizationId: string;
  organizationName: string;
  role: string;
  memberCount: number;
  balance: number;
  created_at: string;
  seatCount: {
    used: number;
    total: number;
  };
};

type OrganizationCardProps = {
  org: OrganizationCardOrg;
};

export function OrganizationCard({ org }: OrganizationCardProps) {
  return (
    <Link
      key={org.organizationId}
      prefetch={false}
      href={`/organizations/${encodeURIComponent(org.organizationId)}`}
      className="block"
    >
      <Card className="hover:border-primary/20 transition-shadow duration-200 hover:shadow-md">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="shrink-0">
                <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-lg">
                  <Building2 className="text-primary h-6 w-6" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-3">
                  <h3 className="text-foreground truncate text-lg font-semibold">
                    {org.organizationName}
                  </h3>
                  <Badge
                    variant={getRoleBadgeVariant(org.role)}
                    className="flex items-center gap-1"
                  >
                    {getRoleIcon(org.role)}
                    {getRoleLabel(org.role)}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center gap-4">
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
  );
}
