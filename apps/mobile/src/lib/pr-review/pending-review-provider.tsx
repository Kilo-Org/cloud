import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

// Minimal item shape — S7a owns the final pending-comment fields. Keeping
// the type intentionally loose lets the provider land in S4b without
// baking in fields that the comment composer hasn't decided on yet.
export type PendingReviewItem = {
  id: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
  body: string;
};

type PendingReviewContextValue = {
  items: PendingReviewItem[];
  addComment: (item: PendingReviewItem) => void;
  removeComment: (id: string) => void;
  clear: () => void;
};

const PendingReviewContext = createContext<PendingReviewContextValue | undefined>(undefined);

export function PendingReviewProvider({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<PendingReviewItem[]>([]);

  const addComment = useCallback((item: PendingReviewItem) => {
    setItems(previous => [...previous, item]);
  }, []);

  const removeComment = useCallback((id: string) => {
    setItems(previous => previous.filter(item => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
  }, []);

  const value = useMemo<PendingReviewContextValue>(
    () => ({ items, addComment, removeComment, clear }),
    [items, addComment, removeComment, clear]
  );

  return <PendingReviewContext value={value}>{children}</PendingReviewContext>;
}

export function usePendingReview(): PendingReviewContextValue {
  const context = useContext(PendingReviewContext);
  if (!context) {
    throw new Error('usePendingReview must be used within a PendingReviewProvider');
  }
  return context;
}
