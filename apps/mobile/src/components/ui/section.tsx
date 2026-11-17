import { type ReactNode } from 'react';
import { View } from 'react-native';

import { SectionHeader } from '@/components/ui/section-header';
import { cn } from '@/lib/utils';

type SectionProps = {
  /** The 10pt mono eyebrow that names the section. */
  label?: string;
  actionLabel?: string;
  onActionPress?: () => void;
  actionHidden?: boolean;
  notice?: ReactNode;
  reserveLabelAir?: boolean;
  /** The section sits in a full-bleed list, so its label draws the page gutter. */
  inset?: boolean;
  className?: string;
  children: ReactNode;
};

/** A labelled block: the eyebrow header and its content, 10.5pt apart. */
export function Section({
  label,
  actionLabel,
  onActionPress,
  actionHidden,
  notice,
  reserveLabelAir,
  inset,
  className,
  children,
}: Readonly<SectionProps>) {
  return (
    <View className={cn('gap-3', className)}>
      {label === undefined ? null : (
        <SectionHeader
          label={label}
          actionLabel={actionLabel}
          onActionPress={onActionPress}
          actionHidden={actionHidden}
          notice={notice}
          reserveLabelAir={reserveLabelAir}
          inset={inset}
        />
      )}
      {children}
    </View>
  );
}
