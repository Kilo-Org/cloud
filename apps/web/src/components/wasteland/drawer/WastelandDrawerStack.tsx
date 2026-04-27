'use client';

import type { ReactNode } from 'react';
import { createDrawerStack, type DrawerStackRenderContent } from '@/components/drawer';
import type { WastelandDrawerRef } from './types';

const { DrawerStackProvider: BaseProvider, useDrawerStack: useBase } =
  createDrawerStack<WastelandDrawerRef>();

export const useDrawerStack = useBase;

export function DrawerStackProvider({
  children,
  renderContent,
}: {
  children: ReactNode;
  renderContent: DrawerStackRenderContent<WastelandDrawerRef>;
}) {
  return (
    <BaseProvider renderContent={renderContent} width={620}>
      {children}
    </BaseProvider>
  );
}
