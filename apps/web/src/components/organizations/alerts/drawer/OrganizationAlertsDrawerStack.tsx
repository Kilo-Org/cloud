'use client';

import type { ReactNode } from 'react';
import { createDrawerStack } from '@/components/drawer';
import { AlertEditorPanel } from './AlertEditorPanel';
import type { OrganizationAlertsDrawerRef } from './types';

const { DrawerStackProvider: BaseProvider, useDrawerStack } =
  createDrawerStack<OrganizationAlertsDrawerRef>();

export { useDrawerStack as useOrganizationAlertsDrawerStack };

export function OrganizationAlertsDrawerStackProvider({
  children,
  organizationId,
  canExpand,
}: {
  children: ReactNode;
  organizationId: string;
  /** Whether the organization may still create, enable, or expand alerts. */
  canExpand: boolean;
}) {
  return (
    <BaseProvider
      renderContent={(entry, helpers) => ({
        header: (
          <h2 className="type-body font-medium">
            {entry.type === 'alert-create' ? 'New alert' : 'Edit alert'}
          </h2>
        ),
        body: (
          <AlertEditorPanel
            organizationId={organizationId}
            canExpand={canExpand}
            entry={entry}
            helpers={helpers}
          />
        ),
      })}
    >
      {children}
    </BaseProvider>
  );
}
