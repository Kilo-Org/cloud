import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

// One queued inline comment in the pending review. The composer fills
// this in when the user taps "Add to review"; the submit sheet drains
// the whole list into one `submitReview` batch call.
//
// `commitSha` records the PR head SHA at the time the comment was
// queued so the submit sheet can flag "may be outdated" if the head
// moves between queue and submit. Submission itself always uses the
// LATEST head SHA (per the S3 contract) — a per-item 422 surfaces
// inline so the user can decide whether to retry or drop the comment.
export type PendingReviewItem = {
  id: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
  body: string;
  commitSha: string;
};

type PendingReviewContextValue = {
  items: PendingReviewItem[];
  addComment: (item: PendingReviewItem) => void;
  updateComment: (id: string, body: string) => void;
  removeComment: (id: string) => void;
  clear: () => void;
};

const PendingReviewContext = createContext<PendingReviewContextValue | undefined>(undefined);

export function PendingReviewProvider({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<PendingReviewItem[]>([]);

  const addComment = useCallback((item: PendingReviewItem) => {
    setItems(previous => [...previous, item]);
  }, []);

  const updateComment = useCallback((id: string, body: string) => {
    setItems(previous => previous.map(item => (item.id === id ? { ...item, body } : item)));
  }, []);

  const removeComment = useCallback((id: string) => {
    setItems(previous => previous.filter(item => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
  }, []);

  const value = useMemo<PendingReviewContextValue>(
    () => ({ items, addComment, updateComment, removeComment, clear }),
    [items, addComment, updateComment, removeComment, clear]
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
