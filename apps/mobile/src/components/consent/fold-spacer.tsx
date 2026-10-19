import { type LayoutChangeEvent, View } from 'react-native';

type FoldSpacerProps = {
  /** The measured height to reserve; values below one dp clamp to one. */
  readonly height: number;
};

/**
 * Blank tail inside a scroll view whose actions are pinned below it.
 *
 * When the scrolled-to-bottom position would park the last text row against
 * the footer's top edge, this spacer carries the tail instead: the row scrolls
 * to a full-height slot above the footer and the tail band the user sees at
 * the end of the scroll is blank rather than a half-covered sentence. The
 * height tracks the pinned footer's measured height from the caller, so the
 * clearance always matches the band that sits below the scroll viewport.
 */
export function FoldSpacer({ height }: FoldSpacerProps) {
  return <View className="bg-background" style={{ height: Math.max(height, 1) }} />;
}

/** The measured layout height of a view, rounded to whole pixels. */
export function measuredHeight(event: LayoutChangeEvent): number {
  return Math.max(Math.round(event.nativeEvent.layout.height), 1);
}

/**
 * A stable layout handler that reports a view's measured height through
 * `setState`. Two callers in one screen need the identical behavior, so the
 * handler identity stays shared instead of a fresh closure per render.
 */
export function heightReporter(set: (height: number) => void) {
  return (event: LayoutChangeEvent) => {
    set(measuredHeight(event));
  };
}
