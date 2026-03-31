'use client';

import React, { type ComponentType } from 'react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { Card, CardContent } from '@/components/ui/card';

type StatusQueryLike = {
  data: KiloClawDashboardStatus | undefined;
  isLoading: boolean;
  error: unknown;
};

export type { StatusQueryLike };

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}

type SetupProps = {
  isNewSetup: boolean;
  onNewSetupChange: (v: boolean) => void;
};

type WithStatusProp = {
  status: KiloClawDashboardStatus | undefined;
  organizationId?: string;
} & SetupProps;

export function withStatusQueryBoundary(Component: ComponentType<WithStatusProp>) {
  return function StatusBoundary({
    statusQuery,
    organizationId,
    ...setupProps
  }: { statusQuery: StatusQueryLike; organizationId?: string } & SetupProps) {
    if (statusQuery.isLoading) {
      return (
        <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">Loading...</p>
            </CardContent>
          </Card>
        </div>
      );
    }

    if (statusQuery.error) {
      return (
        <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-red-600">Failed to load: {formatError(statusQuery.error)}</p>
            </CardContent>
          </Card>
        </div>
      );
    }

    return <Component status={statusQuery.data} organizationId={organizationId} {...setupProps} />;
  };
}
