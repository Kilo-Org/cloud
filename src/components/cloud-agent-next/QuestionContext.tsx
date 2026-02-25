'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

type QuestionContextValue = {
  questionRequestIds: Map<string, string>;
  cloudAgentSessionId: string | null;
  organizationId: string | null;
};

const QuestionContext = createContext<QuestionContextValue>({
  questionRequestIds: new Map(),
  cloudAgentSessionId: null,
  organizationId: null,
});

export function useQuestionContext(): QuestionContextValue {
  return useContext(QuestionContext);
}

type QuestionContextProviderProps = QuestionContextValue & {
  children: ReactNode;
};

export function QuestionContextProvider({
  questionRequestIds,
  cloudAgentSessionId,
  organizationId,
  children,
}: QuestionContextProviderProps) {
  const value = useMemo(
    () => ({ questionRequestIds, cloudAgentSessionId, organizationId }),
    [questionRequestIds, cloudAgentSessionId, organizationId]
  );
  return <QuestionContext.Provider value={value}>{children}</QuestionContext.Provider>;
}
