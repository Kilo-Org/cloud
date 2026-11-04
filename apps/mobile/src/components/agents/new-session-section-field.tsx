import { type ReactNode } from 'react';
import { View } from 'react-native';

import { NEW_SESSION_SECTION_LABEL_WIDTH_RATIO } from '@/components/agents/new-session-section-layout';
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
 * The label never takes the row: its share is capped by the same ratio the
 * layout rule measures, so a long localized name or a large font scale wraps
 * the heading instead of squeezing the control it names.
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
      <Text
        className="text-sm font-medium text-muted-foreground"
        style={{ maxWidth: `${NEW_SESSION_SECTION_LABEL_WIDTH_RATIO * 100}%` }}
      >
        {label}
      </Text>
      <View className="flex-1">{children}</View>
    </View>
  );
}
