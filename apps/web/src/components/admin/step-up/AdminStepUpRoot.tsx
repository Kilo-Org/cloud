'use client';

import React from 'react';
import { useSession } from 'next-auth/react';
import { StepUpProvider } from './StepUpProvider';

/**
 * Mounts the step-up provider with a stable element tree. `active` is true only
 * for an authenticated admin when the server says the switch is on; otherwise
 * the provider registers no handler and renders no dialog or query.
 */
export function AdminStepUpRoot({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const { status, data } = useSession();
  const active = enabled && status === 'authenticated' && data?.isAdmin === true;
  return <StepUpProvider active={active}>{children}</StepUpProvider>;
}
