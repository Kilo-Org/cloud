import { createContext, type ReactNode, useContext } from 'react';

/**
 * Marks the subtree of a tool-summary row. Reasoning rows render the same
 * `FixedPartRow` chrome but carry a UI label ("Thinking"/"Thought"), so the
 * shared row translates its label only while this scope provides `true`.
 */
const ToolSummaryTranslationContext = createContext(false);

export function ToolSummaryTranslationScope({ children }: { children: ReactNode }) {
  return (
    <ToolSummaryTranslationContext.Provider value>
      {children}
    </ToolSummaryTranslationContext.Provider>
  );
}

/** True when the row renders a tool summary (never a reasoning label). */
export function useIsToolSummaryRow(): boolean {
  return useContext(ToolSummaryTranslationContext);
}
