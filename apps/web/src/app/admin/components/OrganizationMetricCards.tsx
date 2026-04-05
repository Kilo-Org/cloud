'use client';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatLargeNumber } from '@/lib/utils';
import { useOrganizationMetrics } from '@/app/admin/api/organizations/metrics/hooks';
import { Building2, Building, Clock } from 'lucide-react';

export function OrganizationMetricCards() {
  const { data, isLoading, error } = useOrganizationMetrics();

  const cards = [
    {
      title: 'Teams',
      count: data?.teamCount ?? 0,
      members: data?.teamMemberCount ?? 0,
      icon: Building2,
    },
    {
      title: 'Trial Teams',
      count: data?.trialingTeamCount ?? 0,
      members: data?.trialingTeamMemberCount ?? 0,
      icon: Clock,
    },
    {
      title: 'Enterprises',
      count: data?.enterpriseCount ?? 0,
      members: data?.enterpriseMemberCount ?? 0,
      icon: Building,
    },
    {
      title: 'Trial Enterprises',
      count: data?.trialingEnterpriseCount ?? 0,
      members: data?.trialingEnterpriseMemberCount ?? 0,
      icon: Clock,
    },
  ];

  if (error) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {cards.map((card, index) => (
          <Card key={index}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
              <div className="flex items-center">
                <card.icon className="mr-2 h-4 w-4" />
                <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              </div>
              <div className="font-bold text-red-600">Error</div>
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card, index) => (
          <Card key={index}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
              <div className="flex items-center">
                <card.icon className="mr-2 h-4 w-4" />
                <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              </div>
              <Skeleton className="h-6 w-24" />
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
      {cards.map((card, index) => (
        <Card key={index}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
            <div className="flex items-center">
              <card.icon className="mr-2 h-4 w-4" />
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            </div>
            <div className="text-sm font-medium">
              <span>{formatLargeNumber(card.count)}</span>
              <span className="text-muted-foreground">
                {' '}
                / {formatLargeNumber(card.members)} members
              </span>
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
