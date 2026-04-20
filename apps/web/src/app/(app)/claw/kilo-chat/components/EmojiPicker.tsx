'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Element to anchor the picker above. If omitted, renders inline. */
  anchorRef?: React.RefObject<HTMLElement | null>;
};

export function EmojiPicker({ onSelect, onClose, anchorRef }: EmojiPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top - 4, // 4px gap above anchor
        left: Math.max(8, rect.left - 170), // center-ish, keep on screen
      });
    }
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
    <div
      ref={containerRef}
      className="z-[100]"
      style={
        position
          ? {
              position: 'fixed',
              top: 0,
              left: position.left,
              transform: `translateY(${position.top}px) translateY(-100%)`,
            }
          : undefined
      }
    >
      <Picker
        data={data}
        onEmojiSelect={(emoji: { native: string }) => {
          onSelect(emoji.native);
        }}
        theme="dark"
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
