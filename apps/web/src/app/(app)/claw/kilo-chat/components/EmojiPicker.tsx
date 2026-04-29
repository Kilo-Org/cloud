'use client';

import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';

const LazyPicker = lazy(async () => {
  const [{ default: data }, { default: Picker }] = await Promise.all([
    import('@emoji-mart/data'),
    import('@emoji-mart/react'),
  ]);
  // Wrap Picker in a component that pre-binds the data prop so the lazy
  // boundary only needs to resolve once.
  return {
    default: (props: Record<string, unknown>) => <Picker data={data} {...props} />,
  };
});

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
      <Suspense
        fallback={<div className="bg-muted rounded-lg p-8 text-center text-sm">Loading...</div>}
      >
        <LazyPicker
          onEmojiSelect={(emoji: { native: string }) => {
            onSelect(emoji.native);
          }}
          // Intentionally hardcoded to "dark" — the chat UI is dark-themed and
          // "auto" causes a jarring white picker when the OS is in light mode.
          theme="dark"
          previewPosition="none"
          skinTonePosition="none"
          maxFrequentRows={1}
        />
      </Suspense>
    </div>
  );

  if (anchorRef) {
    return createPortal(picker, document.body);
  }
  return picker;
}
