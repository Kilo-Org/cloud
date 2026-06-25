'use client';

import Link from 'next/link';
import { Building2, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useOrganizationChildren } from '@/app/api/organizations/hooks';

type Props = {
  organizationId: string;
};

export function OrganizationChildOrganizationsCard({ organizationId }: Props) {
  const { data: children } = useOrganizationChildren(organizationId);

  // Only show the card when there is at least one child organization. While
  // loading, on error, or when empty, render nothing so the layout stays clean.
  if (!children || children.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Building2 className="mr-2 inline h-5 w-5" />
          Child Organizations
        </CardTitle>
        <CardDescription>
          {children.length} child organization{children.length === 1 ? '' : 's'} belong to this
          organization
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-0.5">
          {children.map(child => (
            <Link
              key={child.id}
              prefetch={false}
              href={`/organizations/${encodeURIComponent(child.id)}`}
              className="hover:bg-surface-hover focus-visible:ring-ring -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:ring-1 focus-visible:outline-none"
            >
              <span className="truncate font-medium" title={child.name}>
                {child.name}
              </span>
              <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
