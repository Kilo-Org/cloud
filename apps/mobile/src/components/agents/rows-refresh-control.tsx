import { Platform, type RefreshControlProps, useWindowDimensions } from 'react-native';

import { RefreshControl } from '@/components/ui/refresh-control';

import { rowsRefreshIndicatorParkOffset } from './refresh-indicator';

/**
 * Pull-to-refresh control for a rows list, whose first row starts at the top
 * edge of the scrollable.
 *
 * The platform's own indicator is kept where it is inset in the scroll content
 * (`nativeRefreshIndicatorIsInset`) — iOS — where it is the surface's in-flight
 * indicator and cannot cover a row. Where it is not — Android — the platform
 * would draw its disc over the first row, so it is parked off the rows
 * (`rowsRefreshIndicatorParkOffset`) and the reserved status band above the
 * rows carries the in-flight state instead (`SessionListRefreshStatus`, device
 * defect uxs1). The list keeps scrolling throughout, and the pull gesture still
 * reaches `onRefresh`.
 *
 * On Android React Native clones this element with the ScrollView's layout
 * `style` and hands it the ScrollView as its `children` (the control wraps the
 * scrollable there), so both must be forwarded or the list never mounts.
 */
export function RowsRefreshControl({ refreshing, ...props }: Readonly<RefreshControlProps>) {
  const { height } = useWindowDimensions();
  const parkOffset = rowsRefreshIndicatorParkOffset(Platform.OS, height);

  return <RefreshControl {...props} refreshing={refreshing} progressViewOffset={parkOffset} />;
}
