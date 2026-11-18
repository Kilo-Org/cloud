import { createContext, type ReactNode, useContext } from 'react';

/**
 * Carries the persistent id of the tool part whose subtree this is. Reasoning
 * rows render the same `FixedPartRow` chrome but carry a UI label
 * ("Thinking"/"Thought"), so they sit outside this scope and read `null`; the
 * shared row translates its label only while an id is provided.
 */
const ToolSummaryTranslationContext = createContext<string | null>(null);

export function ToolSummaryTranslationScope({
  itemId,
  children,
}: {
  itemId: string;
  children: ReactNode;
}) {
  return (
    <ToolSummaryTranslationContext.Provider value={itemId}>
      {children}
    </ToolSummaryTranslationContext.Provider>
  );
}

/** The persistent id of the tool part, or null outside a tool-summary scope. */
export function useToolSummaryItemId(): string | null {
  return useContext(ToolSummaryTranslationContext);
}
