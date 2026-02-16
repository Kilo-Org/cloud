'use client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { BooleanBadge } from '@/components/ui/boolean-badge';
import {
  useUpdateOrganizationName,
  useUpdateCompanyDomain,
  useOrganizationWithMembers,
  useAdminToggleCodeIndexing,
  useUpdateSuppressTrialMessaging,
} from '@/app/api/organizations/hooks';
import type { OrganizationWithMembers } from '@/lib/organizations/organization-types';
import { normalizeCompanyDomain, isValidDomain } from '@/lib/organizations/company-domain';
import { ErrorCard } from '@/components/ErrorCard';
import { LoadingCard } from '@/components/LoadingCard';
import { AnimatedDollars } from './AnimatedDollars';
import { useState } from 'react';
import {
  Edit,
  Check,
  X,
  PiggyBank,
  Building2,
  ExternalLink,
  Bell,
  Plus,
  Clock,
} from 'lucide-react';
import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import BuyOrganizationCreditsDialog from '@/components/payment/BuyOrganizationCreditsDialog';
import { SeatsRequirementDialog } from '@/app/admin/components/OrganizationAdmin/SeatsRequirementDialog';
import { PlanDialog } from '@/app/admin/components/OrganizationAdmin/PlanDialog';
import { TrialEndDateDialog } from '@/app/admin/components/OrganizationAdmin/TrialEndDateDialog';
import { OssSponsorshipDialog } from '@/app/admin/components/OrganizationAdmin/OssSponsorshipDialog';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { formatDollars, formatIsoDateTime_IsoOrderNoSeconds, fromMicrodollars } from '@/lib/utils';
import { SpendingAlertsModal } from './SpendingAlertsModal';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useExpiringCredits } from './useExpiringCredits';

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// OSS Tier names: 1 = Premier, 2 = Growth, 3 = Seed
const OSS_TIER_NAMES: Record<number, string> = {
  1: 'Premier',
  2: 'Growth',
  3: 'Seed',
};

function useCanManagePaymentInfo() {
  const isKiloAdmin = useIsKiloAdmin();
  const orgRole = useUserOrganizationRole();
  return isKiloAdmin || orgRole === 'owner' || orgRole === 'billing_manager';
}

