import { Card, CardContent } from '@/components/ui/card';
import { Building2, Users, PiggyBank } from 'lucide-react';
import { NewOrganizationButton } from '@/components/organizations/new/NewOrganizationButton';
import { OrganizationsList } from './OrganizationsList';
import type { OrganizationCardOrg } from '@/components/organizations/OrganizationCard';

export function NoOrganizationsState() {
  const canMakeOrgs = true;
  // Create fake organizations for preview
  const fakeOrganizations: OrganizationCardOrg[] = [
    {
      organizationId: 'fake-org-1',
      organizationName: 'Acme Corporation',
      role: 'owner',
      memberCount: 8,
      created_at: new Date(2025, 10, 10).toISOString(),
      balance: 12750000, // $127.50 in microdollars
      seatCount: {
        used: 6,
        total: 10,
      },
    },
    {
      organizationId: 'fake-org-2',
      organizationName: 'Tech Innovators Inc',
      role: 'member',
      memberCount: 15,
      created_at: new Date(2025, 9, 10).toISOString(),
      balance: 0, // Members don't see balance
      seatCount: {
        used: 12,
        total: 20,
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="mb-2 text-2xl font-semibold">
          You&apos;re not part of any organizations yet
        </h2>
      </div>

      <div className="mx-auto max-w-4xl">
        <Card className="border-primary/20">
          <CardContent className="p-8 text-center">
            <h3 className="mb-6 text-xl font-semibold">Scale with Kilo Code Teams</h3>

            <div className="mb-8 grid gap-6 text-left md:grid-cols-3">
              <div className="bg-primary/5 rounded-lg p-4">
                <div className="bg-primary/10 mb-3 flex h-10 w-10 items-center justify-center rounded-lg">
                  <Building2 className="text-primary h-5 w-5" />
                </div>
                <h4 className="mb-2 font-semibold">Organization Controls</h4>
                <p className="text-muted-foreground text-sm">
                  Manage permissions, agent modes, and control model access across your
                  organization.
                </p>
              </div>
              <div className="bg-primary/5 rounded-lg p-4">
                <div className="bg-primary/10 mb-3 flex h-10 w-10 items-center justify-center rounded-lg">
                  <Users className="text-primary h-5 w-5" />
                </div>
                <h4 className="mb-2 font-semibold">Usage Insights</h4>
                <p className="text-muted-foreground text-sm">
                  Per-user & project analytics and organization productivity metrics to optimize AI
                  usage.
                </p>
              </div>
              <div className="bg-primary/5 rounded-lg p-4">
                <div className="bg-primary/10 mb-3 flex h-10 w-10 items-center justify-center rounded-lg">
                  <PiggyBank className="text-primary h-5 w-5" />
                </div>
                <h4 className="mb-2 font-semibold">Consolidated Billing</h4>
                <p className="text-muted-foreground text-sm">Centralized billing and invoicing.</p>
              </div>
            </div>

            {canMakeOrgs ? (
              <div>
                <p className="mb-4 text-center">
                  Take Kilo on a free 14-day test drive for your team
                </p>
                <div className="flex justify-center">
                  <NewOrganizationButton />
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground mb-4">
                <a
                  href="mailto:hi@kilocode.ai"
                  className="text-primary hover:text-primary/80 font-medium underline"
                >
                  Contact our support team
                </a>{' '}
                to set up your organization
              </p>
            )}
          </CardContent>
        </Card>

        <p className="text-muted-foreground m-4 text-sm">
          When you join an organization, you&apos;ll see them listed like this:
        </p>
        <div className="relative">
          <div className="pointer-events-none" style={{ filter: 'blur(1px)' }}>
            <OrganizationsList orgs={fakeOrganizations} />
          </div>
        </div>
      </div>
    </div>
  );
}
