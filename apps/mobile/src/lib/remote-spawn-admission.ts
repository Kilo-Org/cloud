import { i18n } from '@/i18n';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { type SharePayload } from '@/lib/share-payload';

export const remoteSpawnFilesNotSupportedToast = () =>
  i18n.t('kiloclaw.remoteSpawnFilesNotSupported');

export function resolveRemoteSpawnAdmission(input: {
  instance: InstancePickerInstance;
  payload: SharePayload | null;
}): { allowed: true } | { allowed: false; toast: string } {
  const { payload, instance } = input;
  if (payload === null) {
    return { allowed: true };
  }
  // Optimistic CLI-capability gate: an instance whose `attachments`
  // capability is still unknown (`undefined`) may receive files; only an
  // explicit `attachments: false` blocks the file payload.
  if (payload.files.length > 0 && instance.capabilities?.attachments === false) {
    return { allowed: false, toast: remoteSpawnFilesNotSupportedToast() };
  }

  return { allowed: true };
}
