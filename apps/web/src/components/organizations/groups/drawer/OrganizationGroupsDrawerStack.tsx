'use client';

import type { ReactNode } from 'react';
import { createDrawerStack } from '@/components/drawer';
import type { OrganizationGroupsDrawerRef } from './types';
import { renderOrganizationGroupsDrawerContent } from './renderOrganizationGroupsDrawerContent';

const { DrawerStackProvider: BaseProvider, useDrawerStack } =
  createDrawerStack<OrganizationGroupsDrawerRef>();

export { useDrawerStack as useOrganizationGroupsDrawerStack };

export function OrganizationGroupsDrawerStackProvider({
  children,
  organizationId,
}: {
  children: ReactNode;
  organizationId: string;
}) {
  return (
    <BaseProvider
      width={760}
      renderContent={(entry, helpers) =>
        renderOrganizationGroupsDrawerContent(organizationId, entry, helpers)
      }
    >
      {children}
    </BaseProvider>
  );
}
