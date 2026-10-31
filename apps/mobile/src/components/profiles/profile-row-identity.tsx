import { type ReactNode } from 'react';
import { View } from 'react-native';

import { ROW_IDENTITY_CLASS } from '@/lib/a11y/tap-target';

/**
 * One profile list row's identity — the item's name and what qualifies it —
 * announced as a single element before the row's controls.
 *
 * The row declares this block first and it spans the row's control height
 * ({@link ROW_IDENTITY_CLASS}), so the platform's layout-derived focus order
 * reaches the identity before the switch, edit and delete controls beside it.
 * The visible copy stays for sighted reading but is hidden from assistive
 * technology, which reads `label` instead; the caller composes that label from
 * the copy it renders, in reading order.
 */
export function ProfileRowIdentity({
  label,
  children,
}: Readonly<{ label: string; children?: ReactNode }>) {
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={label} className={ROW_IDENTITY_CLASS}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-0.5"
      >
        {children}
      </View>
    </View>
  );
}

/**
 * The label of a {@link ProfileRowIdentity} row: the parts that name the item,
 * in reading order, without the empty ones a row may omit.
 */
export function profileRowLabel(...parts: (string | null | undefined)[]): string {
  return parts
    .map(part => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(', ');
}
