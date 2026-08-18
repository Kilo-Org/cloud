import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  type ClipboardImageFile,
  hasClipboardImage,
  hasClipboardUrl,
  readClipboardImageFile,
  readClipboardText,
} from './clipboard-image';

export const CLIPBOARD_PASTE_EMPTY_MESSAGE = 'Nothing to paste';

type UseClipboardPasteOptions = {
  /** Gates `visible` only — `paste` always works. Defaults to true. Pass each
   *  composer's existing "can add an attachment" expression when the caller
   *  renders the image-detected hint, so the hint follows pick-parity rules. */
  enabled?: boolean;
  /** Called with the written cache file; the composer's upload pipeline owns
   *  every toast from this point on. */
  addFile: (file: ClipboardImageFile) => Promise<void>;
  /** Called with the clipboard text when the clipboard holds no readable image.
   *  Supply it wherever the paste control is always present: the user can press
   *  paste with text on the clipboard, and an unreadable-image toast would be
   *  wrong there. Omit it to keep the image-only behavior. */
  addText?: (text: string) => void;
  /** Called when neither an image nor text could be used. `'empty'` means no
   *  image, no readable text, and no URL on the clipboard. `'unreadable'` means
   *  an image or URL was present but the read failed or was denied. A denied
   *  text read is indistinguishable from empty and reports 'empty'. The caller
   *  supplies its own toast copy to match that composer's existing pick-path
   *  message. */
  onFailure: (reason: 'empty' | 'unreadable') => void;
};

type UseClipboardPasteReturn = {
  /** Whether the image-detected hint should be rendered. `enabled && hasImage`.
   *  A caller with an always-present paste button ignores this. */
  visible: boolean;
  /** Probe the clipboard and show the hint when an image is present.
   *  Call this on input focus. Only a `visible` caller needs it. */
  refresh: () => void;
  /** Read the clipboard image, write a cache file, and route it through
   *  `addFile`. With no readable image, route the clipboard text through
   *  `addText` when the caller supplied it. Hides the hint on entry; only a
   *  subsequent refresh can show it again. Guards against a double tap with a
   *  synchronous ref. */
  paste: () => void;
};

/**
 * Clipboard paste for the composers. `paste` prefers an image — a composer that
 * takes attachments should attach a copied screenshot — and falls back to the
 * clipboard text when the caller supplies `addText`. `visible` and `refresh`
 * serve the older image-detected hint row, which only kilo-chat still renders.
 */
export function useClipboardPaste(options: UseClipboardPasteOptions): UseClipboardPasteReturn {
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
  const addTextRef = useRef(options.addText);
  const onFailureRef = useRef(options.onFailure);
  useEffect(() => {
    addFileRef.current = options.addFile;
    addTextRef.current = options.addText;
    onFailureRef.current = options.onFailure;
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
        // Image first: a composer that takes attachments should attach a
        // copied screenshot, not paste its file path. `hasClipboardImage`
        // inspects only the content type, so a text clipboard reaches the text
        // path without the image read that would raise a second iOS 16 paste
        // prompt for content that is not there.
        const clipboardHasImage = await hasClipboardImage();
        const file = clipboardHasImage ? await readClipboardImageFile() : null;
        if (!file) {
          // No readable image. A caller with an always-present paste control
          // accepts text, so a text clipboard pastes instead of toasting.
          //
          // This path leaves `consumedRef` alone on purpose. That flag
          // suppresses the hint for an image already read, and an unreadable
          // image must stay retryable: the user can grant the permission or
          // copy the image again.
          const addText = addTextRef.current;
          if (addText) {
            const text = await readClipboardText();
            if (text !== '') {
              addText(text);
              return;
            }
          }
          if (clipboardHasImage) {
            onFailureRef.current('unreadable');
            return;
          }
          if (addText) {
            const present = await hasClipboardUrl();
            if (present) {
              onFailureRef.current('unreadable');
              return;
            }
          }
          onFailureRef.current('empty');
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

  const visible = (options.enabled ?? true) && hasImage;

  return useMemo(() => ({ visible, refresh, paste }), [visible, refresh, paste]);
}
