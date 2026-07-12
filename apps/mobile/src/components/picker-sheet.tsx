import { type ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';

export function PickerSheet({
  title,
  onDone,
  children,
  fallback,
  scrollable = true,
}: {
  title: string;
  onDone: () => void;
  children?: ReactNode;
  /** Rendered instead of children when the caller's data source is gone. */
  fallback?: ReactNode;
  /**
   * Set to false when children manage their own scrolling (e.g. a FlatList
   * with search-as-you-type rows) — the shell then just renders them below
   * the header instead of nesting them in a ScrollView.
   */
  scrollable?: boolean;
}) {
  const { bottom } = useSafeAreaInsets();
  const body = fallback ?? children;

  // No wrapping View: react-native-screens sizes a formSheet's scroll view
  // natively and only honors a header when [header, scroll view] are the
  // screen content's direct children. An extra wrapper makes it fall back to
  // pinning the scroll view to the full sheet, painting it over the header.
  return (
    <>
      <SheetHeader title={title} onDone={onDone} />
      {scrollable ? (
        <ScrollView contentContainerStyle={{ paddingBottom: bottom + 16 }}>{body}</ScrollView>
      ) : (
        body
      )}
    </>
  );
}
