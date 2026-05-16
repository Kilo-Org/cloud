import type { DrawerRenderResult, DrawerStackHelpers } from '@/components/drawer';
import type { WastelandDrawerRef } from './types';
import { WantedItemPanel } from './WantedItemPanel';
import { WantedItemByIdPanel } from './WantedItemByIdPanel';
import { ReviewItemPanel, reviewItemHeader } from './ReviewItemPanel';
import { RigPanel } from './RigPanel';

export function renderWastelandDrawerContent(
  entry: WastelandDrawerRef,
  helpers: DrawerStackHelpers<WastelandDrawerRef>
): DrawerRenderResult {
  switch (entry.type) {
    case 'wanted-item':
      return (
        <WantedItemPanel
          wastelandId={entry.wastelandId}
          item={entry.item}
          actions={entry.actions}
          push={helpers.push}
          initialTab={entry.initialTab}
        />
      );
    case 'wanted-item-by-id':
      return (
        <WantedItemByIdPanel
          wastelandId={entry.wastelandId}
          itemId={entry.itemId}
          push={helpers.push}
          initialTab={entry.initialTab}
        />
      );
    case 'review-item':
      return {
        // The review kind + PR id are known from the ref, so the primitive
        // renders them inline with the close button rather than stacking
        // them in the body.
        header: reviewItemHeader(entry.item),
        body: (
          <ReviewItemPanel
            wastelandId={entry.wastelandId}
            item={entry.item}
            actions={entry.actions}
            push={helpers.push}
          />
        ),
      };
    case 'rig':
      return <RigPanel wastelandId={entry.wastelandId} handle={entry.handle} push={helpers.push} />;
  }
}
