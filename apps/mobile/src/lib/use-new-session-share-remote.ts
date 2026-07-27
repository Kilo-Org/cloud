import { useCallback } from 'react';
import { toast } from 'sonner-native';

import { useRemoteSpawnDispatch } from '@/components/agents/use-remote-spawn-dispatch';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { SHARE_STAGED_SPAWN_NAVIGATION_CANCELLED_TOAST } from '@/lib/share-to-new-remote-session';
import { useShareAwareRunOnChange } from '@/lib/use-share-aware-run-on-change';
import { useShareStagedLatch } from '@/lib/use-share-staged-latch';

type InstancesRefetch = () => Promise<{
  data: { instances: InstancePickerInstance[] } | undefined;
}>;

type UseNewSessionShareRemoteArgs = {
  shareId: string | undefined;
  organizationId: string | undefined;
  runOnInstance: InstancePickerInstance | null;
  setRunOnInstance: (next: InstancePickerInstance | null) => void;
  refetchInstances: InstancesRefetch;
  instanceList: InstancePickerInstance[];
};

/**
 * Wires share-staged latch, remote spawn dispatch (with mid-spawn cancel),
 * and the share-aware Run-on change handler for the new-session screen.
 */
export function useNewSessionShareRemote({
  shareId,
  organizationId,
  runOnInstance,
  setRunOnInstance,
  refetchInstances,
  instanceList,
}: UseNewSessionShareRemoteArgs) {
  const { isShareStaged, shouldCancelReadyNavigation } = useShareStagedLatch(shareId);

  const handleReadyNavigationCancelled = useCallback(() => {
    toast.error(SHARE_STAGED_SPAWN_NAVIGATION_CANCELLED_TOAST);
  }, []);

  const remoteSpawn = useRemoteSpawnDispatch({
    organizationId,
    runOnInstance,
    setRunOnInstance,
    refetchInstances,
    instanceList,
    shouldCancelReadyNavigation,
    onReadyNavigationCancelled: handleReadyNavigationCancelled,
  });

  const handleRunOnInstanceChange = useShareAwareRunOnChange({
    shareId,
    isShareStaged,
    runOnInstance,
    onChangeRunOnInstance: remoteSpawn.onChangeRunOnInstance,
  });

  return { remoteSpawn, handleRunOnInstanceChange };
}
