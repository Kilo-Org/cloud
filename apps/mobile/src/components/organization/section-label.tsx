import { type ReactNode } from 'react';

import { Text } from '@/components/ui/text';

/** A card group's heading: the sentence case of the rows under it. */
export function SectionLabel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
      {children}
    </Text>
  );
}
