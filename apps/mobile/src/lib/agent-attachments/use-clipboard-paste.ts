import { useCallback, useEffect, useRef } from 'react';

import { i18n } from '@/i18n';
import {
  type ClipboardImageFile,
  hasClipboardImage,
  hasClipboardUrl,
  readClipboardImageFile,
  readClipboardText,
} from './clipboard-image';

export function clipboardPasteEmptyMessage(): string {
  return i18n.t('chat.attachment.nothingToPaste');
}

type UseClipboardPasteOptions = {
  addFile: (file: ClipboardImageFile) => Promise<void>;
  addText?: (text: string) => void;
  onFailure: (reason: 'empty' | 'unreadable' | 'too-large') => void;
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
