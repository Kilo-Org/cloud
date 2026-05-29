'use client';

import { TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useRouter } from 'next/navigation';
import { formatMicrodollars } from '@/lib/admin-utils';
import type { AdminOrganizationSchema } from '@/types/admin';
import type { z } from 'zod';
import { ExternalLink } from 'lucide-react';
import type { TableVariant } from './OrganizationTableHeader';

type AdminOrganization = z.infer<typeof AdminOrganizationSchema>;

const STRIPE_STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  past_due: 'bg-yellow-100 text-yellow-800',
  canceled: 'bg-red-100 text-red-800',
  ended: 'bg-gray-100 text-gray-700',
  incomplete: 'bg-orange-100 text-orange-800',
  incomplete_expired: 'bg-red-100 text-red-700',
  trialing: 'bg-blue-100 text-blue-800',
  unpaid: 'bg-red-100 text-red-800',
  paused: 'bg-purple-100 text-purple-800',
};

function StripeStatusBadge({ status }: { status: string }) {
  const style = STRIPE_STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-700';
  const label = status.replace(/_/g, ' ');
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${style}`}
    >
      {label}
    </span>
  );
}

function FeaturePill({ active, label }: { active: boolean; label: string }) {
  if (!active) return null;
  return (
    <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
      {label}
    </span>
  );
}

function IntegrationPill({ active, label }: { active: boolean; label: string }) {
  if (!active) return null;
  return (
    <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
      {label}
    </span>
  );
}

function PillGroup({ activeCount, children }: { activeCount: number; children: React.ReactNode }) {
  if (activeCount === 0) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  return <div className="flex flex-wrap gap-1">{children}</div>;
}

function LinksCell({ organization }: { organization: AdminOrganization }) {
  return (
    <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
      {organization.stripe_customer_id && (
        <a
          href={`https://dashboard.stripe.com/customers/${organization.stripe_customer_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 transition-colors hover:bg-violet-200"
          title="View in Stripe"
        >
          Stripe
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      <a
        href={`https://app.usepylon.com/conversations?search=${encodeURIComponent(organization.name)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-md bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 transition-colors hover:bg-blue-200"
        title="View in Pylon"
      >
        Pylon
        <ExternalLink className="h-3 w-3" />
      </a>
      <a
        href={`/organizations/${organization.id}`}
        target="_blank"
        className="inline-flex items-center rounded-md bg-blue-100 px-3 py-1 text-xs font-medium text-blue-800 transition-colors hover:bg-blue-200"
        title="View Org"
        onClick={e => e.stopPropagation()}
      >
        View Org
      </a>
    </div>
  );
}

type OrganizationTableBodyProps = {
  variant: TableVariant;
  organizations: AdminOrganization[];
  isLoading: boolean;
  searchTerm?: string;
  showDeleted?: boolean;
};

function getColumnCount(variant: TableVariant, showDeleted?: boolean) {
  const base = variant === 'entitlements' ? 6 : 9;
  return showDeleted ? base + 1 : base;
}

function EntitlementsRow({
  organization,
  showDeleted,
}: {
  organization: AdminOrganization;
  showDeleted?: boolean;
}) {
  return (
    <>
      <TableCell className="min-w-40 font-medium">
        <span>{organization.name}</span>
      </TableCell>
      <TableCell>
        {organization.plan ? (
          <Badge variant="secondary" className="capitalize">
            {organization.plan}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-sm">-</span>
        )}
      </TableCell>
      <TableCell>
        {organization.kilo_pass_tier ? (
          <span className="text-sm font-medium capitalize">
            {organization.kilo_pass_tier.replace(/_/g, ' ')}
          </span>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        )}
      </TableCell>
      <TableCell>
        {organization.latest_stripe_status ? (
          <StripeStatusBadge status={organization.latest_stripe_status} />
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        )}
      </TableCell>
      <TableCell className="min-w-28">
        {organization.subscription_amount_usd ? (
          <span className="font-mono text-sm">
            ${organization.subscription_amount_usd.toFixed(2)}
          </span>
        ) : (
          <span className="text-muted-foreground text-sm">-</span>
        )}
      </TableCell>
      <TableCell>
        <LinksCell organization={organization} />
      </TableCell>
      {showDeleted && (
        <TableCell>
          <span className="text-muted-foreground text-sm">
            {organization.deleted_at ? 'Yes' : 'No'}
          </span>
        </TableCell>
      )}
    </>
  );
}

function UsageRow({
  organization,
  showDeleted,
}: {
  organization: AdminOrganization;
  showDeleted?: boolean;
}) {
  return (
    <>
      <TableCell className="min-w-40 font-medium">
        <span>{organization.name}</span>
      </TableCell>
      <TableCell className="min-w-28">
        <span className="font-mono text-sm">
          {formatMicrodollars(organization.microdollars_used)}
        </span>
      </TableCell>
      <TableCell className="min-w-28">
        <span className="font-mono text-sm">
          {formatMicrodollars(
            organization.total_microdollars_acquired - organization.microdollars_used
          )}
        </span>
      </TableCell>
      <TableCell className="min-w-28">
        <span className="text-sm tabular-nums">
          <span className="font-medium">{organization.member_count}</span>
          {organization.seat_count > 0 && (
            <span className="text-muted-foreground"> / {organization.seat_count}</span>
          )}
        </span>
      </TableCell>
      <TableCell>
        <PillGroup
          activeCount={
            (organization.has_sso_configured ? 1 : 0) +
            (organization.has_provider_controls ? 1 : 0) +
            (organization.has_data_privacy ? 1 : 0)
          }
        >
          <FeaturePill active={organization.has_sso_configured} label="SSO" />
          <FeaturePill active={organization.has_provider_controls} label="P/M Controls" />
          <FeaturePill active={organization.has_data_privacy} label="Data Privacy" />
        </PillGroup>
      </TableCell>
      <TableCell>
        <PillGroup
          activeCount={
            (organization.has_github_integration ? 1 : 0) +
            (organization.has_gitlab_integration ? 1 : 0) +
            (organization.has_slack_integration ? 1 : 0)
          }
        >
          <IntegrationPill active={organization.has_github_integration} label="GitHub" />
          <IntegrationPill active={organization.has_gitlab_integration} label="GitLab" />
          <IntegrationPill active={organization.has_slack_integration} label="Slack" />
        </PillGroup>
      </TableCell>
      <TableCell>
        <span className="text-sm tabular-nums font-medium">{organization.kiloclaw_count}</span>
      </TableCell>
      <TableCell>
        {organization.auto_top_up_enabled ? (
          <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
            On
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            Off
          </span>
        )}
      </TableCell>
      <TableCell>
        <LinksCell organization={organization} />
      </TableCell>
      {showDeleted && (
        <TableCell>
          <span className="text-muted-foreground text-sm">
            {organization.deleted_at ? 'Yes' : 'No'}
          </span>
        </TableCell>
      )}
    </>
  );
}

export function OrganizationTableBody({
  variant,
  organizations,
  isLoading,
  searchTerm,
  showDeleted,
}: OrganizationTableBodyProps) {
  const router = useRouter();
  const colSpan = getColumnCount(variant, showDeleted);

  const handleRowClick = (organizationId: string) => {
    router.push(`/admin/organizations/${encodeURIComponent(organizationId)}`);
  };

  if (isLoading) {
    return (
      <TableBody>
        {Array.from({ length: 10 }).map((_, index) => (
          <TableRow key={index}>
            {Array.from({ length: colSpan }).map((__, ci) => (
              <TableCell key={ci}>
                <Skeleton className="h-4 w-[80px]" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    );
  }

  if (organizations.length === 0) {
    const message = searchTerm
      ? `No organizations found matching "${searchTerm}".`
      : 'No organizations found.';

    return (
      <TableBody>
        <TableRow>
          <TableCell colSpan={colSpan} className="h-24 text-center">
            <div className="flex flex-col items-center gap-2">
              <p className="text-muted-foreground">{message}</p>
              {searchTerm && (
                <p className="text-muted-foreground text-sm">
                  Try adjusting your search terms or clear the search to see all organizations.
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    );
  }

  return (
    <TableBody>
      {organizations.map(organization => (
        <TableRow
          key={organization.id}
          className="hover:bg-muted/50 cursor-pointer transition-colors"
          onClick={() => handleRowClick(organization.id)}
        >
          {variant === 'entitlements' ? (
            <EntitlementsRow organization={organization} showDeleted={showDeleted} />
          ) : (
            <UsageRow organization={organization} showDeleted={showDeleted} />
          )}
        </TableRow>
      ))}
    </TableBody>
  );
}
