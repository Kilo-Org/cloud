import { useCallback, useEffect } from 'react';
import { Alert } from 'react-native';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import {
  hasStagedShareId,
  SHARE_TO_NEW_REMOTE_SESSION_ALERT,
  shouldBlockRemoteRunOnSelection,
} from '@/lib/share-to-new-remote-session';

type UseShareAwareRunOnChangeArgs = {
  /** Current route shareId — drives the arrival-reset effect only. */
  shareId: string | undefined;
  /**
   * One-way latch for this screen mount: true once a share was staged,
   * even after prefill clears the route param.
   */
  isShareStaged: () => boolean;
  runOnInstance: InstancePickerInstance | null;
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
};

/**
 * Blocks selecting a remote "Run on" target while a share is staged, and
 * silently resets an already-selected remote target when a share arrives so
 * NewSessionPrompt (with prefill) can render.
 */
export function useShareAwareRunOnChange({
  shareId,
  isShareStaged,
  runOnInstance,
  onChangeRunOnInstance,
}: UseShareAwareRunOnChangeArgs): (next: InstancePickerInstance | null) => void {
  const handleRunOnInstanceChange = useCallback(
    (next: InstancePickerInstance | null) => {
      // A newly spawned remote session cannot receive shared content;
      // keep Cloud Agent selected and explain why. Uses the mount latch so
      // the block still applies after prefill clears the route param.
      if (shouldBlockRemoteRunOnSelection(isShareStaged(), next)) {
        Alert.alert(
          SHARE_TO_NEW_REMOTE_SESSION_ALERT.title,
          SHARE_TO_NEW_REMOTE_SESSION_ALERT.message
        );
        return;
      }
      onChangeRunOnInstance(next);
    },
    [isShareStaged, onChangeRunOnInstance]
  );

  // Share arrived while a remote instance was already selected: reset to
  // Cloud Agent so NewSessionPrompt (with prefill) renders. Silent by design —
  // the visible swap to the prefilled composer is the feedback. Uses the live
  // route param (not the latch) so this only fires on actual share arrival.
  useEffect(() => {
    if (hasStagedShareId(shareId) && runOnInstance !== null) {
      handleRunOnInstanceChange(null);
    }
  }, [shareId, runOnInstance, handleRunOnInstanceChange]);

  return handleRunOnInstanceChange;
}
