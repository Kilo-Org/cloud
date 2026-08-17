import type * as ImagePicker from 'expo-image-picker';

import { announcingToast } from '@/lib/a11y/announcing-toast';

export const IMAGE_PICKER_OPTIONS = {
  mediaTypes: ['images'],
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;

/**
 * Run a camera / photo-library launch and return the picked assets, or an
 * empty list when the user cancels or the native launch fails.
 *
 * On Android, expo-image-picker registers its `ActivityResultLauncher` once,
 * when the module is created, while expo-modules-core unregisters that key on
 * the launching Activity's `ON_DESTROY`
 * (`AppContextActivityResultRegistry.register`). The module keeps the stale
 * launcher, so after any Activity recreation every launch rejects with
 * "Attempting to launch an unregistered ActivityResultLauncher" until the
 * process restarts. No JS API can re-register it, so tell the user how to
 * recover instead of rejecting into an unhandled promise and attaching
 * nothing. expo-document-picker uses `startActivityForResult` and is not
 * affected. Upstream: https://github.com/expo/expo/issues/41252
 *
 * `launch` is the in-flight promise, not a thunk: both picker entry points are
 * `async` wrappers, so a native failure always arrives as a rejection.
 */
export async function launchImagePicker(
  launch: Promise<ImagePicker.ImagePickerResult>
): Promise<ImagePicker.ImagePickerAsset[]> {
  try {
    const result = await launch;
    return result.canceled ? [] : result.assets;
  } catch {
    announcingToast.error('Could not open the photo picker. Restart Kilo and try again.');
    return [];
  }
}
