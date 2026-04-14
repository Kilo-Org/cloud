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

type WithStatusProp = {
  status: KiloClawDashboardStatus | undefined;
  organizationId?: string;
};

export function withStatusQueryBoundary<P extends WithStatusProp>(Component: ComponentType<P>) {
  return function StatusBoundary(
    props: Omit<P, keyof WithStatusProp> & {
      statusQuery: StatusQueryLike;
      organizationId?: string;
    }
  ) {
    const { statusQuery, organizationId, ...componentPropsWithoutStatus } = props;

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

    const componentProps = {
      ...componentPropsWithoutStatus,
      status: statusQuery.data,
      organizationId,
    } as unknown as P;

    return <Component {...componentProps} />;
  };
}
