import { type LayoutChangeEvent, View } from 'react-native';

type FoldSpacerProps = {
  /** The measured height to reserve; values below one dp clamp to one. */
  readonly height: number;
  readonly onMeasure: (event: LayoutChangeEvent) => void;
};

/**
 * Blank tail inside a scroll view whose actions are pinned below it.
 *
 * When the content is taller than the viewport, the fold lands in this spacer
 * instead of inside a text row: a half-rendered sentence at the fold reads as
 * broken text with nothing inviting a scroll. Measured height should track
 * the pinned footer, so the last row can always rise above it.
 */
export function FoldSpacer({ height, onMeasure }: FoldSpacerProps) {
  return (
    <View className="bg-background" onLayout={onMeasure} style={{ height: Math.max(height, 1) }} />
  );
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
