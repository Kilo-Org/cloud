import { type ReactNode } from 'react';
import { View } from 'react-native';

import { SectionHeader } from '@/components/ui/section-header';
import { cn } from '@/lib/utils';

type SectionProps = {
  /** The 10pt mono eyebrow that names the section. */
  label?: string;
  /** Optional glyph before the label, on the label's own line. */
  icon?: ReactNode;
  actionLabel?: string;
  onActionPress?: () => void;
  /**
   * Ends the action in the shared `RowChevron` the destination rows of the same
   * screen carry, for an action that leaves the screen. Opt-in: an in-place
   * action (Home's `SEE ALL` opening a sheet, Credits' `ADD CREDITS`) keeps its
   * text-only look.
   */
  actionChevron?: boolean;
  /** Test handle for the section's action control. */
  actionTestID?: string;
  actionHidden?: boolean;
  /** Keeps the action visible and inert, with the disabled read and state. */
  actionDisabled?: boolean;
  notice?: ReactNode;
  /** The section sits in a full-bleed list, so its label draws the page gutter. */
  inset?: boolean;
  className?: string;
  children: ReactNode;
};

/** A labelled block: the eyebrow header and its content, 10.5pt apart. */
export function Section({
  label,
  icon,
  actionLabel,
  onActionPress,
  actionChevron,
  actionTestID,
  actionHidden,
  actionDisabled,
  notice,
  inset,
  className,
  children,
}: Readonly<SectionProps>) {
  return (
    <View className={cn('gap-3', className)}>
      {label === undefined ? null : (
        <SectionHeader
          label={label}
          icon={icon}
          actionLabel={actionLabel}
          onActionPress={onActionPress}
          actionChevron={actionChevron}
          actionTestID={actionTestID}
          actionHidden={actionHidden}
          actionDisabled={actionDisabled}
          notice={notice}
          inset={inset}
        />
      )}
      {children}
    </View>
  );
}
