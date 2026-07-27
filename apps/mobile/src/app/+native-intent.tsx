import { getShareExtensionKey } from 'expo-share-intent';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  let shareKey: string | null = null;
  try {
    shareKey = getShareExtensionKey();
  } catch {
    shareKey = null;
  }
  if (shareKey && path.includes(`dataUrl=${shareKey}`)) {
    // Cold start: boot the app normally. Warm: stay exactly where the user is.
    return initial ? '/' : null;
  }
  return path;
}
