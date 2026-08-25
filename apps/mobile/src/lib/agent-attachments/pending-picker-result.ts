import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';

// A pending result belongs to one launch. Dedupe by asset URI so a second call
// in the same process cannot add the same asset twice.
const consumedUris = new Set<string>();

/**
 * Consume the Android image-picker result that survived an Activity recreation.
 * Returns `[]` on iOS and for `null`, cancelled, and error results (an error
 * result toasts the existing recovery copy once). Successful assets are
 * deduplicated against a module-level set of already-consumed URIs.
 */
export async function consumeAndroidPendingPickerResult(): Promise<ImagePicker.ImagePickerAsset[]> {
  if (Platform.OS !== 'android') {
    return [];
  }
  let result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null = null;
  try {
    result = await ImagePicker.getPendingResultAsync();
  } catch {
    announcingToast.error(i18n.t('agentChat.attachmentPicker.couldNotOpenPhotoPicker'));
    return [];
  }
  if (result === null) {
    return [];
  }
  if ('code' in result) {
    // Error result: surface the existing recovery copy once.
    announcingToast.error(i18n.t('agentChat.attachmentPicker.couldNotOpenPhotoPicker'));
    return [];
  }
  if (result.canceled) {
    return [];
  }
  const fresh = result.assets.filter(asset => !consumedUris.has(asset.uri));
  for (const asset of fresh) {
    consumedUris.add(asset.uri);
  }
  return fresh;
}

/**
 * Discard a pending Android image-picker result without attaching it. Used when
 * the stored launch context mismatches the current account/surface/session or
 * has expired, so a later launch cannot receive a stale result.
 */
export async function discardAndroidPendingPickerResult(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  try {
    await ImagePicker.getPendingResultAsync();
  } catch {
    // Nothing to discard.
  }
}
