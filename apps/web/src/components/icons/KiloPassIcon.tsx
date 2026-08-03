import { Crown } from 'lucide-react';
// React must be in scope for the classic JSX runtime used by the jest transform.
import React from 'react';
import type { ComponentProps } from 'react';

export function KiloPassIcon(props: ComponentProps<typeof Crown>) {
  return <Crown {...props} />;
}
