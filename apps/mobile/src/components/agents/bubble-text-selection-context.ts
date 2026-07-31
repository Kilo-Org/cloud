import { createContext, useContext } from 'react';

/**
 * Inside a message bubble the long-press opens the details sheet; native
 * selection must stay off so the iOS callout cannot float over the sheet
 * (extends the rationale at text-part-renderer.tsx:12-14).
 */
export const InMessageBubbleContext = createContext(false);

/** True when transcript text may use native selection (outside a message bubble). */
export function useTranscriptTextSelectable(): boolean {
  return !useContext(InMessageBubbleContext);
}