type InnerProps = {
  info: OrganizationWithMembers;
  className?: string;
  showAdminControls: boolean;
};
function Inner(props: InnerProps) {
  const { info, className, showAdminControls } = props;
  const {
    id,
    name,
    created_at,
    updated_at,
    total_microdollars_acquired,
    microdollars_used,
    stripe_customer_id,
    deleted_at,
    auto_top_up_enabled,
  } = info;

  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(name);
  const [isEditingDomain, setIsEditingDomain] = useState(false);
  const [editedDomain, setEditedDomain] = useState(info.company_domain ?? '');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [seatsDialogOpen, setSeatsDialogOpen] = useState(false);
  const [pendingSeatsValue, setPendingSeatsValue] = useState<boolean | null>(null);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [trialEndDateDialogOpen, setTrialEndDateDialogOpen] = useState(false);
  const [isSpendingAlertsModalOpen, setIsSpendingAlertsModalOpen] = useState(false);
  const [ossSponsorshipDialogOpen, setOssSponsorshipDialogOpen] = useState(false);
  const updateOrganizationName = useUpdateOrganizationName();
  const updateCompanyDomain = useUpdateCompanyDomain();
  const adminToggleCodeIndexing = useAdminToggleCodeIndexing();
  const updateSuppressTrialMessaging = useUpdateSuppressTrialMessaging();

  const { expiringBlocks, expiring_mUsd, earliestExpiry } = useExpiringCredits(id);

  const handleSave = async () => {
    if (editedName.trim() === name) {
      setIsEditing(false);
      return;
    }

    try {
      await updateOrganizationName.mutateAsync({
        organizationId: id,
        name: editedName.trim(),
      });
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to update organization name:', error);
      // Reset to original name on error
      setEditedName(name);
    }
  };

  const handleCancel = () => {
    setEditedName(name);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  const handleDomainSave = async () => {
    setDomainError(null);
    const normalized = normalizeCompanyDomain(editedDomain);

    if (normalized === (info.company_domain ?? null)) {
      setEditedDomain(info.company_domain ?? '');
      setIsEditingDomain(false);
      return;
    }

    if (normalized && !isValidDomain(normalized)) {
      setDomainError('Please enter a valid domain (e.g. acme.com)');
      return;
    }

    try {
      await updateCompanyDomain.mutateAsync({
        organizationId: id,
        company_domain: normalized,
      });
      setEditedDomain(normalized ?? '');
      setIsEditingDomain(false);
    } catch (error) {
      console.error('Failed to update company domain:', error);
      setEditedDomain(info.company_domain ?? '');
    }
  };

  const handleDomainCancel = () => {
    setEditedDomain(info.company_domain ?? '');
    setDomainError(null);
    setIsEditingDomain(false);
  };

  const handleDomainKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleDomainSave();
    } else if (e.key === 'Escape') {
      handleDomainCancel();
    }
  };

  const isKiloAdmin = useIsKiloAdmin();
  const isInAdminDashboard = isKiloAdmin && showAdminControls;
  const isOrgOwner = useCanManagePaymentInfo();

  const handleSeatsRequirementEdit = () => {
    setPendingSeatsValue(!info.require_seats);
    setSeatsDialogOpen(true);
  };

  const handlePlanEdit = () => {
    setPlanDialogOpen(true);
  };

  const handleTrialEndDateEdit = () => {
    setTrialEndDateDialogOpen(true);
  };

  const handleCodeIndexingToggle = async () => {
    try {
      await adminToggleCodeIndexing.mutateAsync({
        organizationId: id,
        code_indexing_enabled: !info.settings?.code_indexing_enabled,
      });
    } catch (error) {
      console.error('Failed to toggle code indexing:', error);
    }
  };

  const handleSuppressTrialMessagingToggle = async () => {
    try {
      await updateSuppressTrialMessaging.mutateAsync({
        organizationId: id,
        suppress_trial_messaging: !info.settings?.suppress_trial_messaging,
      });
    } catch (error) {
      console.error('Failed to toggle suppress trial messaging:', error);
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>
          <Building2 className="mr-2 inline h-5 w-5" />
          Organization Information
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-muted-foreground text-sm font-medium">Name</label>
          {isEditing ? (
            <div className="mt-1 flex items-center gap-2">
              <Input
                value={editedName}
                onChange={e => setEditedName(e.target.value)}
                onKeyDown={handleKeyDown}
                className="text-lg font-semibold"
                autoFocus
                disabled={updateOrganizationName.isPending}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={handleSave}
                disabled={updateOrganizationName.isPending || !editedName.trim()}
                className="h-8 w-8 p-0"
              >
                <Check className="h-4 w-4 text-green-400" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancel}
                disabled={updateOrganizationName.isPending}
                className="h-8 w-8 p-0"
              >
                <X className="h-4 w-4 text-red-400" />
              </Button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <p className="text-lg font-semibold">{name}</p>
              {isOrgOwner && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
                  title="Edit organization name"
                >
                  <Edit className="text-muted-foreground hover:text-foreground h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="text-muted-foreground text-sm font-medium">Company Domain</label>
          {isEditingDomain ? (
            <div className="mt-1">
              <div className="flex items-center gap-2">
                <Input
                  value={editedDomain}
                  onChange={e => {
                    setEditedDomain(e.target.value);
                    setDomainError(null);
                  }}
                  onKeyDown={handleDomainKeyDown}
                  className={`text-lg font-semibold ${domainError ? 'border-red-400' : ''}`}
                  autoFocus
                  placeholder="e.g. acme.com"
                  disabled={updateCompanyDomain.isPending}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDomainSave}
                  disabled={updateCompanyDomain.isPending}
                  className="h-8 w-8 p-0"
                >
                  <Check className="h-4 w-4 text-green-400" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDomainCancel}
                  disabled={updateCompanyDomain.isPending}
                  className="h-8 w-8 p-0"
                >
                  <X className="h-4 w-4 text-red-400" />
                </Button>
              </div>
              {domainError && <p className="mt-1 text-sm text-red-400">{domainError}</p>}
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <p className="text-lg font-semibold">
                {info.company_domain || (
                  <span className="text-muted-foreground text-sm">Not set</span>
                )}
              </p>
              {isOrgOwner && (
                <button
                  onClick={() => setIsEditingDomain(true)}
                  className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
                  title="Edit company domain"
                >
                  <Edit className="text-muted-foreground hover:text-foreground h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
        {isOrgOwner && (
          <div>
            <span className="text-muted-foreground text-sm font-medium">
              <PiggyBank className="mr-1 inline h-4 w-4" />
              Balance
            </span>{' '}
            <div className="mt-1 flex items-center gap-2">
              <AnimatedDollars
                dollars={fromMicrodollars(total_microdollars_acquired - microdollars_used)}
                className="text-2xl font-semibold"
              />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setIsSpendingAlertsModalOpen(true)}
                      className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
                    >
                      <Bell className="text-muted-foreground hover:text-foreground h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Configure Low Balance Alert</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {auto_top_up_enabled && isKiloAdmin && (
                <Link
                  href={`/organizations/${id}/payment-details`}
                  className="text-muted-foreground hover:text-foreground text-sm hover:underline"
                >
                  Auto Top-up: On
                </Link>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <BuyOrganizationCreditsDialog organizationId={id} />
              <Button variant="outline" className="whitespace-nowrap">
                <Link href={`/organizations/${id}/payment-details`}>View Billing</Link>
              </Button>
            </div>
            {expiringBlocks.length > 0 && earliestExpiry && (
              <div className="mt-2 flex items-center gap-1 text-sm text-amber-600">
                <Clock className="h-3.5 w-3.5" />
                {formatDollars(fromMicrodollars(expiring_mUsd))} expiring at{' '}
                {formatIsoDateTime_IsoOrderNoSeconds(earliestExpiry)}
              </div>
            )}
          </div>
        )}
        {isInAdminDashboard && (
          <>
            <div>
              <label className="text-muted-foreground text-sm font-medium">Quick Actions</label>
              <div className="mt-1">
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/organizations/${id}`} target="_blank">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    View Organization Page
                  </Link>
                </Button>
              </div>
            </div>
            {stripe_customer_id && (
              <div>
                <label className="text-muted-foreground text-sm font-medium">
                  Stripe Customer ID
                </label>
                <p className="font-mono text-sm">
                  {stripe_customer_id}
                  <a
                    href={`https://dashboard.stripe.com/${process.env.NODE_ENV === 'development' ? 'test/' : ''}customers/${stripe_customer_id}`}
                    target="_blank"
                    className="ml-1 inline-flex items-center rounded-full bg-purple-900 px-2 py-1 text-xs font-medium text-purple-200 transition-colors hover:bg-purple-800"
                    onClick={e => e.stopPropagation()}
                  >
                    View in Stripe
                  </a>
                </p>
              </div>
            )}
            <div>
              <label className="text-muted-foreground text-sm font-medium">Seats Required</label>
              <div className="mt-1 flex items-center gap-2">
                <BooleanBadge positive={info.require_seats}>
                  {info.require_seats ? 'Yes' : 'No'}
                </BooleanBadge>
                <button
                  onClick={handleSeatsRequirementEdit}
                  className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
                  title="Edit seats requirement"
                >
                  <Edit className="text-muted-foreground hover:text-foreground h-4 w-4" />
                </button>
              </div>
            </div>
            <div>
              <label className="text-muted-foreground text-sm font-medium">Plan</label>
              <div className="mt-1 flex items-center gap-2">
                {info.plan ? (
                  <Badge variant="secondary" className="capitalize">
                    {info.plan}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground text-sm">Not set</span>
                )}
                <button
                  onClick={handlePlanEdit}
                  className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
                  title="Edit plan"
                >
                  <Edit className="text-muted-foreground hover:text-foreground h-4 w-4" />
                </button>
              </div>
            </div>
            <div>
              <label className="text-muted-foreground text-sm font-medium">Managed Indexing</label>
              <div className="mt-1 flex items-center gap-2">
                <BooleanBadge positive={info.settings?.code_indexing_enabled ?? false}>
                  {info.settings?.code_indexing_enabled ? 'Enabled' : 'Disabled'}
                </BooleanBadge>
                <button
                  onClick={handleCodeIndexingToggle}
                  disabled={adminToggleCodeIndexing.isPending}
                  className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  title="Toggle code indexing"
                >
                  <Edit className="text-muted-foreground hover:text-foreground h-4 w-4" />
                </button>
              </div>
            </div>
            <div>
              <label className="text-muted-foreground text-sm font-medium">
                Suppress Trial Messaging
              </label>
              <div className="mt-1 flex items-center gap-2">
                <BooleanBadge positive={info.settings?.suppress_trial_messaging ?? false}>
                  {info.settings?.suppress_trial_messaging ? 'Suppressed' : 'Showing'}
                </BooleanBadge>
                <button
                  onClick={handleSuppressTrialMessagingToggle}
                  disabled={updateSuppressTrialMessaging.isPending}
                  className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  title="Toggle trial messaging suppression"
                >
                  <Edit className="text-muted-foreground hover:text-foreground h-4 w-4" />
                </button>
              </div>
            </div>
            <div>
              <label className="text-muted-foreground text-sm font-medium">
                OSS Sponsorship Program
              </label>
              <div className="mt-1 flex items-center gap-2">
                {info.settings?.oss_sponsorship_tier ? (
                  <>
                    <Badge className="bg-green-500/20 text-green-400">
                      {OSS_TIER_NAMES[info.settings.oss_sponsorship_tier] ||
                        `Tier ${info.settings.oss_sponsorship_tier}`}
                    </Badge>
                    {info.settings.oss_monthly_credit_amount_microdollars !== null &&
                      info.settings.oss_monthly_credit_amount_microdollars !== undefined &&
                      info.settings.oss_monthly_credit_amount_microdollars > 0 && (
                        <span className="text-muted-foreground text-sm">
                          $
                          {(
                            info.settings.oss_monthly_credit_amount_microdollars / 1_000_000
                          ).toFixed(0)}
                          /mo
                        </span>
                      )}
                  </>
                ) : (
                  <>
                    <Badge variant="secondary">Not enrolled</Badge>
                    <button
                      onClick={() => setOssSponsorshipDialogOpen(true)}
                      className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
                      title="Enable OSS sponsorship"
                    >
                      <Plus className="text-muted-foreground hover:text-foreground h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            </div>
            <div>
              <label className="text-muted-foreground text-sm font-medium">Created</label>
              <p className="text-sm">{formatDate(created_at)}</p>
            </div>
            <div>
              <label className="text-muted-foreground text-sm font-medium">Last Updated</label>
              <p className="text-sm">{formatDate(updated_at)}</p>
            </div>
            <div>
              <label className="text-muted-foreground text-sm font-medium">Trial Ends at</label>
              <div className="mt-1 flex items-center gap-2">
                <p className="text-sm">
                  {info.free_trial_end_at ? formatDate(info.free_trial_end_at) : 'Not set'}
                </p>
                <button
                  onClick={handleTrialEndDateEdit}
                  className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
                  title="Edit trial end date"
                >
                  <Edit className="text-muted-foreground hover:text-foreground h-4 w-4" />
                </button>
              </div>
            </div>
            {deleted_at && (
              <div>
                <label className="text-muted-foreground text-sm font-medium">Deleted</label>
                <p className="text-sm text-red-600">{formatDate(deleted_at)}</p>
              </div>
            )}
            <SeatsRequirementDialog
              organizationId={id}
              open={seatsDialogOpen}
              onOpenChange={setSeatsDialogOpen}
              pendingValue={pendingSeatsValue}
            />
            <PlanDialog
              organizationId={id}
              open={planDialogOpen}
              onOpenChange={setPlanDialogOpen}
              currentPlan={info.plan}
            />
            <TrialEndDateDialog
              organizationId={id}
              open={trialEndDateDialogOpen}
              onOpenChange={setTrialEndDateDialogOpen}
              currentTrialEndAt={info.free_trial_end_at ?? null}
            />
            <OssSponsorshipDialog
              organizationId={id}
              organizationName={name}
              open={ossSponsorshipDialogOpen}
              onOpenChange={setOssSponsorshipDialogOpen}
            />
          </>
        )}
      </CardContent>
      <SpendingAlertsModal
        open={isSpendingAlertsModalOpen}
        onOpenChange={setIsSpendingAlertsModalOpen}
        organizationId={id}
        settings={info.settings}
      />
    </Card>
  );
}

type Props = {
  organizationId: string;
  className?: string;
  showAdminControls?: boolean;
};
export function OrganizationInfoCard({
  organizationId,
  className,
  showAdminControls = false,
}: Props) {
  const { data, isLoading, error, refetch } = useOrganizationWithMembers(organizationId);

  if (isLoading) {
    const loadingCard = (
      <LoadingCard
        title="Organization Information"
        description="Loading organization details..."
        rowCount={3}
      />
    );
    return className ? <div className={className}>{loadingCard}</div> : loadingCard;
  }

  if (error) {
    const errorCard = (
      <ErrorCard
        title="Organization Information"
        description="Error loading organization details"
        error={error}
        onRetry={() => refetch()}
      />
    );
    return className ? <div className={className}>{errorCard}</div> : errorCard;
  }

  if (!data) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Organization Information</CardTitle>
          <CardDescription>Organization not found</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">No organization data available</p>
        </CardContent>
      </Card>
    );
  }

  return <Inner info={data} className={className} showAdminControls={showAdminControls} />;
}
