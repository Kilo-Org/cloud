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
