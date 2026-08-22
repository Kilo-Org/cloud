import { Platform, View } from 'react-native';

import {
  type ChildSessionSheetMountState,
  shouldShowChildSessionDismissLayer,
} from './child-session-sheet-state';

export function ChildSessionDismissLayer({
  state,
}: Readonly<{ state: ChildSessionSheetMountState }>) {
  if (!shouldShowChildSessionDismissLayer(state, Platform.OS)) {
    return null;
  }
  return (
    <View className="absolute inset-0 bg-background" testID="child-session-sheet-dismiss-layer" />
  );
}
