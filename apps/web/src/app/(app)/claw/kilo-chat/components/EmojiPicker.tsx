'use client';

import { lazy, Suspense } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

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

/**
 * The emoji-mart picker panel without any positioning concerns. Render it
 * inside a Popover (see EmojiPicker) or any other anchored surface.
 */
export function EmojiMartPanel({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <Suspense
      fallback={<div className="bg-muted rounded-lg p-8 text-center text-sm">Loading&hellip;</div>}
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
  );
}

type EmojiPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (emoji: string) => void;
  align?: 'start' | 'center' | 'end';
  /** The trigger element (e.g. an add-reaction button). */
  children: React.ReactNode;
};

/**
 * Full emoji picker anchored to its trigger via Radix Popover. Radix supplies
 * collision handling, outside-click dismissal, Escape, and focus management.
 */
export function EmojiPicker({
  open,
  onOpenChange,
  onSelect,
  align = 'start',
  children,
}: EmojiPickerProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-auto border-none bg-transparent p-0 shadow-none">
        <EmojiMartPanel
          onSelect={emoji => {
            onSelect(emoji);
            onOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
