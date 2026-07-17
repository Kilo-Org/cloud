import { Info } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { SheetHeader } from '@/components/sheet-header';

export function PickerSheet({
  title,
  onDone,
  onCancel,
  doneLabel,
  children,
  expired = false,
  scrollable = true,
}: {
  title: string;
  onDone: () => void;
  onCancel?: () => void;
  doneLabel?: string;
  children?: ReactNode;
  /** Set when the caller's data source (picker bridge) is gone — renders the standard "Options expired" empty state instead of children. */
  expired?: boolean;
  /**
   * Set to false when children manage their own scrolling (e.g. a FlatList
   * with search-as-you-type rows) — the shell then just renders them below
   * the header instead of nesting them in a ScrollView.
   */
  scrollable?: boolean;
}) {
  const { bottom } = useSafeAreaInsets();
  const body = expired ? (
    <EmptyState
      icon={Info}
      title="Options expired"
      description="Go back and reopen this picker from the previous screen."
    />
  ) : (
    children
  );

  // No wrapping View: react-native-screens sizes a formSheet's scroll view
  // natively and only honors a header when [header, scroll view] are the
  // screen content's direct children. An extra wrapper makes it fall back to
  // pinning the scroll view to the full sheet, painting it over the header.
  return (
    <>
      <SheetHeader title={title} onDone={onDone} onCancel={onCancel} doneLabel={doneLabel} />
      {scrollable ? (
        <ScrollView contentContainerStyle={{ paddingBottom: bottom + 16 }}>{body}</ScrollView>
      ) : (
        body
      )}
    </>
  );
}
