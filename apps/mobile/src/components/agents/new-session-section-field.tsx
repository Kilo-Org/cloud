import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

type NewSessionSectionFieldProps = {
  /** The section's name, above the control or beside it. */
  label: string;
  /**
   * Lays the label and the control out on one row instead of stacking them.
   * A row costs its heading no height, which is what keeps the repository
   * picker on the first screenful of a short window (see
   * `resolveNewSessionInlineSections`).
   */
  inline: boolean;
  children: ReactNode;
};

/**
 * One labelled field of the New Session form: the form's label-value relation
 * keeps one shape while the headings stack above full-width controls, and the
 * sections that sit above the repository picker merge theirs into the row on a
 * short window so the picker itself stays above the pinned Start footer.
 *
 * The label never takes the row: it is capped at 45% of it, so a long localized
 * name or a large font scale wraps the heading instead of squeezing the control
 * it names, and the 240 dp width gate keeps the row off windows where even a
 * capped heading would leave no word of room.
 */
export function NewSessionSectionField({
  label,
  inline,
  children,
}: Readonly<NewSessionSectionFieldProps>) {
  if (!inline) {
    return (
      <View className="mt-5">
        <Text className="mb-2 text-sm font-medium text-muted-foreground">{label}</Text>
        {children}
      </View>
    );
  }
  return (
    <View className="mt-5 flex-row items-center gap-2">
      {/* The heading may not take the row: a long localized label (or a large
          font scale) would leave the control it names no room for a word. Above
          240 dp the form only takes this row, so the cap is the label's share. */}
      <Text className="max-w-[45%] text-sm font-medium text-muted-foreground">{label}</Text>
      <View className="flex-1">{children}</View>
    </View>
  );
}
