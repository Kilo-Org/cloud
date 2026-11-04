import { useCallback, useEffect, useRef } from 'react';

import { i18n } from '@/i18n';
import {
  type ClipboardImageFile,
  hasClipboardImage,
  hasClipboardText,
  hasClipboardUrl,
  readClipboardImageFile,
  readClipboardText,
} from './clipboard-image';

/** Why a paste produced neither an attachment nor text. */
export type ClipboardPasteFailure = 'empty' | 'denied' | 'unreadable' | 'too-large';

/** Toast copy when a paste finds an empty clipboard. */
function clipboardPasteEmptyMessage(): string {
  return i18n.t('chat.attachment.nothingToPaste');
}

/**
 * Toast copy for a paste that found nothing usable, or `null` for the reasons
 * each composer words in its own attachment vocabulary (`'too-large'`,
 * `'unreadable'`).
 *
 * `'denied'` reuses the PR link paste copy: both controls hit the same paste
 * permission, so one already-translated message keeps them consistent.
 */
export function clipboardPasteFailureMessage(reason: ClipboardPasteFailure): string | null {
  if (reason === 'empty') {
    return clipboardPasteEmptyMessage();
  }
  if (reason === 'denied') {
    return i18n.t('prReview.linkPasteDenied');
  }
  return null;
}

type UseClipboardPasteOptions = {
  addFile: (file: ClipboardImageFile) => Promise<void>;
  addText?: (text: string) => void;
  onFailure: (reason: ClipboardPasteFailure) => void;
  maxBytes?: number;
};

export function useClipboardPaste(options: UseClipboardPasteOptions) {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const inFlightRef = useRef(false);

  const paste = useCallback(() => {
    const run = async () => {
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      try {
        const { addFile, addText, onFailure, maxBytes } = optionsRef.current;
        const clipboardHasImage = await hasClipboardImage();
        const file = clipboardHasImage ? await readClipboardImageFile(maxBytes) : null;
        if (file === 'too-large') {
          onFailure('too-large');
          return;
        }
        if (file) {
          await addFile(file);
          return;
        }
        if (addText) {
          const text = await readClipboardText();
          if (text !== '') {
            addText(text);
            return;
          }
          if (await hasClipboardText()) {
            onFailure('denied');
            return;
          }
        }
        if (clipboardHasImage || (addText && (await hasClipboardUrl()))) {
          onFailure('unreadable');
          return;
        }
        onFailure('empty');
      } catch {
        // The upload pipeline owns errors after an attachment is handed off.
      } finally {
        inFlightRef.current = false;
      }
    };
    void run();
  }, []);

  return { paste };
}
