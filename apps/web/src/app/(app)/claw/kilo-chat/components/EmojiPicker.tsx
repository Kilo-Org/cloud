'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

/** Approximate height of the emoji-mart picker. */
const PICKER_HEIGHT = 435;

type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Element to anchor the picker to. If omitted, renders inline. */
  anchorRef?: React.RefObject<HTMLElement | null>;
};

export function EmojiPicker({ onSelect, onClose, anchorRef }: EmojiPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties | undefined>(undefined);

  useEffect(() => {
    if (!anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const spaceAbove = rect.top;
    const placeAbove = spaceAbove >= PICKER_HEIGHT + 8;

    setStyle({
      position: 'fixed',
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 360)),
      ...(placeAbove
        ? { top: rect.top - 4, transform: 'translateY(-100%)' }
        : { top: rect.bottom + 4 }),
    });
  }, [anchorRef]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const picker = (
    <div ref={containerRef} className="z-[100]" style={style}>
      <Picker
        data={data}
        onEmojiSelect={(emoji: { native: string }) => {
          onSelect(emoji.native);
        }}
        theme="auto"
        previewPosition="none"
        skinTonePosition="none"
        maxFrequentRows={1}
      />
    </div>
  );

  if (anchorRef) {
    return createPortal(picker, document.body);
  }
  return picker;
}
