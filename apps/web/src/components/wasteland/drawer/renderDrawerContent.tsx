import type { ReactNode } from 'react';
import type { DrawerStackHelpers } from '@/components/drawer';
import type { WastelandDrawerRef } from './types';
import { WantedItemPanel } from './WantedItemPanel';
import { ReviewItemPanel } from './ReviewItemPanel';

export function renderWastelandDrawerContent(
  entry: WastelandDrawerRef,
  _helpers: DrawerStackHelpers<WastelandDrawerRef>
): ReactNode {
  switch (entry.type) {
    case 'wanted-item':
      return <WantedItemPanel item={entry.item} actions={entry.actions} />;
    case 'review-item':
      return <ReviewItemPanel item={entry.item} actions={entry.actions} />;
  }
}
