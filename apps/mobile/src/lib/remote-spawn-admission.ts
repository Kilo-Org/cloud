import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { type SharePayload } from '@/lib/share-payload';

export const REMOTE_SPAWN_FILES_NOT_SUPPORTED_TOAST = 'This instance cannot receive files.';

export function resolveRemoteSpawnAdmission(input: {
  instance: InstancePickerInstance;
  payload: SharePayload | null;
}): { allowed: true } | { allowed: false; toast: string } {
  const { payload, instance } = input;
  if (payload === null) {
    return { allowed: true };
  }
  if (payload.files.length > 0 && instance.capabilities?.attachments !== true) {
    return { allowed: false, toast: REMOTE_SPAWN_FILES_NOT_SUPPORTED_TOAST };
  }

  return { allowed: true };
}
