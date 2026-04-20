'use client';

import { useEffect, useRef } from 'react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  onClose: () => void;
};

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div ref={containerRef} className="z-50">
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
}
