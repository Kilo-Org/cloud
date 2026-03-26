'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

type QuestionContextValue = {
  questionRequestIds: Map<string, string>;
  cloudAgentSessionId: string | null;
  organizationId: string | null;
  /** When set, QuestionToolCard routes through the session manager instead of tRPC. */
  answerQuestion?: (requestId: string, answers: string[][]) => Promise<void>;
  rejectQuestion?: (requestId: string) => Promise<void>;
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
  answerQuestion,
  rejectQuestion,
  children,
}: QuestionContextProviderProps) {
  const value = useMemo(
    () => ({
      questionRequestIds,
      cloudAgentSessionId,
      organizationId,
      answerQuestion,
      rejectQuestion,
    }),
    [questionRequestIds, cloudAgentSessionId, organizationId, answerQuestion, rejectQuestion]
  );
  return <QuestionContext.Provider value={value}>{children}</QuestionContext.Provider>;
}
