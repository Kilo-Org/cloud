'use client';

import React from 'react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { stepUpRequirementFromError, type StepUpRequirement } from './step-up-error';
import { runWithStepUp } from './step-up-ceremony';
import { StepUpRequestQueue } from './step-up-requests';
import { StepUpDialog } from './StepUpDialog';

type StepUpContextValue = {
  /**
   * Run an operation, and if it refuses with a step-up contract, verify once
   * and retry the same operation. A second refusal is returned to the caller.
   */
  withStepUp: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Open the dialog without a pending operation ("Verify now"). */
  requestStepUp: () => Promise<boolean>;
};

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function useStepUp(): StepUpContextValue {
  const value = useContext(StepUpContext);
  if (!value) throw new Error('useStepUp must be used inside StepUpProvider');
  return value;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [requirement, setRequirement] = useState<StepUpRequirement | null>(null);
  const queue = useRef(new StepUpRequestQueue());

  const requestStepUp = useCallback(
    (nextRequirement: StepUpRequirement = { code: 'MFA_REQUIRED' }) => {
      const pending = queue.current.begin();
      setRequirement(nextRequirement);
      return pending;
    },
    []
  );

  const settle = useCallback((verified: boolean) => {
    setRequirement(null);
    queue.current.settle(verified);
  }, []);

  const onVerified = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.stepUp.getStatus.queryOptions().queryKey,
    });
    settle(true);
  }, [queryClient, settle, trpc]);

  const withStepUp = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      const result = await runWithStepUp(operation, requestStepUp, stepUpRequirementFromError);
      return result;
    },
    [requestStepUp]
  );

  const value = useMemo(
    () => ({
      withStepUp,
      requestStepUp: () => requestStepUp(),
    }),
    [requestStepUp, withStepUp]
  );

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <StepUpDialog
        open={requirement !== null}
        requirement={requirement}
        onVerified={onVerified}
        onCancel={() => settle(false)}
      />
    </StepUpContext.Provider>
  );
}
