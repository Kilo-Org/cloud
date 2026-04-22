import type { ReactNode } from 'react';
import type { DrawerStackHelpers } from '@/components/drawer';
import type { WastelandDrawerRef } from './types';
import { WantedItemPanel } from './WantedItemPanel';
import { WantedItemByIdPanel } from './WantedItemByIdPanel';
import { ReviewItemPanel } from './ReviewItemPanel';
import { RigPanel } from './RigPanel';

export function renderWastelandDrawerContent(
  entry: WastelandDrawerRef,
  helpers: DrawerStackHelpers<WastelandDrawerRef>
): ReactNode {
  switch (entry.type) {
    case 'wanted-item':
      return (
        <WantedItemPanel
          wastelandId={entry.wastelandId}
          item={entry.item}
          actions={entry.actions}
          push={helpers.push}
        />
      );
    case 'wanted-item-by-id':
      return (
        <WantedItemByIdPanel
          wastelandId={entry.wastelandId}
          itemId={entry.itemId}
          push={helpers.push}
        />
      );
    case 'review-item':
      return (
        <ReviewItemPanel
          wastelandId={entry.wastelandId}
          item={entry.item}
          actions={entry.actions}
          push={helpers.push}
        />
      );
    case 'rig':
      return <RigPanel wastelandId={entry.wastelandId} handle={entry.handle} push={helpers.push} />;
  }
}
