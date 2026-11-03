'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { registerStepUpHandler } from '@/lib/trpc/step-up-link';
import { type StepUpRequirement } from './step-up-error';
import { StepUpRequestQueue } from './step-up-requests';
import { isStepUpInterstitialVisible } from './step-up-interstitial-state';
import { StepUpDialog } from './StepUpDialog';

const StepUpActiveContext = createContext(false);

/** True only for an authenticated admin while the switch is ON. */
export function useStepUpActive(): boolean {
  return useContext(StepUpActiveContext);
}

/**
 * Owns the single verification dialog for the app. The element tree is stable
 * whether or not step-up is active, so a session load never remounts the app.
 */
export function StepUpProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [requirement, setRequirement] = useState<StepUpRequirement | null>(null);
  const queue = useRef(new StepUpRequestQueue());

  const requestStepUp = useCallback(
    (nextRequirement: StepUpRequirement) => {
      if (!active) return Promise.resolve(false);
      if (isStepUpInterstitialVisible()) return Promise.resolve(false);
      const started = !queue.current.hasPending();
      const pending = queue.current.begin();
      if (started) setRequirement(nextRequirement);
      return pending;
    },
    [active]
  );

  const settle = useCallback((verified: boolean) => {
    setRequirement(null);
    queue.current.settle(verified);
  }, []);

  useEffect(() => {
    if (!active) {
      // Settle anything waiting so a refused operation errors instead of
      // hanging, and drop the abandoned requirement before re-activation.
      setRequirement(null);
      queue.current.settle(false);
      return;
    }
    registerStepUpHandler(next => requestStepUp(next));
    return () => registerStepUpHandler(null);
  }, [active, requestStepUp]);

  useEffect(
    () => () => {
      queue.current.settle(false);
    },
    []
  );

  const onVerified = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.stepUp.getStatus.queryOptions().queryKey,
    });
    settle(true);
  }, [queryClient, settle, trpc]);

  return (
    <StepUpActiveContext.Provider value={active}>
      {children}
      {active ? (
        <StepUpDialog
          open={requirement !== null}
          requirement={requirement}
          onVerified={onVerified}
          onCancel={() => settle(false)}
        />
      ) : null}
    </StepUpActiveContext.Provider>
  );
}
