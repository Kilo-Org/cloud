'use client';

import React from 'react';
import { useSession } from 'next-auth/react';
import { StepUpProvider } from './StepUpProvider';

/**
 * Mounts the global step-up dialog only for an authenticated admin when the
 * switch is on. Non-admins and OFF mode get the children untouched.
 */
export function AdminStepUpRoot({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const { status, data } = useSession();
  if (!enabled || status !== 'authenticated' || data?.isAdmin !== true) {
    return <>{children}</>;
  }
  return <StepUpProvider>{children}</StepUpProvider>;
}
