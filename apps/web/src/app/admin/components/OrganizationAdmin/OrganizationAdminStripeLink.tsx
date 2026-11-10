'use client';

import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminOrganizationDetails } from '@/app/admin/api/organizations/hooks';

export function stripeCustomerDashboardUrl(stripeCustomerId: string): string {
  const mode = process.env.NODE_ENV === 'development' ? 'test/' : '';
  return `https://dashboard.stripe.com/${mode}customers/${encodeURIComponent(stripeCustomerId)}`;
}

export function OrganizationAdminStripeLink({ organizationId }: { organizationId: string }) {
  const { data } = useAdminOrganizationDetails(organizationId);
  const stripeCustomerId = data?.stripe_customer_id;
  if (!stripeCustomerId) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stripe</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm">{stripeCustomerId}</span>
        <a
          href={stripeCustomerDashboardUrl(stripeCustomerId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full bg-purple-900 px-2 py-1 text-xs font-medium text-purple-200 transition-colors hover:bg-purple-800"
        >
          View in Stripe
          <ExternalLink className="h-3 w-3" />
        </a>
      </CardContent>
    </Card>
  );
}
