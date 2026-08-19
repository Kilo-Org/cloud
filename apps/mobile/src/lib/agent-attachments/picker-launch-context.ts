import * as SecureStore from 'expo-secure-store';

import { PICKER_LAUNCH_CONTEXT_KEY } from '@/lib/storage-keys';

export type PickerLaunchContext = {
  userId: string;
  surface: 'agent-new' | 'agent-chat';
  sessionId: string | null;
  launchedAt: number;
};

/** Persist the launching composer + account before the picker opens. */
export async function writePickerLaunchContext(context: PickerLaunchContext): Promise<void> {
  await SecureStore.setItemAsync(PICKER_LAUNCH_CONTEXT_KEY, JSON.stringify(context));
}

/** Read and parse the stored context. Returns `null` on absence or a bad shape. */
export async function readPickerLaunchContext(): Promise<PickerLaunchContext | null> {
  try {
    const raw = await SecureStore.getItemAsync(PICKER_LAUNCH_CONTEXT_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PickerLaunchContext>;
    if (
      typeof parsed.userId !== 'string' ||
      (parsed.surface !== 'agent-new' && parsed.surface !== 'agent-chat') ||
      (parsed.sessionId !== null && typeof parsed.sessionId !== 'string') ||
      typeof parsed.launchedAt !== 'number'
    ) {
      return null;
    }
    return parsed as PickerLaunchContext;
  } catch {
    return null;
  }
}

/** Remove the stored context once it has been consumed or discarded. */
export async function clearPickerLaunchContext(): Promise<void> {
  await SecureStore.deleteItemAsync(PICKER_LAUNCH_CONTEXT_KEY);
}
