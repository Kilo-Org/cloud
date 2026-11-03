'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { registerStepUpHandler } from '@/lib/trpc/step-up-link';
import { type StepUpRequirement } from './step-up-error';
import { StepUpRequestQueue } from './step-up-requests';
import { isStepUpInterstitialVisible } from './step-up-interstitial-state';
import { StepUpDialog } from './StepUpDialog';

/**
 * Owns the single verification dialog for the admin app. The tRPC link asks
 * this provider to verify, then retries the refused operation once.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [requirement, setRequirement] = useState<StepUpRequirement | null>(null);
  const queue = useRef(new StepUpRequestQueue());

  const requestStepUp = useCallback((nextRequirement: StepUpRequirement) => {
    // The full-page interstitial owns the only verification UI while it is
    // showing; do not stack a second dialog over it.
    if (isStepUpInterstitialVisible()) return Promise.resolve(false);
    const started = !queue.current.hasPending();
    const pending = queue.current.begin();
    if (started) setRequirement(nextRequirement);
    return pending;
  }, []);

  const settle = useCallback((verified: boolean) => {
    setRequirement(null);
    queue.current.settle(verified);
  }, []);

  useEffect(() => {
    registerStepUpHandler(next => requestStepUp(next));
    return () => registerStepUpHandler(null);
  }, [requestStepUp]);

  const onVerified = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.stepUp.getStatus.queryOptions().queryKey,
    });
    settle(true);
  }, [queryClient, settle, trpc]);

  return (
    <>
      {children}
      <StepUpDialog
        open={requirement !== null}
        requirement={requirement}
        onVerified={onVerified}
        onCancel={() => settle(false)}
      />
    </>
  );
}
