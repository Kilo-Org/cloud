'use client';

import type { ReactNode } from 'react';
import {
  createDrawerStack,
  type DrawerStackHelpers,
  type DrawerStackRenderContent,
} from '@/components/drawer';
import type { TownEvent } from './ActivityFeed';
import { COLLAPSED_SIZE, useTerminalBar } from './TerminalBarContext';

// ── Resource types ───────────────────────────────────────────────────────

export type ResourceRef =
  | { type: 'bead'; beadId: string; rigId: string }
  | { type: 'agent'; agentId: string; rigId: string; townId?: string }
  | { type: 'event'; event: TownEvent }
  | { type: 'convoy'; convoyId: string; townId: string };

export type GastownDrawerHelpers = DrawerStackHelpers<ResourceRef>;
export type GastownDrawerRenderContent = DrawerStackRenderContent<ResourceRef>;

const { DrawerStackProvider: BaseProvider, useDrawerStack: useBase } =
  createDrawerStack<ResourceRef>();

export const useDrawerStack = useBase;

/**
 * Gastown's drawer lives alongside the terminal bar. When the terminal is
 * docked on the right edge, shift the drawer inward so it doesn't sit
 * underneath the terminal.
 */
export function DrawerStackProvider({
  children,
  renderContent,
}: {
  children: ReactNode;
  renderContent: GastownDrawerRenderContent;
}) {
  const { position, size, collapsed } = useTerminalBar();
  const rightOffset =
    position === 'right' ? (collapsed ? COLLAPSED_SIZE : COLLAPSED_SIZE + size) : 0;

  return (
    <BaseProvider
      renderContent={renderContent}
      width={620}
      depthOffset={40}
      rightOffset={rightOffset}
    >
      {children}
    </BaseProvider>
  );
}
