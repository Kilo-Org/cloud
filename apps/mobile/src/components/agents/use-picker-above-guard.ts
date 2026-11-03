import { useNavigation, usePreventRemove, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { isLeaveAction } from '@/lib/navigation/leave-actions';
import { pickerRouteOnTop } from '@/lib/picker-routes';

export function usePickerRouteOnTop(): boolean {
  const navigation = useNavigation();
  const [pickerOpen, setPickerOpen] = useState(() => pickerRouteOnTop(navigation.getState()));

  useEffect(() => {
    const sync = () => {
      setPickerOpen(pickerRouteOnTop(navigation.getState()));
    };
    const unsubscribe = navigation.addListener('state', sync);
    sync();
    return unsubscribe;
  }, [navigation]);

  return pickerOpen;
}

/**
 * Android can deliver Back to the screen under an opening picker sheet.
 * Guard only while that picker is in the stack, leaving normal Back native.
 */
export function usePickerAboveLeaveGuard(): void {
  const navigation = useNavigation();
  const router = useRouter();
  const pickerOpen = usePickerRouteOnTop();
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);

  usePreventRemove(pickerOpen && !leaveAllowed, ({ data, repeat }) => {
    if (isLeaveAction(data.action.type) && pickerRouteOnTop(navigation.getState())) {
      router.back();
      return;
    }
    pendingLeaveRef.current = repeat;
    setLeaveAllowed(true);
  });

  useEffect(() => {
    if (!leaveAllowed) {
      return;
    }
    const replay = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    replay?.();
  }, [leaveAllowed]);
}
