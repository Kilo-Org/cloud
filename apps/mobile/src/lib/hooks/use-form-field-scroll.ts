import { useRef } from 'react';
import { type LayoutChangeEvent, type ScrollViewInstance } from 'react-native';

/** Space kept above the scroll target, so the field's label is not flush with the edge. */
const FIELD_TOP_MARGIN = 12;

/**
 * Brings a field of a scrolling form into view when a refused Save puts its
 * message there. `fieldLayout` records each field wrapper's offset inside the
 * scroll content (an `onLayout` on the wrapper, whose parent is the content
 * container); `scrollToField` scrolls so that field's label sits at the top.
 *
 * The offset is the wrapper's own top, so the field's own error line — which
 * renders below the input — never moves it. A field that has not laid out yet
 * is left alone.
 */
export function useFormFieldScroll<Field extends string>() {
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const offsets = useRef<Partial<Record<Field, number>>>({});

  const fieldLayout = (field: Field) => (event: LayoutChangeEvent) => {
    offsets.current[field] = event.nativeEvent.layout.y;
  };

  const scrollToField = (field: Field) => {
    const offset = offsets.current[field];
    if (offset === undefined) {
      return;
    }
    scrollRef.current?.scrollTo({ y: Math.max(offset - FIELD_TOP_MARGIN, 0), animated: true });
  };

  return { scrollRef, fieldLayout, scrollToField };
}
