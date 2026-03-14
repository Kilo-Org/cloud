'use client';

import type { ReactNode } from 'react';
import type { ResourceRef } from './DrawerStack';
import { BeadPanel } from './drawer-panels/BeadPanel';
import { AgentPanel } from './drawer-panels/AgentPanel';
import { EventPanel } from './drawer-panels/EventPanel';
import { ConvoyPanel } from './drawer-panels/ConvoyPanel';

/**
 * Dispatch function that maps a ResourceRef to the right panel component.
 * Passed as `renderContent` to DrawerStackProvider.
 */
export function renderDrawerContent(
  resource: ResourceRef,
  helpers: { push: (ref: ResourceRef) => void; close: () => void }
): ReactNode {
  switch (resource.type) {
    case 'bead':
      return <BeadPanel beadId={resource.beadId} rigId={resource.rigId} push={helpers.push} />;
    case 'agent':
      return (
        <AgentPanel
          agentId={resource.agentId}
          rigId={resource.rigId}
          townId={resource.townId}
          push={helpers.push}
          close={helpers.close}
        />
      );
    case 'event':
      return <EventPanel event={resource.event} push={helpers.push} />;
    case 'convoy':
      return (
        <ConvoyPanel convoyId={resource.convoyId} townId={resource.townId} push={helpers.push} />
      );
  }
}
