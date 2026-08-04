import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  type ClipboardImageFile,
  hasClipboardImage,
  readClipboardImageFile,
} from './clipboard-image';

type UseClipboardImageHintOptions = {
  /** When false, the hint is never visible. Reuse each composer's existing
   *  "can add an attachment" expression so the hint follows pick-parity rules. */
  enabled: boolean;
  /** Called with the written cache file; the composer's upload pipeline owns
   *  every toast from this point on. */
  addFile: (file: ClipboardImageFile) => Promise<void>;
  /** Called when the clipboard read failed (empty, denied, or unsupported type).
   *  The caller supplies its own unreadable-toast copy to match that composer's
   *  existing pick-path message. */
  onUnreadable: () => void;
};

type UseClipboardImageHintReturn = {
  /** Whether the hint should be rendered. `enabled && hasImage`. */
  visible: boolean;
  /** Probe the clipboard and show the hint when an image is present.
   *  Call this on input focus. */
  refresh: () => void;
  /** Read the clipboard image, write a cache file, and route it through
   *  `addFile`. Hides the hint on entry; only a subsequent refresh can show
   *  it again. Guards against a double tap with a synchronous ref. */
  paste: () => void;
};

export function useClipboardImageHint(
  options: UseClipboardImageHintOptions
): UseClipboardImageHintReturn {
  const [hasImage, setHasImage] = useState(false);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Hold callbacks in refs so callers do not need to memoize them and no
  // effect re-subscribes when a parent re-renders.
  const addFileRef = useRef(options.addFile);
  const onUnreadableRef = useRef(options.onUnreadable);
  useEffect(() => {
    addFileRef.current = options.addFile;
    onUnreadableRef.current = options.onUnreadable;
  });

  const inFlightRef = useRef(false);
  // Epoch guards against a stale refresh that started before paste()
  // and resolves after paste() hid the hint. Each refresh() call captures
  // the current epoch; paste() increments it, invalidating prior refreshes.
  const refreshEpochRef = useRef(0);
  // Guards against re-showing a consumed image. Set to true after a
  // successful clipboard read. Cleared only when a probe finds no image,
  // so a later new clipboard image can show.
  const consumedRef = useRef(false);
  // Guards against a mid-paste refresh re-showing the hint. Set to true
  // before paste's async read and cleared in finally. A refresh that
  // starts after paste() entry sees this flag and stays hidden.
  const suppressVisibilityRef = useRef(false);

  const refresh = useCallback(() => {
    refreshEpochRef.current += 1;
    const epoch = refreshEpochRef.current;
    const run = async () => {
      try {
        const has = await hasClipboardImage();
        if (!isMountedRef.current) {
          return;
        }
        if (refreshEpochRef.current !== epoch) {
          return;
        }
        if (!has) {
          // No image on clipboard: clear the consumed guard so a later
          // newly copied image can show.
          consumedRef.current = false;
        }
        setHasImage(has && !consumedRef.current && !suppressVisibilityRef.current);
      } catch {
        if (!isMountedRef.current) {
          return;
        }
        if (refreshEpochRef.current !== epoch) {
          return;
        }
        setHasImage(false);
      }
    };
    void run();
  }, []);

  const paste = useCallback(() => {
    const run = async () => {
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      // Suppress any concurrent refresh from re-showing the hint while
      // the clipboard read is in flight.
      suppressVisibilityRef.current = true;
      // Advance epoch so any refresh that started before this paste is
      // discarded when it resolves.
      refreshEpochRef.current += 1;
      setHasImage(false);
      try {
        const file = await readClipboardImageFile();
        if (!file) {
          onUnreadableRef.current();
          return;
        }
        // The clipboard image was read: mark it consumed so a later
        // refresh (from a focus event caused by this paste) cannot
        // re-show the hint for this same clipboard content.
        consumedRef.current = true;
        await addFileRef.current(file);
      } catch {
        // addFile rejection absorbed; the composer's upload pipeline owns
        // every toast for this path.
      } finally {
        inFlightRef.current = false;
        suppressVisibilityRef.current = false;
      }
    };
    void run();
  }, []);

  // Foreground probe.
  useEffect(() => {
    const handleChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        refresh();
      }
    };
    const subscription = AppState.addEventListener('change', handleChange);
    return () => {
      subscription.remove();
    };
  }, [refresh]);

  const visible = options.enabled && hasImage;

  return useMemo(() => ({ visible, refresh, paste }), [visible, refresh, paste]);
}
