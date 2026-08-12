'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  useSubOrganizationCredits,
  useSubOrganizationModelPolicy,
  useSubOrganizationOverview,
  useSubOrganizationPeople,
  useSubOrganizationPermissions,
} from '@/app/api/organizations/hooks';
import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import {
  defaultGranularityForPeriod,
  EMPTY_FILTERS,
  periodToDateRange,
  useUsageBreakdown,
} from '@/components/usage-analytics/hooks';
import { PERIOD_LABELS, type PeriodOption } from '@/components/usage-analytics/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CreditsSection,
  ModelsSection,
  OverviewSection,
  PeopleSection,
  PermissionsSection,
  SectionState,
  UsageSection,
  type UsageByOrganization,
} from './SubOrganizationSections';
import { DistributeFundsPage } from './distribute-funds/DistributeFundsPage';
import { isSubOrganizationSection, type SubOrganizationSection } from './sections';

function toMetricMap(
  breakdown: Array<{ key: string; value: number }> | undefined
): Map<string, number> {
  return new Map(breakdown?.map(row => [row.key, row.value]) ?? []);
}

export function SubOrganizationsPage({
  organizationId,
  activeSection,
}: {
  organizationId: string;
  activeSection: SubOrganizationSection;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [period, setPeriod] = useState<PeriodOption>('30d');
  const [thirtyDayRange] = useState(() => periodToDateRange('30d'));
  const overview = useSubOrganizationOverview(organizationId);
  const children = overview.data?.children ?? [];
  const childIds = useMemo(() => children.map(child => child.id), [children]);
  const hasChildren = childIds.length > 0;

  const thirtyDaySpend = useUsageBreakdown({
    organizationId: null,
    organizationIds: childIds,
    dateRange: thirtyDayRange,
    granularity: 'day',
    costSource: 'cost',
    filters: EMPTY_FILTERS,
    dimension: 'organization',
    metric: 'cost',
    limit: Math.max(1, childIds.length),
    enabled: hasChildren,
  });

  const peopleFilters = useMemo<Parameters<typeof useSubOrganizationPeople>[1]>(() => {
    const role = searchParams.get('role');
    const status = searchParams.get('status');
    const assignment = searchParams.get('assignment');
    const sort = searchParams.get('sort');
    const page = Number(searchParams.get('page'));
    const subOrganizationId = searchParams.get('subOrganization');
    return {
      search: searchParams.get('search') || undefined,
      subOrganizationId:
        subOrganizationId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(subOrganizationId)
          ? subOrganizationId
          : undefined,
      role:
        role === 'owner' || role === 'admin' || role === 'billing_manager' || role === 'member'
          ? role
          : undefined,
      status: status === 'accepted' || status === 'pending' ? status : undefined,
      assignment: assignment === 'assigned' || assignment === 'unassigned' ? assignment : undefined,
      sortBy: sort === 'parentRole' || sort === 'membershipCount' ? sort : ('identity' as const),
      sortDirection:
        searchParams.get('direction') === 'desc' ? ('desc' as const) : ('asc' as const),
      page: Number.isInteger(page) && page > 0 ? page : 1,
    };
  }, [searchParams]);
  const people = useSubOrganizationPeople(organizationId, peopleFilters, {
    enabled: activeSection === 'people',
  });
  const credits = useSubOrganizationCredits(organizationId, {
    enabled: activeSection === 'credits',
  });
  const models = useSubOrganizationModelPolicy(organizationId, {
    enabled: activeSection === 'models',
  });
  const permissions = useSubOrganizationPermissions(organizationId, {
    enabled: activeSection === 'permissions',
  });

  const selectedDateRange = useMemo(() => periodToDateRange(period), [period]);
  const granularity = defaultGranularityForPeriod(period);
  const usageEnabled = activeSection === 'usage' && hasChildren;
  const usageCost = useUsageBreakdown({
    organizationId: null,
    organizationIds: childIds,
    dateRange: selectedDateRange,
    granularity,
    costSource: 'cost',
    filters: EMPTY_FILTERS,
    dimension: 'organization',
    metric: 'cost',
    limit: Math.max(1, childIds.length),
    enabled: usageEnabled,
  });
  const usageRequests = useUsageBreakdown({
    organizationId: null,
    organizationIds: childIds,
    dateRange: selectedDateRange,
    granularity,
    costSource: 'cost',
    filters: EMPTY_FILTERS,
    dimension: 'organization',
    metric: 'requests',
    limit: Math.max(1, childIds.length),
    enabled: usageEnabled,
  });
  const usageTokens = useUsageBreakdown({
    organizationId: null,
    organizationIds: childIds,
    dateRange: selectedDateRange,
    granularity,
    costSource: 'cost',
    filters: EMPTY_FILTERS,
    dimension: 'organization',
    metric: 'tokens',
    limit: Math.max(1, childIds.length),
    enabled: usageEnabled,
  });

  const thirtyDaySpendByOrganization = useMemo(
    () => toMetricMap(thirtyDaySpend.data?.breakdown),
    [thirtyDaySpend.data?.breakdown]
  );
  const selectedUsage = useMemo<UsageByOrganization>(() => {
    const costs = toMetricMap(usageCost.data?.breakdown);
    const requests = toMetricMap(usageRequests.data?.breakdown);
    const tokens = toMetricMap(usageTokens.data?.breakdown);
    return new Map(
      childIds.map(id => [
        id,
        {
          costMicrodollars: costs.get(id) ?? 0,
          requests: requests.get(id) ?? 0,
          tokens: tokens.get(id) ?? 0,
        },
      ])
    );
  }, [
    childIds,
    usageCost.data?.breakdown,
    usageRequests.data?.breakdown,
    usageTokens.data?.breakdown,
  ]);

  const overviewError = overview.error ?? thirtyDaySpend.error;
  const usageError = usageCost.error ?? usageRequests.error ?? usageTokens.error;
  const usageLoading = usageCost.isLoading || usageRequests.isLoading || usageTokens.isLoading;

  return (
    <div className="flex w-full flex-col gap-y-6">
      <OrganizationPageHeader organizationId={organizationId} title="Sub-organizations" />

      <Tabs
        value={activeSection}
        onValueChange={value => {
          if (!isSubOrganizationSection(value)) return;
          router.push(
            `/organizations/${encodeURIComponent(organizationId)}/sub-organizations/${value}`
          );
        }}
        className="w-full"
      >
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
            <TabsTrigger value="credits">Credits</TabsTrigger>
            <TabsTrigger value="distribute-funds">Distribute funds</TabsTrigger>
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-6">
          <SectionState
            isLoading={overview.isLoading || thirtyDaySpend.isLoading}
            error={overviewError}
          >
            {overview.data && (
              <OverviewSection
                organizationId={organizationId}
                data={overview.data}
                spendByOrganization={thirtyDaySpendByOrganization}
              />
            )}
          </SectionState>
        </TabsContent>

        <TabsContent value="people" className="mt-6">
          <SectionState isLoading={people.isLoading} error={people.error}>
            {people.data && <PeopleSection data={people.data} />}
          </SectionState>
        </TabsContent>

        <TabsContent value="usage" className="mt-6 space-y-4">
          <div className="flex justify-end">
            <Select value={period} onValueChange={value => setPeriod(value as PeriodOption)}>
              <SelectTrigger aria-label="Usage period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PERIOD_LABELS) as PeriodOption[]).map(option => (
                  <SelectItem key={option} value={option}>
                    {PERIOD_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <SectionState isLoading={usageLoading} error={usageError}>
            <UsageSection
              organizationId={organizationId}
              children={children}
              usage={selectedUsage}
              period={period}
              granularity={granularity}
            />
          </SectionState>
        </TabsContent>

        <TabsContent value="credits" className="mt-6">
          <SectionState
            isLoading={credits.isLoading || thirtyDaySpend.isLoading}
            error={credits.error ?? thirtyDaySpend.error}
          >
            {credits.data && (
              <CreditsSection
                organizationId={organizationId}
                data={credits.data}
                thirtyDaySpend={thirtyDaySpendByOrganization}
              />
            )}
          </SectionState>
        </TabsContent>

        <TabsContent value="distribute-funds" className="mt-6">
          <DistributeFundsPage organizationId={organizationId} />
        </TabsContent>

        <TabsContent value="models" className="mt-6">
          <SectionState isLoading={models.isLoading} error={models.error}>
            {models.data && <ModelsSection data={models.data} />}
          </SectionState>
        </TabsContent>

        <TabsContent value="permissions" className="mt-6">
          <SectionState isLoading={permissions.isLoading} error={permissions.error}>
            {permissions.data && <PermissionsSection data={permissions.data} />}
          </SectionState>
        </TabsContent>
      </Tabs>
    </div>
  );
}
