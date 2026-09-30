import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';

import { useTextHeight } from '@/components/agents/use-text-height';

/**
 * Imperative surface the composer drives without rendering itself. A keystroke
 * pushes its text through `setText`, which re-renders only this leaf; nothing
 * about the 1400-line `ChatComposer` commits on a typed frame whose rendered
 * values did not change.
 */
export type ChatComposerMeasureHandle = {
  setText: (text: string) => void;
  reset: () => void;
};

type ChatComposerMeasureProps = {
  minHeight: number;
  maxHeight: number;
  verticalPadding: number;
  textContentWidth: number;
  fontSize: number;
  lineHeight: number;
  fontScale?: number;
  nativeContentHeight?: number | null;
  /**
   * Published only when the measured height or the snapped cap changes. The
   * composer renders both (the input's height, the row's scroll gate), so a
   * keystroke that neither adds nor removes a line must not cross back here.
   */
  onMeasureChange: (height: number, maxHeight: number) => void;
  handleRef: Ref<ChatComposerMeasureHandle>;
};

/**
 * Hidden mirror and height measurement leaf for the Cloud Agent composer.
 *
 * `useTextHeight` keeps the mirror text and the measured content height in
 * React state. Calling that hook from `ChatComposer` put both on the composer's
 * own render path, so every typed frame re-rendered the whole composer and
 * re-laid-out the mirror. Owning the hook here confines the per-keystroke work
 * to this leaf; the composer learns only the published height/cap, and only
 * when one of them changes (at most once per rendered line).
 */
export function ChatComposerMeasure({
  handleRef,
  onMeasureChange,
  ...options
}: Readonly<ChatComposerMeasureProps>) {
  const measure = useTextHeight(options);
  const lastPublishedRef = useRef<{ height: number; maxHeight: number } | null>(null);

  useImperativeHandle(
    handleRef,
    () => ({
      setText: (text: string) => {
        measure.setText(text);
      },
      reset: () => {
        measure.reset();
      },
    }),
    [measure]
  );

  useEffect(() => {
    const lastPublished = lastPublishedRef.current;
    if (
      lastPublished !== null &&
      lastPublished.height === measure.height &&
      lastPublished.maxHeight === measure.maxHeight
    ) {
      return;
    }
    lastPublishedRef.current = { height: measure.height, maxHeight: measure.maxHeight };
    onMeasureChange(measure.height, measure.maxHeight);
  }, [measure.height, measure.maxHeight, onMeasureChange]);

  return measure.measureElement;
}
