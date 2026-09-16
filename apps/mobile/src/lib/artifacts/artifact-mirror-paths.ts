import { Directory, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * Where the read-only artifact mirror lives.
 *
 * The app writes the mirror; the phone's file browser reads it. That reader is
 * a *separate process* on both platforms, and each platform only exposes one
 * container to it:
 *
 * - iOS: the File Provider extension can only reach an app group container, so
 *   the mirror goes into {@link ARTIFACT_APP_GROUP_ID}. There is deliberately
 *   no Documents-directory fallback: a fallback would write files that nothing
 *   can browse, which is worse than an empty location.
 * - Android: the DocumentsProvider is served in-process from
 *   `context.filesDir`, which is `Paths.document`.
 *
 * This is the feature's only `Platform.OS` branch. It is a hard platform
 * constraint, not a preference: iOS has no in-process provider, Android has no
 * app group, so the two platforms cannot share a directory.
 */

/** App group the iOS File Provider extension reads. Must match the entitlement. */
export const ARTIFACT_APP_GROUP_ID = 'group.com.kilocode.kiloapp';

/** Folder inside the browsable container that holds the mirror. */
export const ARTIFACT_MIRROR_DIR_NAME = 'artifacts';

/**
 * Root of the mirror, whether or not it exists yet. `null` means this device
 * has no browsable container (iOS without the app group entitlement), so there
 * is nowhere to mirror into.
 */
export function artifactMirrorRoot(): Directory | null {
  if (Platform.OS === 'ios') {
    const container = Paths.appleSharedContainers[ARTIFACT_APP_GROUP_ID];
    if (!container) {
      return null;
    }
    return new Directory(container, ARTIFACT_MIRROR_DIR_NAME);
  }
  return new Directory(Paths.document, ARTIFACT_MIRROR_DIR_NAME);
}
